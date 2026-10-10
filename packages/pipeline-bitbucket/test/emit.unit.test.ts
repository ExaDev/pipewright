import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  UnsupportedFeatureError,
  pipelineSchema,
  samplePipeline,
  type Pipeline,
} from "@ci-adapters/pipeline-contract";

import { createBitbucketPipelinesCompiler } from "../src/index.ts";

const FEATURES = { environment: false, concurrency: false, timeouts: true, manualTrigger: true };
const SOURCE = "ci/sample.pipeline.json";

function pipelineWith(overrides: Record<string, unknown>): Pipeline {
  return pipelineSchema.parse({
    name: "CI",
    triggers: [{ kind: "push" }],
    jobs: {
      only: {
        name: "Only",
        runsOn: ["ubuntu-latest"],
        steps: [{ kind: "run", run: "echo" }],
      },
    },
    ...overrides,
  });
}

async function rejection(pipeline: Pipeline): Promise<UnsupportedFeatureError> {
  try {
    await createBitbucketPipelinesCompiler().compile(pipeline, { source: SOURCE });
  } catch (error) {
    if (error instanceof UnsupportedFeatureError) return error;
    throw error;
  }
  throw new Error("the pipeline was accepted");
}

describe("Bitbucket Pipelines emission", () => {
  it("matches the golden file for the sample pipeline", async () => {
    const [file] = await createBitbucketPipelinesCompiler().compile(samplePipeline(FEATURES), {
      source: SOURCE,
    });
    const golden = await readFile(new URL("./golden/sample.yml", import.meta.url), "utf8");
    expect(file?.path).toBe("bitbucket-pipelines.yml");
    expect(file?.content).toBe(golden);
  });

  it("writes runs-on only for a self-hosted runner label", async () => {
    const compile = async (runsOn: readonly string[]): Promise<string> => {
      const [file] = await createBitbucketPipelinesCompiler().compile(
        pipelineWith({
          jobs: {
            only: { name: "Only", runsOn, steps: [{ kind: "run", run: "true" }] },
          },
        }),
        { source: SOURCE },
      );

      return file?.content ?? "";
    };
    expect(await compile(["ubuntu-latest"])).not.toContain("runs-on");
    expect(await compile(["self.hosted", "linux"])).toContain("runs-on");
  });

  it("quotes a matrix value that contains a space", async () => {
    const pipeline = pipelineWith({
      form: "wrapper",
      jobs: {
        only: {
          name: "Only",
          runsOn: ["x"],
          matrix: { version: ["node 22"] },
          steps: [{ kind: "run", run: "true" }],
        },
      },
    });
    const [file] = await createBitbucketPipelinesCompiler().compile(pipeline, {
      source: SOURCE,
      toolCommand: "tool",
    });
    expect(file?.content).toContain("--matrix 'version=node 22'");
  });

  it("writes the wrapper form with the matrix value as a literal flag", async () => {
    const pipeline = samplePipeline(FEATURES);
    pipeline.form = "wrapper";
    const [file] = await createBitbucketPipelinesCompiler().compile(pipeline, {
      source: SOURCE,
      toolCommand: "node tool/bin.ts",
    });
    expect(file?.content).toContain(
      "node tool/bin.ts run --pipeline ci/sample.pipeline.json --job test --steps 1-1 --matrix 'node=22'",
    );
  });

  describe("guard", () => {
    it("rejects a schedule trigger", async () => {
      const error = await rejection(
        pipelineWith({ triggers: [{ kind: "schedule", cron: "0 * * * *" }] }),
      );
      expect(error.pointer).toBe("/triggers/0");
    });

    it("rejects a pull-request target-branch filter", async () => {
      const error = await rejection(
        pipelineWith({ triggers: [{ kind: "pullRequest", branches: ["main"] }] }),
      );
      expect(error.pointer).toBe("/triggers/0/branches");
    });

    it("rejects environment variables", async () => {
      const pipeline = samplePipeline(FEATURES);
      const test = pipeline.jobs.test;
      if (test === undefined) throw new Error("sample lost its test job");
      test.env = { A: "b" };
      expect((await rejection(pipeline)).pointer).toBe("/jobs/test/env");
    });

    it("rejects a dependency graph that is not a sequence of parallel groups", async () => {
      const job = (needs: readonly string[]): Record<string, unknown> => ({
        name: "J",
        runsOn: ["x"],
        needs,
        steps: [{ kind: "run", run: "true" }],
      });
      const error = await rejection(
        pipelineWith({
          jobs: {
            a: { name: "A", runsOn: ["x"], steps: [{ kind: "run", run: "true" }] },
            b: { name: "B", runsOn: ["x"], steps: [{ kind: "run", run: "true" }] },
            c: job(["a"]),
            d: job(["b"]),
          },
        }),
      );
      expect(error.pointer).toMatch(/^\/jobs\/[cd]\/needs$/);
    });

    it("rejects a condition", async () => {
      const error = await rejection(
        pipelineWith({
          jobs: {
            only: {
              name: "Only",
              runsOn: ["x"],
              when: {
                kind: "textCompare",
                op: "equals",
                left: { kind: "reference", key: "refName" },
                right: { kind: "textLiteral", value: "main" },
              },
              steps: [{ kind: "run", run: "true" }],
            },
          },
        }),
      );
      expect(error.pointer).toBe("/jobs/only/when");
    });
  });
});

describe("always-running jobs", () => {
  function withAlways(triggers: readonly unknown[]): Pipeline {
    const pipeline = samplePipeline(FEATURES);
    const gate = pipeline.jobs.gate;
    if (gate === undefined) throw new Error("sample lost its gate job");
    gate.needsPolicy = "always";

    return pipelineSchema.parse({ ...pipeline, triggers });
  }

  it("becomes the final step of a branch pipeline", async () => {
    const [file] = await createBitbucketPipelinesCompiler().compile(
      withAlways([{ kind: "push", branches: ["main"] }]),
      { source: SOURCE },
    );
    expect(file?.content).toContain("- final:");
  });

  it("is rejected in a custom pipeline, where the schema allows no final step", async () => {
    const error = await rejection(withAlways([{ kind: "manual" }]));
    expect(error.pointer).toBe("/triggers/0");
  });
});
