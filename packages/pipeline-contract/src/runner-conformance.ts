import { UnsupportedFeatureError } from "./errors.ts";
import type {
  CommandExecution,
  CommandExecutor,
  PipelineRunner,
  RunContext,
} from "./runner.ts";
import { pipelineSchema } from "./schema.ts";
import { samplePipeline, type TestApi } from "./conformance.ts";

const CONTEXT: RunContext = {
  event: "push",
  refName: "main",
  baseRefName: "",
  sha: "abc123",
  repository: "example/repo",
  workflow: "CI",
  runId: "1",
};

interface RecordingExecutor extends CommandExecutor {
  readonly executed: CommandExecution[];
}

function recordingExecutor(failing: (command: string) => boolean = () => false): RecordingExecutor {
  const executed: CommandExecution[] = [];
  return {
    executed,
    execute(command) {
      executed.push(command);
      return Promise.resolve({ exitCode: failing(command.command) ? 1 : 0 });
    },
  };
}

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

/**
 * Registers the behavioural spec every `PipelineRunner` must meet, driven through a recording executor so no process is spawned.
 */
export function describeRunnerConformance(
  api: TestApi,
  makeRunner: () => PipelineRunner,
): void {
  api.describe("PipelineRunner conformance", () => {
    api.it("runs jobs in needs order", async () => {
      const executor = recordingExecutor();
      const report = await makeRunner().run(samplePipeline(), { executor, context: CONTEXT });
      const commands = executor.executed.map((entry) => entry.command);
      check(report.ok, "a clean run was reported as failed");
      check(
        commands.indexOf("pnpm run lint") < commands.indexOf("pnpm test") &&
          commands.indexOf("pnpm test") < commands.indexOf("echo gate"),
        `jobs ran out of order: ${commands.join(", ")}`,
      );
    });

    api.it("runs a job once per matrix combination with the axis value in scope", async () => {
      const executor = recordingExecutor();
      await makeRunner().run(samplePipeline(), { executor, context: CONTEXT });
      const versions = executor.executed
        .filter((entry) => entry.command === "pnpm test")
        .map((entry) => entry.env["NODE_VERSION"]);
      check(
        versions.length === 2 && versions.includes("22") && versions.includes("24"),
        `matrix values were ${JSON.stringify(versions)}`,
      );
    });

    api.it("resolves context tokens in step environments", async () => {
      const executor = recordingExecutor();
      await makeRunner().run(samplePipeline(), { executor, context: CONTEXT });
      const test = executor.executed.find((entry) => entry.command === "pnpm test");
      check(test?.env["SHA"] === "abc123", "the sha token was not resolved");
    });

    api.it("skips dependants of a failed job but still runs an always job", async () => {
      const executor = recordingExecutor((command) => command === "pnpm run lint");
      const report = await makeRunner().run(samplePipeline(), { executor, context: CONTEXT });
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
      const executor = recordingExecutor();
      const report = await makeRunner().run(pipeline, { executor, context: CONTEXT });
      check(executor.executed.length === 0, "a job whose condition is false ran");
      check(report.jobs[0]?.outcome === "skipped", "the job was not reported as skipped");
    });

    api.it("rejects a provider step", async () => {
      const pipeline = samplePipeline();
      pipeline.jobs["lint"]?.steps.push({
        kind: "provider",
        provider: "github-actions",
        native: { uses: "example/action@v1" },
      });
      let thrown: unknown;
      try {
        await makeRunner().run(pipeline, { executor: recordingExecutor(), context: CONTEXT });
      } catch (error) {
        thrown = error;
      }
      check(thrown instanceof UnsupportedFeatureError, "a provider step was accepted");
    });

    api.it("runs only the matrix combination it is given", async () => {
      const executor = recordingExecutor();
      await makeRunner().run(samplePipeline(), {
        executor,
        context: CONTEXT,
        only: ["test"],
        matrix: { node: "24" },
      });
      const versions = executor.executed.map((entry) => entry.env["NODE_VERSION"]);
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
      const executor = recordingExecutor();
      await makeRunner().run(pipeline, {
        executor,
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

    api.it("runs only the named jobs when asked", async () => {
      const executor = recordingExecutor();
      await makeRunner().run(samplePipeline(), {
        executor,
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
}
