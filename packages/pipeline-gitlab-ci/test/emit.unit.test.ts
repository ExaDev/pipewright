import { describe, expect, it } from "vitest";

import { pipelineSchema, samplePipeline } from "@ci-adapters/pipeline-contract";

import { createGitLabCiCompiler } from "../src/index.ts";

describe("GitLab CI wrapper form", () => {
  it("collapses run steps into one runner call with the matrix axis as a variable", async () => {
    const pipeline = samplePipeline();
    pipeline.form = "wrapper";
    const [file] = await createGitLabCiCompiler().compile(pipeline, {
      source: "ci/sample.pipeline.json",
      toolCommand: "node tool/bin.ts",
    });
    expect(file?.content).toContain(
      'node tool/bin.ts run --pipeline ci/sample.pipeline.json --job test --steps 1-1 --matrix "node=$node"',
    );
    expect(file?.content).not.toContain("- pnpm test");
  });

  it("lets a collapsed step carry its own environment, which the runner interprets", async () => {
    const pipeline = pipelineSchema.parse({
      name: "CI",
      triggers: [{ kind: "push" }],
      form: "wrapper",
      jobs: {
        only: {
          name: "Only",
          runsOn: ["x"],
          steps: [{ kind: "run", run: "true", env: { A: "b" } }],
        },
      },
    });
    const [file] = await createGitLabCiCompiler().compile(pipeline, {
      source: "ci/sample.pipeline.json",
      toolCommand: "tool",
    });
    expect(file?.content).toContain("tool run --pipeline");
  });

  it("needs the tool command", async () => {
    const pipeline = samplePipeline();
    pipeline.form = "wrapper";
    await expect(
      createGitLabCiCompiler().compile(pipeline, { source: "ci/sample.pipeline.json" }),
    ).rejects.toThrow("toolCommand");
  });
});
