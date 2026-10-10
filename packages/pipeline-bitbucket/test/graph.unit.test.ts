import { describe, expect, it } from "vitest";

import { DependencyGraphError, type Job, type Pipeline } from "@pipewright/pipeline-contract";

import { createBitbucketPipelinesCompiler } from "../src/index.ts";

function job(name: string, needs: readonly string[]): Job {
  return {
    name,
    runsOn: ["ubuntu-latest"],
    needs: [...needs],
    steps: [{ kind: "run", run: "true" }],
  };
}

function pipelineOf(jobs: Pipeline["jobs"]): Pipeline {
  return { name: "CI", triggers: [{ kind: "push" }], jobs };
}

async function failureOf(pipeline: Pipeline): Promise<DependencyGraphError> {
  try {
    await createBitbucketPipelinesCompiler().compile(pipeline, {
      source: "ci/graph.pipeline.json",
    });
  } catch (error) {
    if (error instanceof DependencyGraphError) return error;
    throw error;
  }
  throw new Error("the pipeline was accepted");
}

describe("dependency graph errors", () => {
  it("surfaces a needs target that is not a job", async () => {
    const error = await failureOf(
      pipelineOf({ build: job("Build", []), test: job("Test", ["bild"]) }),
    );

    expect(error.unknownNeeds).toEqual([{ job: "test", missing: "bild" }]);
  });

  it("surfaces a cycle with its path", async () => {
    const error = await failureOf(pipelineOf({ a: job("A", ["b"]), b: job("B", ["a"]) }));

    expect(error.cycles).toEqual([["a", "b", "a"]]);
  });
});
