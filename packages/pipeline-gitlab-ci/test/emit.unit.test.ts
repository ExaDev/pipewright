import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { pipelineSchema, samplePipeline } from "@pipewright/pipeline-contract";

import { createGitLabCiCompiler } from "../src/index.ts";

describe("GitLab CI emission", () => {
  it("matches the golden file for the sample pipeline", async () => {
    const [file] = await createGitLabCiCompiler().compile(samplePipeline(), {
      source: "ci/sample.pipeline.json",
    });
    const golden = await readFile(new URL("./golden/sample.yml", import.meta.url), "utf8");

    expect(file?.content).toBe(golden);
  });
});

describe("GitLab CI variable references", () => {
  it("braces a variable written inside text so what follows is not read as part of its name", async () => {
    const pipeline = pipelineSchema.parse({
      name: "CI",
      triggers: [{ kind: "push" }],
      jobs: {
        only: {
          name: "Only",
          runsOn: ["x"],
          matrix: { node: ["22"] },
          env: { TAG: "{{ refName }}_build", RUNTIME: "{{ matrix.node }}x" },
          steps: [{ kind: "run", run: "true" }],
        },
      },
    });
    const [file] = await createGitLabCiCompiler().compile(pipeline, { source: "s" });

    expect(file?.content).toContain("TAG: ${CI_COMMIT_REF_NAME}_build");
    expect(file?.content).toContain("RUNTIME: ${node}x");
  });
});

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
