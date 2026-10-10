import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { loadPipeline, pipelineSchema } from "@pipewright/pipeline-contract";
import { createGitHubActionsCompiler } from "@pipewright/pipeline-github-actions";
import { createGitLabCiCompiler } from "@pipewright/pipeline-gitlab-ci";

const ROOT = resolve(import.meta.dirname, "../../..");

describe("the JSON example", () => {
  it("loads from disk and compiles for each provider", async () => {
    const { pipeline } = await loadPipeline("examples/basic.pipeline.json", {
      read: async (path) => readFile(resolve(ROOT, path), "utf8"),
    });
    const options = { source: "examples/basic.pipeline.json" };
    const github = await createGitHubActionsCompiler().compile(pipeline, options);
    const gitlab = await createGitLabCiCompiler().compile(pipeline, options);
    expect(github[0]?.content).toContain("NODE_VERSION: ${{ matrix.node }}");
    expect(gitlab[0]?.content).toContain("NODE_VERSION: ${node}");
  });
});

describe("JSON as the serialisation of a pipeline", () => {
  it("loads back to the same model that was exported, for this repository's own pipeline", async () => {
    const module: unknown = await import(resolve(ROOT, "ci/ci.pipeline.ts"));
    const authored = pipelineSchema.parse(
      typeof module === "object" && module !== null && "default" in module
        ? module.default
        : undefined,
    );
    const exported = JSON.stringify({ ...authored, $schema: "pipeline.schema.json" });

    const { pipeline } = await loadPipeline("exported.pipeline.json", {
      read: async () => Promise.resolve(exported),
    });

    expect(pipeline).toEqual({ ...authored, $schema: "pipeline.schema.json" });
  });

  it("emits the same workflow from the exported document as from the module", async () => {
    const module: unknown = await import(resolve(ROOT, "ci/ci.pipeline.ts"));
    const authored = pipelineSchema.parse(
      typeof module === "object" && module !== null && "default" in module
        ? module.default
        : undefined,
    );
    const { pipeline } = await loadPipeline("exported.pipeline.json", {
      read: async () =>
        Promise.resolve(JSON.stringify({ ...authored, $schema: "pipeline.schema.json" })),
    });
    const options = { source: "ci/ci.pipeline.ts", toolCommand: "tool" };
    const compiler = createGitHubActionsCompiler();

    expect(await compiler.compile(pipeline, options)).toEqual(
      await compiler.compile(authored, options),
    );
  });
});
