import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  UnsupportedFeatureError,
  pipelineSchema,
  samplePipeline,
  type Pipeline,
} from "@pipewright/pipeline-contract";

import { createCircleCiCompiler } from "../src/index.ts";

const FEATURES = { environment: true, concurrency: false, timeouts: false, manualTrigger: false };
const SOURCE = "ci/sample.pipeline.json";
const EXECUTOR = { circleci: { docker: [{ image: "cimg/base:stable" }] } };

function pipelineWith(overrides: Record<string, unknown>): Pipeline {
  return pipelineSchema.parse({
    name: "CI",
    triggers: [{ kind: "push" }],
    jobs: {
      only: {
        name: "Only",
        runsOn: ["ubuntu-latest"],
        native: EXECUTOR,
        steps: [{ kind: "run", run: "echo" }],
      },
    },
    ...overrides,
  });
}

async function rejection(pipeline: Pipeline): Promise<UnsupportedFeatureError> {
  try {
    await createCircleCiCompiler().compile(pipeline, { source: SOURCE });
  } catch (error) {
    if (error instanceof UnsupportedFeatureError) return error;
    throw error;
  }
  throw new Error("the pipeline was accepted");
}

describe("CircleCI emission", () => {
  it("matches the golden file for the sample pipeline", async () => {
    const [file] = await createCircleCiCompiler().compile(samplePipeline(FEATURES), {
      source: SOURCE,
    });
    const golden = await readFile(new URL("./golden/sample.yml", import.meta.url), "utf8");
    expect(file?.path).toBe(".circleci/config.yml");
    expect(file?.content).toBe(golden);
  });

  it("passes the matrix axis to the runner as a job parameter in the wrapper form", async () => {
    const pipeline = samplePipeline(FEATURES);
    pipeline.form = "wrapper";
    const [file] = await createCircleCiCompiler().compile(pipeline, {
      source: SOURCE,
      toolCommand: "node tool/bin.ts",
    });
    expect(file?.content).toContain('--job test --steps 1-1 --matrix "node=<< parameters.node >>"');
  });

  describe("guard", () => {
    it("rejects a job with no executor", async () => {
      const error = await rejection(
        pipelineWith({
          jobs: {
            only: { name: "Only", runsOn: ["x"], steps: [{ kind: "run", run: "true" }] },
          },
        }),
      );
      expect(error.pointer).toBe("/jobs/only/native");
    });

    it("rejects a schedule trigger, which CircleCI requires a branch filter for", async () => {
      const error = await rejection(
        pipelineWith({ triggers: [{ kind: "schedule", cron: "0 0 * * *" }] }),
      );
      expect(error.pointer).toBe("/triggers/0");
    });

    it("rejects an executor-less native mapping and one with two executors", async () => {
      const job = (native: unknown): Record<string, unknown> => ({
        name: "Only",
        runsOn: ["x"],
        native: { circleci: native },
        steps: [{ kind: "run", run: "true" }],
      });
      expect(
        (await rejection(pipelineWith({ jobs: { only: job({ resource_class: "large" }) } })))
          .pointer,
      ).toBe("/jobs/only/native");
      expect(
        (
          await rejection(
            pipelineWith({ jobs: { only: job({ docker: [{ image: "a" }], machine: true }) } }),
          )
        ).pointer,
      ).toBe("/jobs/only/native");
    });

    it("rejects a reserved matrix axis name", async () => {
      const error = await rejection(
        pipelineWith({
          jobs: {
            only: {
              name: "Only",
              runsOn: ["x"],
              native: EXECUTOR,
              matrix: { name: ["a"] },
              steps: [{ kind: "run", run: "true" }],
            },
          },
        }),
      );
      expect(error.pointer).toBe("/jobs/only/matrix/name");
    });

    it("rejects two jobs with one display name", async () => {
      const job = {
        name: "Same",
        runsOn: ["x"],
        native: EXECUTOR,
        steps: [{ kind: "run", run: "true" }],
      };
      const error = await rejection(pipelineWith({ jobs: { one: job, two: job } }));
      expect(error.pointer).toBe("/jobs/two/name");
    });

    it("rejects two matrix jobs that expand to the same reported names", async () => {
      const job = {
        name: "Same",
        runsOn: ["x"],
        native: EXECUTOR,
        matrix: { node: ["22"] },
        steps: [{ kind: "run", run: "true" }],
      };
      const error = await rejection(pipelineWith({ jobs: { one: job, two: job } }));
      expect(error.pointer).toBe("/jobs/two/name");
    });

    it("rejects a native mapping that sets a key the compiler generates", async () => {
      const error = await rejection(
        pipelineWith({
          jobs: {
            only: {
              name: "Only",
              runsOn: ["x"],
              native: { circleci: { docker: [{ image: "a" }], parameters: {} } },
              steps: [{ kind: "run", run: "true" }],
            },
          },
        }),
      );
      expect(error.pointer).toBe("/jobs/only/native");
    });

    it("rejects a name that yields no workflow key", async () => {
      const error = await rejection(pipelineWith({ name: "---" }));
      expect(error.pointer).toBe("/name");
    });

    it("rejects a shallow checkout and keeps a full one", async () => {
      const withCheckout = (fetchDepth: number | "full"): Pipeline =>
        pipelineWith({
          jobs: {
            only: {
              name: "Only",
              runsOn: ["x"],
              native: EXECUTOR,
              steps: [{ kind: "checkout", fetchDepth }],
            },
          },
        });
      expect((await rejection(withCheckout(1))).pointer).toBe("/jobs/only/steps/0/fetchDepth");
      const [file] = await createCircleCiCompiler().compile(withCheckout("full"), {
        source: SOURCE,
      });
      expect(file?.content).toContain("method: full");
    });

    it("rejects a pull-request trigger and a manual trigger", async () => {
      expect((await rejection(pipelineWith({ triggers: [{ kind: "pullRequest" }] }))).pointer).toBe(
        "/triggers/0",
      );
      expect((await rejection(pipelineWith({ triggers: [{ kind: "manual" }] }))).pointer).toBe(
        "/triggers/0",
      );
    });

    it("rejects a context value CircleCI has no pipeline value for", async () => {
      const error = await rejection(
        pipelineWith({
          jobs: {
            only: {
              name: "Only",
              runsOn: ["x"],
              native: EXECUTOR,
              env: { REPO: "{{ repository }}" },
              steps: [{ kind: "run", run: "true" }],
            },
          },
        }),
      );
      expect(error.pointer).toBe("/jobs/only/env/REPO");
    });
  });
});
