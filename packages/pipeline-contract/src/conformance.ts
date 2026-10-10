import type { PipelineCompiler } from "./compiler.ts";
import { UnsupportedFeatureError } from "./errors.ts";
import { pipelineSchema, type Pipeline, type ProviderId } from "./schema.ts";

/**
 * The test-framework surface the kit needs, so it runs under vitest, node:test or anything else that has `describe` and `it`.
 */
export interface TestApi {
  readonly describe: (name: string, body: () => void) => void;
  readonly it: (name: string, body: () => Promise<void>) => void;
}

const SOURCE = "ci/sample.pipeline.json";
const DESCRIPTION_TEXT = "Explains why this job exists.";

/**
 * A pipeline using only portable features, shared by the kit so every adapter is held to the same input.
 */
export function samplePipeline(): Pipeline {
  return pipelineSchema.parse({
    name: "CI",
    triggers: [
      { kind: "push", branches: ["main"] },
      { kind: "pullRequest" },
      { kind: "manual" },
    ],
    permissions: { contents: "read" },
    concurrency: { group: "ci-{{ workflow }}-{{ refName }}", cancelInProgress: true },
    jobs: {
      lint: {
        name: "Lint",
        description: DESCRIPTION_TEXT,
        runsOn: ["ubuntu-latest"],
        timeoutMinutes: 10,
        steps: [
          { kind: "checkout" },
          { kind: "run", name: "Lint", run: "pnpm run lint" },
        ],
      },
      test: {
        name: "Test",
        runsOn: ["ubuntu-latest"],
        needs: ["lint"],
        matrix: { node: ["22", "24"] },
        steps: [
          { kind: "checkout" },
          {
            kind: "run",
            run: "pnpm test",
            env: { SHA: "{{ sha }}", NODE_VERSION: "{{ matrix.node }}" },
          },
        ],
      },
      gate: {
        name: "Required checks",
        runsOn: ["ubuntu-latest"],
        needs: ["lint", "test"],
        needsPolicy: "always",
        steps: [{ kind: "run", run: "echo gate" }],
      },
    },
  });
}

function foreignProviderOf(provider: ProviderId): ProviderId {
  return provider === "github-actions" ? "gitlab-ci" : "github-actions";
}

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

/**
 * Registers the behavioural spec every `PipelineCompiler` must meet: the reference compiler and each real adapter run the same cases, so they cannot drift apart. `makeCompiler` is called per case so no state is shared.
 */
export function describeCompilerConformance(
  api: TestApi,
  makeCompiler: () => PipelineCompiler,
): void {
  api.describe("PipelineCompiler conformance", () => {
    api.it("emits at least one file at a relative POSIX path", async () => {
      const files = await makeCompiler().compile(samplePipeline(), { source: SOURCE });
      check(files.length > 0, "no files emitted");
      for (const file of files) {
        check(
          !file.path.startsWith("/") && !file.path.includes("..") && !file.path.includes("\\"),
          `path is not a relative POSIX path: ${file.path}`,
        );
      }
    });

    api.it("is deterministic", async () => {
      const first = await makeCompiler().compile(samplePipeline(), { source: SOURCE });
      const second = await makeCompiler().compile(samplePipeline(), { source: SOURCE });
      check(
        JSON.stringify(first) === JSON.stringify(second),
        "two compiles of the same pipeline differ",
      );
    });

    api.it("does not mutate its input", async () => {
      const pipeline = samplePipeline();
      const before = JSON.stringify(pipeline);
      await makeCompiler().compile(pipeline, { source: SOURCE });
      check(JSON.stringify(pipeline) === before, "the input pipeline was mutated");
    });

    api.it("marks every file as generated from its source", async () => {
      const files = await makeCompiler().compile(samplePipeline(), { source: SOURCE });
      for (const file of files) {
        check(file.content.includes(SOURCE), `no generated header in ${file.path}`);
      }
    });

    api.it("emits every job", async () => {
      const files = await makeCompiler().compile(samplePipeline(), { source: SOURCE });
      const all = files.map((file) => file.content).join("\n");
      for (const job of Object.values(samplePipeline().jobs)) {
        check(all.includes(job.name), `job "${job.name}" is missing from the output`);
      }
    });

    api.it("carries a node description into the output", async () => {
      const files = await makeCompiler().compile(samplePipeline(), { source: SOURCE });
      const all = files.map((file) => file.content).join("\n");
      check(all.includes(DESCRIPTION_TEXT), "the description was dropped");
    });

    api.it("rejects a step owned by another provider", async () => {
      const compiler = makeCompiler();
      const pipeline = samplePipeline();
      const lint = pipeline.jobs["lint"];
      if (lint === undefined) throw new Error("sample pipeline lost its lint job");
      lint.steps.push({
        kind: "provider",
        provider: foreignProviderOf(compiler.provider),
        native: { uses: "example/action@v1" },
      });
      let thrown: unknown;
      try {
        await compiler.compile(pipeline, { source: SOURCE });
      } catch (error) {
        thrown = error;
      }
      check(
        thrown instanceof UnsupportedFeatureError,
        "a foreign provider step was accepted or failed with another error",
      );
    });
  });
}
