import { describe, expect, it } from "vitest";

import { createReferenceCompiler, samplePipeline } from "@ci-adapters/pipeline-contract";
import { createGitHubActionsCompiler } from "@ci-adapters/pipeline-github-actions";
import { createGitLabCiCompiler } from "@ci-adapters/pipeline-gitlab-ci";

import { deriveRequiredChecks, planRequiredChecks } from "../src/index.ts";

describe("deriveRequiredChecks", () => {
  it("selects the fan-in gate by default scope", () => {
    expect(
      deriveRequiredChecks(samplePipeline(), createGitHubActionsCompiler(), "gates"),
    ).toEqual(["Required checks"]);
  });

  it("expands matrix jobs in each provider's own naming", () => {
    const pipeline = samplePipeline();
    expect(
      deriveRequiredChecks(pipeline, createGitHubActionsCompiler(), "all"),
    ).toEqual(["Lint", "Test (22)", "Test (24)", "Required checks"]);
    expect(deriveRequiredChecks(pipeline, createGitLabCiCompiler(), "all")).toEqual([
      "Lint",
      "Test: [22]",
      "Test: [24]",
      "Required checks",
    ]);
  });

  it("works with any compiler, including the reference fake", () => {
    expect(
      deriveRequiredChecks(samplePipeline(), createReferenceCompiler(), "gates"),
    ).toEqual(["Required checks"]);
  });
});

describe("planRequiredChecks", () => {
  it("separates additions, removals and unchanged names", () => {
    expect(planRequiredChecks(["A", "B"], ["B", "C"])).toEqual({
      add: ["A"],
      remove: ["C"],
      unchanged: ["B"],
    });
  });
});
