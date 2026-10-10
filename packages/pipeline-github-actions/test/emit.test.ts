import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  UnsupportedFeatureError,
  pipelineSchema,
  samplePipeline,
  type Pipeline,
} from "@ci-adapters/pipeline-contract";

import { createGitHubActionsCompiler } from "../src/index.ts";

const SOURCE = "ci/sample.pipeline.json";

function textEquals(key: string, value: string): unknown {
  return {
    kind: "textCompare",
    op: "equals",
    left: { kind: "reference", key },
    right: { kind: "textLiteral", value },
  };
}

function pipelineWith(job: Record<string, unknown>): Pipeline {
  return pipelineSchema.parse({
    name: "CI",
    triggers: [{ kind: "push" }],
    jobs: {
      only: {
        name: "Only",
        runsOn: ["ubuntu-latest"],
        steps: [{ kind: "run", run: "echo" }],
        ...job,
      },
    },
  });
}

async function emit(pipeline: Pipeline): Promise<string> {
  const [file] = await createGitHubActionsCompiler().compile(pipeline, { source: SOURCE });
  if (file === undefined) throw new Error("no file emitted");
  return file.content;
}

describe("GitHub Actions emission", () => {
  it("matches the golden workflow for the sample pipeline", async () => {
    const golden = await readFile(new URL("./golden/sample.yml", import.meta.url), "utf8");
    expect(await emit(samplePipeline())).toBe(golden);
  });

  it("writes the workflow under .github/workflows named for the pipeline", async () => {
    const [file] = await createGitHubActionsCompiler().compile(samplePipeline(), {
      source: SOURCE,
    });
    expect(file?.path).toBe(".github/workflows/ci.yml");
  });

  it("maps neutral event names to GitHub's", async () => {
    const text = await emit(
      pipelineWith({ when: textEquals("event", "pullRequest") }),
    );
    expect(text).toContain("if: (github.event_name == 'pull_request')");
  });

  it("renders membership as a disjunction of equalities", async () => {
    const text = await emit(
      pipelineWith({
        when: {
          kind: "memberOf",
          op: "in",
          operand: { kind: "reference", key: "refName" },
          candidates: [
            { kind: "textLiteral", value: "main" },
            { kind: "textLiteral", value: "release" },
          ],
        },
      }),
    );
    expect(text).toContain(
      "if: ((github.ref_name == 'main') || (github.ref_name == 'release'))",
    );
  });

  it("combines always() with a condition", async () => {
    const text = await emit(
      pipelineWith({ needsPolicy: "always", when: textEquals("refName", "main") }),
    );
    expect(text).toContain("if: always() && (github.ref_name == 'main')");
  });

  it("allows a matrix reference in a step condition", async () => {
    const text = await emit(
      pipelineWith({
        matrix: { node: ["22"] },
        steps: [
          { kind: "run", run: "echo", when: textEquals("matrix.node", "22") },
        ],
      }),
    );
    expect(text).toContain("if: (matrix.node == '22')");
  });

  describe("guard", () => {
    async function rejection(job: Record<string, unknown>): Promise<UnsupportedFeatureError> {
      try {
        await emit(pipelineWith(job));
      } catch (error) {
        if (error instanceof UnsupportedFeatureError) return error;
        throw error;
      }
      throw new Error("the pipeline was accepted");
    }

    it("rejects a matrix reference in a job-level condition, naming the node", async () => {
      const error = await rejection({
        matrix: { node: ["22"] },
        when: textEquals("matrix.node", "22"),
      });
      expect(error.pointer).toBe("/jobs/only/when");
      expect(error.feature).toContain("job-level condition");
    });

    it("rejects a regular-expression comparison", async () => {
      const error = await rejection({
        when: {
          kind: "textCompare",
          op: "matches",
          left: { kind: "reference", key: "refName" },
          right: { kind: "textLiteral", value: "^release/" },
        },
      });
      expect(error.feature).toBe("the matches text comparison");
    });

    it("rejects an event value outside the vocabulary", async () => {
      const error = await rejection({ when: textEquals("event", "tag") });
      expect(error.feature).toBe('the event value "tag"');
    });

    it("rejects an ordering comparison", async () => {
      const error = await rejection({
        when: {
          kind: "compare",
          op: "gt",
          left: { kind: "reference", key: "runId" },
          right: { kind: "numberLiteral", value: 1 },
        },
      });
      expect(error.feature).toBe("the gt comparison");
    });
  });
});
