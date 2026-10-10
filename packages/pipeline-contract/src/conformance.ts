import type { PipelineCompiler } from "./compiler.ts";
import { UnsupportedFeatureError } from "./errors.ts";
import { pipelineSchema, type Pipeline, type ProviderId } from "./schema.ts";

/**
 * The test-framework surface the kit needs, so it runs under vitest, node:test or anything else that has `describe` and `it`.
 */
export interface TestApi {
  readonly describe: (name: string, body: () => void) => unknown;
  readonly it: (name: string, body: () => Promise<void> | void) => unknown;
}

const SOURCE = "ci/sample.pipeline.json";
const DESCRIPTION_TEXT = "Explains why this job exists.";

/**
 * Features of the sample pipeline an adapter may not be able to express. An adapter whose provider cannot declare one of them runs the kit with that feature off, which removes it from the sample rather than excusing the failure.
 */
export interface SampleFeatures {
  /** Job-level environment variables, including a matrix axis reference. */
  readonly environment: boolean;
  /** A concurrency group that cancels in-flight runs. */
  readonly concurrency: boolean;
  /** Per-job timeouts. */
  readonly timeouts: boolean;
}

export const ALL_FEATURES: SampleFeatures = {
  environment: true,
  concurrency: true,
  timeouts: true,
};

/**
 * A pipeline using only portable features, shared by the kit so every adapter is held to the same input. Each job names a CircleCI executor under `native`, which every other adapter ignores, because that provider cannot run a job without one.
 */
export function samplePipeline(features: SampleFeatures = ALL_FEATURES): Pipeline {
  const executor = { circleci: { docker: [{ image: "cimg/base:stable" }] } };

  return pipelineSchema.parse({
    name: "CI",
    triggers: [{ kind: "push", branches: ["main"] }, { kind: "manual" }],
    ...(features.concurrency
      ? { concurrency: { group: "ci-{{ workflow }}-{{ refName }}", cancelInProgress: true } }
      : {}),
    jobs: {
      lint: {
        name: "Lint",
        description: DESCRIPTION_TEXT,
        runsOn: ["ubuntu-latest"],
        ...(features.timeouts ? { timeoutMinutes: 10 } : {}),
        native: executor,
        steps: [{ kind: "checkout" }, { kind: "run", name: "Lint", run: "pnpm run lint" }],
      },
      test: {
        name: "Test",
        runsOn: ["ubuntu-latest"],
        needs: ["lint"],
        matrix: { node: ["22", "24"] },
        ...(features.environment
          ? { env: { SHA: "{{ sha }}", NODE_VERSION: "{{ matrix.node }}" } }
          : {}),
        native: executor,
        steps: [{ kind: "checkout" }, { kind: "run", run: "pnpm test" }],
      },
      gate: {
        name: "Required checks",
        runsOn: ["ubuntu-latest"],
        needs: ["lint", "test"],
        needsPolicy: "always",
        native: executor,
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
  features: SampleFeatures = ALL_FEATURES,
): void {
  const sample = (): Pipeline => samplePipeline(features);
  api.describe("PipelineCompiler conformance", () => {
    api.it("emits at least one file at a relative POSIX path", async () => {
      const files = await makeCompiler().compile(sample(), { source: SOURCE });
      check(files.length > 0, "no files emitted");
      for (const file of files) {
        check(
          !file.path.startsWith("/") && !file.path.includes("..") && !file.path.includes("\\"),
          `path is not a relative POSIX path: ${file.path}`,
        );
      }
    });

    api.it("is deterministic", async () => {
      const first = await makeCompiler().compile(sample(), { source: SOURCE });
      const second = await makeCompiler().compile(sample(), { source: SOURCE });
      check(
        JSON.stringify(first) === JSON.stringify(second),
        "two compiles of the same pipeline differ",
      );
    });

    api.it("does not mutate its input", async () => {
      const pipeline = sample();
      const before = JSON.stringify(pipeline);
      await makeCompiler().compile(pipeline, { source: SOURCE });
      check(JSON.stringify(pipeline) === before, "the input pipeline was mutated");
    });

    api.it("marks every file as generated from its source", async () => {
      const files = await makeCompiler().compile(sample(), { source: SOURCE });
      for (const file of files) {
        check(file.content.includes(SOURCE), `no generated header in ${file.path}`);
      }
    });

    api.it("emits every job", async () => {
      const files = await makeCompiler().compile(sample(), { source: SOURCE });
      const all = files.map((file) => file.content).join("\n");
      for (const job of Object.values(sample().jobs)) {
        check(all.includes(job.name), `job "${job.name}" is missing from the output`);
      }
    });

    api.it("carries a node description into the output", async () => {
      const files = await makeCompiler().compile(sample(), { source: SOURCE });
      const all = files.map((file) => file.content).join("\n");
      check(all.includes(DESCRIPTION_TEXT), "the description was dropped");
    });

    api.it("names one check per job and matrix combination", () => {
      const names = [...makeCompiler().checkNames(sample()).values()].flat();
      check(
        new Set(names).size === names.length,
        `check names are not unique: ${names.join(", ")}`,
      );
      const test = names.filter((name) => name.includes("Test"));
      check(test.length === 2, `the two-value matrix produced ${String(test.length)} names`);
      for (const base of ["Lint", "Required checks"]) {
        check(names.includes(base), `no check named ${base}`);
      }
    });

    api.it("rejects a step owned by another provider", async () => {
      const compiler = makeCompiler();
      const pipeline = sample();
      const lint = pipeline.jobs.lint;
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
