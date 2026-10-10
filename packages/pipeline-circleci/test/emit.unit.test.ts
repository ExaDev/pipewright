import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  UnsupportedFeatureError,
  pipelineSchema,
  samplePipeline,
  type Pipeline,
} from "@ci-adapters/pipeline-contract";

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
    expect(file?.content).toContain("--job test --steps 1-1 --matrix node=<< parameters.node >>");
  });

  it("emits a scheduled workflow for a schedule trigger", async () => {
    const [file] = await createCircleCiCompiler().compile(
      pipelineWith({ triggers: [{ kind: "schedule", cron: "0 0 * * *" }] }),
      { source: SOURCE },
    );
    expect(file?.content).toContain("ci-schedule-0:");
    expect(file?.content).toContain("cron: 0 0 * * *");
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
