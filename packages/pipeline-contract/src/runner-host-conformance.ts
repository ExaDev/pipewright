import { UnsupportedFeatureError } from "./errors.ts";
import { pipelineSchema, type Pipeline } from "./schema.ts";
import type { TestApi } from "./conformance.ts";
import type { PipelineRunner, PreparedStep, StepHost, StepView } from "./runner.ts";

import { CONTEXT, check, ports, recordingExecutor } from "./runner-conformance.ts";

/**
 * Registers the behavioural spec every `PipelineRunner` must meet for the step host port, driven through a recording executor so no process is spawned. The port's two moments are both covered: preparation, which places the host's steps around the job's own, and resolution, which decides what runs where a provider step stood.
 */
export function describeStepHostConformance(api: TestApi, makeRunner: () => PipelineRunner): void {
  api.describe("PipelineRunner step host", () => {
    /** A pipeline whose one job holds a provider step between two run steps, the smallest shape over which a host's placement and resolution are both exercised. */
    const hostedPipeline = (): Pipeline =>
      pipelineSchema.parse({
        name: "CI",
        triggers: [{ kind: "push" }],
        jobs: {
          build: {
            name: "Build",
            runsOn: ["x"],
            steps: [
              { kind: "run", run: "before" },
              {
                kind: "provider",
                provider: "github-actions",
                native: { uses: "example/action@v1" },
              },
              { kind: "run", run: "after" },
            ],
          },
        },
      });

    /** A prepared step with a distinct command, so the order the runner ran them in is the order of the commands. */
    const prepared = (command: string): PreparedStep => ({
      name: command,
      command,
      env: {},
      workingDirectory: undefined,
    });

    api.it(
      "places a host's steps around the job's own and its environment under them",
      async () => {
        const { scratch, output } = ports();
        const executor = recordingExecutor(scratch);
        const host: StepHost = {
          async expand(job) {
            return Promise.resolve({
              steps: [{ kind: "run", run: "pre" }, ...job.steps, { kind: "run", run: "post" }],
              env: { HOSTED: "yes" },
            });
          },
          async resolve() {
            return Promise.resolve({ kind: "steps", steps: [prepared("resolved")] });
          },
        };
        await makeRunner().run(hostedPipeline(), {
          executor,
          scratch,
          output,
          context: CONTEXT,
          host,
        });
        const commands = executor.executed.map((entry) => entry.command);
        check(commands.join(",") === "pre,before,resolved,after,post", `ran ${commands.join(",")}`);
        const resolved = executor.executed.find((entry) => entry.command === "resolved");
        check(resolved?.env.HOSTED === "yes", "the host's job environment did not reach its steps");
      },
    );

    api.it("gives each prepared step its own report entry and file commands", async () => {
      const { scratch, output } = ports();
      const executor = recordingExecutor(scratch, {
        script: (execution) => ({
          stdout: "",
          writes: execution.command === "inner one" ? { output: "inner=1\n" } : {},
        }),
      });
      const host: StepHost = {
        async expand(job) {
          return Promise.resolve({ steps: job.steps, env: {} });
        },
        async resolve() {
          return Promise.resolve({
            kind: "steps",
            steps: [prepared("inner one"), prepared("inner two")],
          });
        },
      };
      const report = await makeRunner().run(hostedPipeline(), {
        executor,
        scratch,
        output,
        context: CONTEXT,
        host,
      });
      const names = report.jobs[0]?.steps.map((step) => step.name);
      check(
        names !== undefined && names.includes("inner one") && names.includes("inner two"),
        `prepared steps were reported as ${JSON.stringify(names)}`,
      );
      const inner = report.jobs[0]?.steps.find((step) => step.name === "inner one");
      check(inner?.outputs.inner === "1", "a prepared step's outputs were not recorded");
    });

    api.it("stops a resolved step's commands at the first failure", async () => {
      const { scratch, output } = ports();
      const executor = recordingExecutor(scratch, {
        failing: (command) => command === "inner one",
      });
      const host: StepHost = {
        async expand(job) {
          return Promise.resolve({ steps: job.steps, env: {} });
        },
        async resolve() {
          return Promise.resolve({
            kind: "steps",
            steps: [prepared("inner one"), prepared("inner two")],
          });
        },
      };
      const report = await makeRunner().run(hostedPipeline(), {
        executor,
        scratch,
        output,
        context: CONTEXT,
        host,
      });
      check(!report.ok, "a failing prepared step was reported as ok");
      check(
        !executor.executed.some((entry) => entry.command === "inner two"),
        "the command after a failing one still ran",
      );
      check(
        !executor.executed.some((entry) => entry.command === "after"),
        "a step after the failed provider step still ran",
      );
    });

    api.it("resolves against what the job's earlier steps produced", async () => {
      const { scratch, output } = ports();
      const executor = recordingExecutor(scratch, {
        script: (execution) => ({
          stdout: "",
          writes:
            execution.command === "before" ? { output: "flag=held\n", env: "SET=here\n" } : {},
        }),
      });
      let seen: StepView | undefined;
      const host: StepHost = {
        async expand(job) {
          return Promise.resolve({ steps: job.steps, env: {} });
        },
        async resolve(_step, view) {
          seen = view;

          return Promise.resolve({ kind: "steps", steps: [prepared("resolved")] });
        },
      };
      await makeRunner().run(hostedPipeline(), {
        executor,
        scratch,
        output,
        context: CONTEXT,
        host,
      });
      const before = seen?.steps.find(
        (record) => record.step.kind === "run" && record.step.run === "before",
      );
      check(
        before?.outputs.flag === "held",
        `the resolver saw ${JSON.stringify(seen?.steps.map((record) => record.outputs))}`,
      );
      check(seen?.env.SET === "here", "the resolver did not see the written environment");
      const resolved = executor.executed.find((entry) => entry.command === "resolved");
      check(resolved?.env.SET === "here", "a resolved step did not run with the written entry");
    });

    api.it("reports a provider step the host skips, and asks once per step", async () => {
      const { scratch, output } = ports();
      let asked = 0;
      const host: StepHost = {
        async expand(job) {
          return Promise.resolve({ steps: job.steps, env: {} });
        },
        async resolve() {
          asked += 1;

          return Promise.resolve({ kind: "skipped" });
        },
      };
      const report = await makeRunner().run(hostedPipeline(), {
        executor: recordingExecutor(scratch),
        scratch,
        output,
        context: CONTEXT,
        host,
      });
      check(asked === 1, `the host was asked ${String(asked)} times`);
      const reported = report.jobs[0]?.steps.find(
        (step) => step.outcome === "skipped" && step.name === "provider",
      );
      check(reported !== undefined, "the skipped provider step was not reported");
    });

    api.it("does not prepare a job that does not run", async () => {
      const { scratch, output } = ports();
      const pipeline = hostedPipeline();
      const build = pipeline.jobs.build;
      if (build === undefined) throw new Error("sample pipeline lost its build job");
      build.when = {
        kind: "textCompare",
        op: "equals",
        left: { kind: "reference", key: "refName" },
        right: { kind: "textLiteral", value: "release" },
      };
      let preparedCount = 0;
      const host: StepHost = {
        async expand(job) {
          preparedCount += 1;

          return Promise.resolve({ steps: job.steps, env: {} });
        },
        async resolve() {
          return Promise.resolve({ kind: "skipped" });
        },
      };
      await makeRunner().run(pipeline, {
        executor: recordingExecutor(scratch),
        scratch,
        output,
        context: CONTEXT,
        host,
      });
      check(preparedCount === 0, "a job that did not run was prepared");
    });

    api.it("rejects a provider step the host does not handle", async () => {
      const { scratch, output } = ports();
      const host: StepHost = {
        async expand(job) {
          return Promise.resolve({ steps: job.steps, env: {} });
        },
        async resolve() {
          return Promise.resolve({ kind: "unhandled", construct: "a container image" });
        },
      };
      let thrown: unknown;
      try {
        await makeRunner().run(hostedPipeline(), {
          executor: recordingExecutor(scratch),
          scratch,
          output,
          context: CONTEXT,
          host,
        });
      } catch (error) {
        thrown = error;
      }
      check(
        thrown instanceof UnsupportedFeatureError && thrown.feature.includes("container image"),
        `the unhandled step was rejected with ${String(thrown)}`,
      );
    });
  });
}
