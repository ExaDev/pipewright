import { UnsupportedFeatureError } from "./errors.ts";
import type {
  CommandExecution,
  CommandExecutor,
  LogEntry,
  PipelineRunner,
  RunContext,
  RunOutput,
  StepCommandFiles,
  StepFileContents,
  StepScratch,
  StepSummary,
} from "./runner.ts";
import { describeStepHostConformance } from "./runner-host-conformance.ts";
import { pipelineSchema, type Pipeline } from "./schema.ts";
import { samplePipeline, type TestApi } from "./conformance.ts";

export const CONTEXT: RunContext = {
  event: "push",
  refName: "main",
  baseRefName: "",
  sha: "abc123",
  repository: "example/repo",
  workflow: "CI",
  runId: "1",
};

/** The environment variable that carries each command file, as the command sees it; the runner must pass exactly these. */
const FILE_VARIABLES: Readonly<Record<keyof StepFileContents, string>> = {
  output: "GITHUB_OUTPUT",
  env: "GITHUB_ENV",
  path: "GITHUB_PATH",
  summary: "GITHUB_STEP_SUMMARY",
};

export interface RecordingExecutor extends CommandExecutor {
  readonly executed: CommandExecution[];
}

/** What the kit's scripted executor answers one step with: the stdout it produced, and what it wrote to the command files its environment names. */
export interface StepScript {
  readonly stdout: string;
  /** What the scripted command writes to stderr, so a case can cover its masking. */
  readonly stderr?: string;
  readonly writes: Readonly<Partial<StepFileContents>>;
}

interface ExecutorBehaviour {
  /** Names the commands that fail, by the text of the command. */
  readonly failing?: (command: string) => boolean;
  /** What each executed command leaves behind, by the execution the runner passed it. */
  readonly script?: (execution: CommandExecution) => StepScript;
}

export function recordingExecutor(
  scratch: MemoryScratch,
  behaviour: ExecutorBehaviour = {},
): RecordingExecutor {
  const executed: CommandExecution[] = [];
  const failing = behaviour.failing ?? (() => false);
  const script = behaviour.script ?? ((): StepScript => ({ stdout: "", writes: {} }));

  return {
    executed,
    async execute(execution) {
      executed.push(execution);
      const answer = script(execution);
      for (const file of ["output", "env", "path", "summary"] as const) {
        const content = answer.writes[file];
        if (content === undefined) continue;
        const path = execution.env[FILE_VARIABLES[file]];
        if (path === undefined) throw new Error(`the runner did not pass ${FILE_VARIABLES[file]}`);
        scratch.written.set(path, content);
      }

      return Promise.resolve({
        exitCode: failing(execution.command) ? 1 : 0,
        stdout: answer.stdout,
        stderr: answer.stderr ?? "",
      });
    },
  };
}

export interface MemoryScratch extends StepScratch {
  /** The scratch's store, keyed by path, so the scripted executor can stand in for the command that writes its files. */
  readonly written: Map<string, string>;
}

export function memoryScratch(): MemoryScratch {
  const written = new Map<string, string>();
  let stepCount = 0;

  return {
    written,
    async create(): Promise<StepCommandFiles> {
      const files: StepCommandFiles = {
        output: `scratch/${String(stepCount)}/output`,
        env: `scratch/${String(stepCount)}/env`,
        path: `scratch/${String(stepCount)}/path`,
        summary: `scratch/${String(stepCount)}/summary`,
      };
      stepCount += 1;
      for (const path of [files.output, files.env, files.path, files.summary]) {
        written.set(path, "");
      }

      return Promise.resolve(files);
    },
    async read(files): Promise<StepFileContents> {
      const content = (path: string): string => {
        const value = written.get(path);
        if (value === undefined) throw new Error(`no scratch file at ${path}`);

        return value;
      };

      return Promise.resolve({
        output: content(files.output),
        env: content(files.env),
        path: content(files.path),
        summary: content(files.summary),
      });
    },
    async release(files): Promise<void> {
      for (const path of [files.output, files.env, files.path, files.summary]) {
        written.delete(path);
      }

      return Promise.resolve();
    },
    async dispose(): Promise<void> {
      written.clear();

      return Promise.resolve();
    },
  };
}

export interface RecordingOutput extends RunOutput {
  readonly entries: LogEntry[];
  readonly summaries: StepSummary[];
}

export function recordingOutput(): RecordingOutput {
  const entries: LogEntry[] = [];
  const summaries: StepSummary[] = [];

  return {
    entries,
    summaries,
    log(entry) {
      entries.push(entry);
    },
    summary(summary) {
      summaries.push(summary);
    },
  };
}

/** The ports a run needs besides its executor, fresh for each case so no state leaks between them. */
export function ports(): { scratch: MemoryScratch; output: RecordingOutput } {
  return { scratch: memoryScratch(), output: recordingOutput() };
}

export function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

/**
 * Registers the behavioural spec every `PipelineRunner` must meet, driven through a recording executor so no process is spawned.
 */
export function describeRunnerConformance(api: TestApi, makeRunner: () => PipelineRunner): void {
  describeStepHostConformance(api, makeRunner);
  api.describe("PipelineRunner conformance", () => {
    api.it("runs jobs in needs order", async () => {
      const { scratch, output } = ports();
      const executor = recordingExecutor(scratch);
      const report = await makeRunner().run(samplePipeline(), {
        executor,
        scratch,
        output,
        context: CONTEXT,
      });
      const commands = executor.executed.map((entry) => entry.command);
      check(report.ok, "a clean run was reported as failed");
      check(
        commands.indexOf("pnpm run lint") < commands.indexOf("pnpm test") &&
          commands.indexOf("pnpm test") < commands.indexOf("echo gate"),
        `jobs ran out of order: ${commands.join(", ")}`,
      );
    });

    api.it("runs a job once per matrix combination with the axis value in scope", async () => {
      const { scratch, output } = ports();
      const executor = recordingExecutor(scratch);
      await makeRunner().run(samplePipeline(), { executor, scratch, output, context: CONTEXT });
      const versions = executor.executed
        .filter((entry) => entry.command === "pnpm test")
        .map((entry) => entry.env.NODE_VERSION);
      check(
        versions.length === 2 && versions.includes("22") && versions.includes("24"),
        `matrix values were ${JSON.stringify(versions)}`,
      );
    });

    api.it("resolves context tokens in step environments", async () => {
      const { scratch, output } = ports();
      const executor = recordingExecutor(scratch);
      await makeRunner().run(samplePipeline(), { executor, scratch, output, context: CONTEXT });
      const test = executor.executed.find((entry) => entry.command === "pnpm test");
      check(test?.env.SHA === "abc123", "the sha token was not resolved");
    });

    api.it("skips dependants of a failed job but still runs an always job", async () => {
      const pipeline = samplePipeline();
      const gate = pipeline.jobs.gate;
      if (gate === undefined) throw new Error("sample pipeline lost its gate job");
      gate.needsPolicy = "always";
      const { scratch, output } = ports();
      const executor = recordingExecutor(scratch, {
        failing: (command) => command === "pnpm run lint",
      });
      const report = await makeRunner().run(pipeline, {
        executor,
        scratch,
        output,
        context: CONTEXT,
      });
      const commands = executor.executed.map((entry) => entry.command);
      check(!report.ok, "a failing run was reported as ok");
      check(!commands.includes("pnpm test"), "a dependant of a failed job ran");
      check(commands.includes("echo gate"), "the always job did not run");
    });

    api.it("skips a job whose condition does not hold", async () => {
      const pipeline = pipelineSchema.parse({
        name: "CI",
        triggers: [{ kind: "push" }],
        jobs: {
          release: {
            name: "Release",
            runsOn: ["ubuntu-latest"],
            when: {
              kind: "textCompare",
              op: "equals",
              left: { kind: "reference", key: "refName" },
              right: { kind: "textLiteral", value: "release" },
            },
            steps: [{ kind: "run", run: "echo release" }],
          },
        },
      });
      const { scratch, output } = ports();
      const executor = recordingExecutor(scratch);
      const report = await makeRunner().run(pipeline, {
        executor,
        scratch,
        output,
        context: CONTEXT,
      });
      check(executor.executed.length === 0, "a job whose condition is false ran");
      check(report.jobs[0]?.outcome === "skipped", "the job was not reported as skipped");
    });

    api.it("rejects a provider step", async () => {
      const pipeline = samplePipeline();
      pipeline.jobs.lint?.steps.push({
        kind: "provider",
        provider: "github-actions",
        native: { uses: "example/action@v1" },
      });
      const { scratch, output } = ports();
      let thrown: unknown;
      try {
        await makeRunner().run(pipeline, {
          executor: recordingExecutor(scratch),
          scratch,
          output,
          context: CONTEXT,
        });
      } catch (error) {
        thrown = error;
      }
      check(thrown instanceof UnsupportedFeatureError, "a provider step was accepted");
    });

    api.it("runs only the matrix combination it is given", async () => {
      const { scratch, output } = ports();
      const executor = recordingExecutor(scratch);
      await makeRunner().run(samplePipeline(), {
        executor,
        scratch,
        output,
        context: CONTEXT,
        only: ["test"],
        matrix: { node: "24" },
      });
      const versions = executor.executed.map((entry) => entry.env.NODE_VERSION);
      check(
        versions.length === 1 && versions[0] === "24",
        `ran matrix values ${JSON.stringify(versions)}`,
      );
    });

    api.it("runs only the steps in the given range", async () => {
      const pipeline = pipelineSchema.parse({
        name: "CI",
        triggers: [{ kind: "push" }],
        jobs: {
          build: {
            name: "Build",
            runsOn: ["ubuntu-latest"],
            steps: [
              { kind: "run", run: "echo one" },
              { kind: "run", run: "echo two" },
              { kind: "run", run: "echo three" },
            ],
          },
        },
      });
      const { scratch, output } = ports();
      const executor = recordingExecutor(scratch);
      await makeRunner().run(pipeline, {
        executor,
        scratch,
        output,
        context: CONTEXT,
        only: ["build"],
        steps: { from: 1, to: 1 },
      });
      const commands = executor.executed.map((entry) => entry.command);
      check(
        commands.length === 1 && commands[0] === "echo two",
        `ran ${commands.join(", ")} instead of only step 1`,
      );
    });

    api.it("reports provider steps as skipped when told to, and still runs the rest", async () => {
      const pipeline = samplePipeline();
      pipeline.jobs.lint?.steps.unshift({
        kind: "provider",
        provider: "github-actions",
        native: { uses: "example/action@v1" },
      });
      const { scratch, output } = ports();
      const executor = recordingExecutor(scratch);
      const report = await makeRunner().run(pipeline, {
        executor,
        scratch,
        output,
        context: CONTEXT,
        skipProviderSteps: true,
      });
      const lint = report.jobs.find((job) => job.id === "lint");
      check(lint?.steps[0]?.outcome === "skipped", "the provider step was not reported as skipped");
      check(
        executor.executed.some((entry) => entry.command === "pnpm run lint"),
        "the portable step did not run",
      );
    });

    api.it("reports a gate as failed, without running it, when a job it needs failed", async () => {
      const { scratch, output } = ports();
      const executor = recordingExecutor(scratch, {
        failing: (command) => command === "pnpm run lint",
      });
      const report = await makeRunner().run(samplePipeline(), {
        executor,
        scratch,
        output,
        context: CONTEXT,
      });
      const reported = report.jobs.find((job) => job.id === "gate");
      check(
        reported?.outcome === "failure",
        `the gate was reported as ${String(reported?.outcome)}`,
      );
      check(
        !executor.executed.some((entry) => entry.command === "echo gate"),
        "a failed gate ran its steps",
      );
    });

    api.it("does not read a blocked job's condition when a dependency failed", async () => {
      const pipeline = pipelineSchema.parse({
        name: "CI",
        triggers: [{ kind: "push" }],
        jobs: {
          first: {
            name: "First",
            runsOn: ["x"],
            steps: [{ kind: "run", run: "fail" }],
          },
          second: {
            name: "Second",
            runsOn: ["x"],
            needs: ["first"],
            when: {
              kind: "textCompare",
              op: "equals",
              left: { kind: "reference", key: "refName" },
              right: { kind: "textLiteral", value: "main" },
            },
            steps: [{ kind: "run", run: "second" }],
          },
        },
      });
      const { scratch, output } = ports();
      const executor = recordingExecutor(scratch, { failing: (command) => command === "fail" });
      const report = await makeRunner().run(pipeline, { executor, scratch, output, context: {} });
      const second = report.jobs.find((job) => job.id === "second");
      check(second?.outcome === "skipped", "the blocked job was not reported as skipped");
    });

    api.it("skips a gate whose own condition is false rather than failing it", async () => {
      const pipeline = samplePipeline();
      const gate = pipeline.jobs.gate;
      if (gate === undefined) throw new Error("sample pipeline lost its gate job");
      gate.when = {
        kind: "textCompare",
        op: "equals",
        left: { kind: "reference", key: "refName" },
        right: { kind: "textLiteral", value: "release" },
      };
      const { scratch, output } = ports();
      const executor = recordingExecutor(scratch, {
        failing: (command) => command === "pnpm run lint",
      });
      const report = await makeRunner().run(pipeline, {
        executor,
        scratch,
        output,
        context: CONTEXT,
      });
      const reported = report.jobs.find((job) => job.id === "gate");
      check(reported?.outcome === "skipped", `the gate was ${String(reported?.outcome)}`);
    });

    api.it("runs only the named jobs when asked", async () => {
      const { scratch, output } = ports();
      const executor = recordingExecutor(scratch);
      await makeRunner().run(samplePipeline(), {
        executor,
        scratch,
        output,
        context: CONTEXT,
        only: ["test"],
      });
      const commands = new Set(executor.executed.map((entry) => entry.command));
      check(
        commands.size === 1 && commands.has("pnpm test"),
        `ran ${[...commands].join(", ")} instead of only the named job`,
      );
    });
  });

  api.describe("PipelineRunner file commands", () => {
    /** A two-step job, the smallest pipeline over which one step can hand something to a later one. */
    const twoStepPipeline = (): Pipeline =>
      pipelineSchema.parse({
        name: "CI",
        triggers: [{ kind: "push" }],
        jobs: {
          build: {
            name: "Build",
            runsOn: ["x"],
            steps: [
              { kind: "run", run: "first" },
              { kind: "run", run: "second" },
            ],
          },
        },
      });

    api.it("passes fresh command files to each step and reads what the step wrote", async () => {
      const { scratch, output } = ports();
      const executor = recordingExecutor(scratch, {
        script: () => ({
          stdout: "",
          writes: { env: "HANDED=over\n" },
        }),
      });
      await makeRunner().run(twoStepPipeline(), { executor, scratch, output, context: {} });
      const [first, second] = executor.executed;
      check(first?.env.GITHUB_OUTPUT !== second?.env.GITHUB_OUTPUT, "steps shared an output file");
      check(first?.env.GITHUB_ENV !== undefined, "the environment file was not passed");
      check(first?.env.GITHUB_PATH !== undefined, "the path file was not passed");
      check(first?.env.GITHUB_STEP_SUMMARY !== undefined, "the summary file was not passed");
      check(second?.env.HANDED === "over", "a later step did not receive the written entry");
    });

    api.it("records a step's outputs in its report, heredocs included", async () => {
      const { scratch, output } = ports();
      const executor = recordingExecutor(scratch, {
        script: (execution) => ({
          stdout: "",
          writes:
            execution.command === "first"
              ? { output: "plain=1\nmulti<<EOF\nline one\nline two\nEOF\n" }
              : {},
        }),
      });
      const report = await makeRunner().run(twoStepPipeline(), {
        executor,
        scratch,
        output,
        context: {},
      });
      const first = report.jobs[0]?.steps[0];
      check(first?.outputs.plain === "1", `plain output was ${JSON.stringify(first?.outputs)}`);
      check(
        first?.outputs.multi === "line one\nline two",
        `heredoc output was ${JSON.stringify(first?.outputs.multi)}`,
      );
    });

    api.it("carries the step's path entries to later steps, last written first", async () => {
      const { scratch, output } = ports();
      const executor = recordingExecutor(scratch, {
        script: (execution) => ({
          stdout: "",
          writes: execution.command === "first" ? { path: "/one\n/two\n" } : {},
        }),
      });
      await makeRunner().run(twoStepPipeline(), { executor, scratch, output, context: {} });
      const second = executor.executed[1];
      check(
        second?.pathEntries.length === 2 && second.pathEntries[0] === "/two",
        `later step searched ${JSON.stringify(second?.pathEntries)}`,
      );
    });

    api.it(
      "routes the command stream: masks hide later lines, levels carry their annotation",
      async () => {
        const { scratch, output } = ports();
        const FILE = "app.ts";
        const FROM_LINE = 2;
        const TO_LINE = 4;
        const TITLE = "Check";
        const executor = recordingExecutor(scratch, {
          script: () => ({
            stdout: `before\n::add-mask::s3cret\nthe token is s3cret\n::warning file=${FILE},line=${String(FROM_LINE)},endLine=${String(TO_LINE)},title=${TITLE}::mind the gap\n`,
            writes: {},
          }),
        });
        await makeRunner().run(twoStepPipeline(), { executor, scratch, output, context: {} });
        const messages = output.entries.map((entry) => entry.message);
        check(messages.includes("before"), "a line before any mask was dropped");
        check(messages.includes("the token is ***"), `masked line was ${JSON.stringify(messages)}`);
        const warning = output.entries.find((entry) => entry.level === "warning");
        check(warning !== undefined, "the warning command produced no entry");
        check(
          warning?.annotation?.file === FILE &&
            warning.annotation.line === FROM_LINE &&
            warning.annotation.endLine === TO_LINE &&
            warning.annotation.title === TITLE &&
            warning.message === "mind the gap",
          `the annotation was ${JSON.stringify(warning?.annotation)}`,
        );
      },
    );

    api.it("rejects an unknown workflow command without quoting it", async () => {
      const { scratch, output } = ports();
      const executor = recordingExecutor(scratch, {
        script: () => ({
          stdout: "::group::tests\n",
          writes: {},
        }),
      });
      let thrown: unknown;
      try {
        await makeRunner().run(twoStepPipeline(), { executor, scratch, output, context: {} });
      } catch (error) {
        thrown = error;
      }
      check(
        thrown instanceof Error &&
          thrown.message.includes("unknown workflow command") &&
          !thrown.message.includes("group"),
        `the unknown command was rejected with ${String(thrown)}`,
      );
    });

    api.it(
      "rejects a malformed line in a step's environment file, naming the file and line",
      async () => {
        const { scratch, output } = ports();
        const executor = recordingExecutor(scratch, {
          script: () => ({
            stdout: "",
            writes: { env: "HEALTHY=yes\nnot an entry\n" },
          }),
        });
        let thrown: unknown;
        try {
          await makeRunner().run(twoStepPipeline(), { executor, scratch, output, context: {} });
        } catch (error) {
          thrown = error;
        }
        const file = executor.executed[0]?.env.GITHUB_ENV;
        check(
          thrown instanceof Error &&
            file !== undefined &&
            thrown.message.includes(file) &&
            thrown.message.includes("line 2"),
          `the malformed line was rejected with ${String(thrown)}`,
        );
      },
    );

    api.it("keeps a step's summary as run output the caller can read", async () => {
      const { scratch, output } = ports();
      const executor = recordingExecutor(scratch, {
        script: (execution) => ({
          stdout: "",
          writes: execution.command === "first" ? { summary: "## Built\n" } : {},
        }),
      });
      await makeRunner().run(twoStepPipeline(), { executor, scratch, output, context: {} });
      check(
        output.summaries.length === 1 && output.summaries[0]?.text === "## Built\n",
        `summaries were ${JSON.stringify(output.summaries)}`,
      );
    });

    api.it("does not carry masks or environment into another job", async () => {
      const pipeline = pipelineSchema.parse({
        name: "CI",
        triggers: [{ kind: "push" }],
        jobs: {
          first: {
            name: "First",
            runsOn: ["x"],
            steps: [{ kind: "run", run: "first" }],
          },
          second: {
            name: "Second",
            runsOn: ["x"],
            needs: ["first"],
            steps: [{ kind: "run", run: "second" }],
          },
        },
      });
      const { scratch, output } = ports();
      const executor = recordingExecutor(scratch, {
        script: (execution) => ({
          stdout: execution.command === "first" ? "::add-mask::s3cret\ns3cret\n" : "s3cret\n",
          writes: execution.command === "first" ? { env: "HELD=back\n" } : {},
        }),
      });
      await makeRunner().run(pipeline, { executor, scratch, output, context: {} });
      const echoed = output.entries.filter((entry) => entry.level === "info").map((e) => e.message);
      check(
        echoed.includes("***") && echoed.includes("s3cret"),
        `the mask did not stay in its own job: ${JSON.stringify(echoed)}`,
      );
      const second = executor.executed.find((entry) => entry.command === "second");
      check(second?.env.HELD === undefined, "an environment entry leaked into another job");
    });
  });
}
