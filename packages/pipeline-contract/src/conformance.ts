import type { EmittedFile, PipelineCompiler } from "./compiler.ts";
import { UnsupportedFeatureError, UnsupportedNativeError } from "./errors.ts";
import type { PipelineImporter } from "./importer.ts";
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
  /** A manual trigger, which some providers cannot declare in the file. */
  readonly manualTrigger: boolean;
}

export const ALL_FEATURES: SampleFeatures = {
  environment: true,
  concurrency: true,
  timeouts: true,
  manualTrigger: true,
};

/**
 * A pipeline using only portable features, shared by the kit so every adapter is held to the same input. Each job names a CircleCI executor under `native`, which every other adapter ignores, because that provider cannot run a job without one.
 */
export function samplePipeline(features: SampleFeatures = ALL_FEATURES): Pipeline {
  const executor = { circleci: { docker: [{ image: "cimg/base:stable" }] } };

  return pipelineSchema.parse({
    name: "CI",
    triggers: [
      { kind: "push", branches: ["main"] },
      ...(features.manualTrigger ? [{ kind: "manual" }] : []),
    ],
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
        needsPolicy: "gate",
        native: executor,
        steps: [{ kind: "run", run: "echo gate" }],
      },
    },
  });
}

function foreignProviderOf(provider: ProviderId): ProviderId {
  return provider === "github-actions" ? "gitlab-ci" : "github-actions";
}

function check(condition: boolean, message: string): asserts condition {
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

/**
 * What the importer kit needs beyond the compiler and importer: native files the importer must reject, and whether the provider has a wrapper form to hold the importer to.
 */
export interface ImporterConformanceOptions {
  readonly features?: SampleFeatures;
  /** Native files that use something the model cannot express, each of which must fail with `UnsupportedNativeError`. */
  readonly rejects: readonly { readonly name: string; readonly file: EmittedFile }[];
  /** True when the provider's compiler has a wrapper form, whose emitted file must be rejected with `UnsupportedNativeError`: it only calls this tool, so the pipeline source it names is what to import. */
  readonly wrapperForm: boolean;
  /** True when the provider's file can tell a gate from an ordinary dependent job. A provider that already fails a pipeline when a dependency fails writes both the same, so the policy is not in the file to be read back. */
  readonly distinguishesGate: boolean;
  /** True when the provider's file keeps a matrix as axes. One that writes each combination as its own job has no matrix to read back. */
  readonly recoversMatrix: boolean;
}

const TOOL_COMMAND = "node packages/cli/src/bin.ts";

async function outcomeOf(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }

  return undefined;
}

/**
 * Registers the behavioural spec every `PipelineImporter` must meet. The correctness bar is the round trip: what the provider's compiler wrote, imported and compiled again, is byte-identical, which holds the importer to being the compiler's inverse for everything the compiler can say. `makeCompiler` and `makeImporter` are called per case so no state is shared.
 */
export function describeImporterConformance(
  api: TestApi,
  makeCompiler: () => PipelineCompiler,
  makeImporter: () => PipelineImporter,
  options: ImporterConformanceOptions,
): void {
  const features = options.features ?? ALL_FEATURES;
  const sample = (): Pipeline => samplePipeline(features);
  const compile = async (pipeline: Pipeline): Promise<readonly EmittedFile[]> =>
    makeCompiler().compile(pipeline, { source: SOURCE, toolCommand: TOOL_COMMAND });
  const only = (files: readonly EmittedFile[]): EmittedFile => {
    const [file] = files;
    if (file === undefined || files.length !== 1) {
      throw new Error(`expected one emitted file, got ${String(files.length)}`);
    }

    return file;
  };

  api.describe("PipelineImporter conformance", () => {
    api.it("names the provider whose files it reads", () => {
      check(
        makeImporter().provider === makeCompiler().provider,
        "the importer and compiler are for different providers",
      );
    });

    api.it(
      "round-trips: compiling what it read from a compiled file gives the same file",
      async () => {
        const [first] = await compile(sample());
        if (first === undefined) throw new Error("the compiler emitted no file");
        const imported = await makeImporter().import(first);
        const [second] = await compile(imported);
        check(second !== undefined, "the imported pipeline compiled to no file");
        check(second.path === first.path, `the path changed from ${first.path} to ${second.path}`);
        check(second.content === first.content, "the re-emitted file differs from the original");
      },
    );

    api.it("restores a node description from the comment that carried it", async () => {
      const imported = await makeImporter().import(only(await compile(sample())));
      check(
        Object.values(imported.jobs).some((job) => job.description === DESCRIPTION_TEXT),
        "the description was not read back from the file",
      );
    });

    api.it("reports the same checks as the pipeline it was compiled from", async () => {
      const original = sample();
      const imported = await makeImporter().import(only(await compile(original)));
      // Jobs are compared by the checks they report, because a provider may key a job by its name or expand a matrix, which leaves no job id or matrix to read back.
      const checks = (pipeline: Pipeline): string[] =>
        [...makeCompiler().checkNames(pipeline).values()].flat().sort();
      check(
        JSON.stringify(checks(imported)) === JSON.stringify(checks(original)),
        "the imported pipeline reports different checks from the original",
      );
    });

    if (options.recoversMatrix) {
      api.it("reads a matrix back as the axes it was written from", async () => {
        const original = sample();
        const imported = await makeImporter().import(only(await compile(original)));
        const matrixOf = (pipeline: Pipeline): unknown =>
          Object.values(pipeline.jobs).find((job) => job.name === "Test")?.matrix;
        check(
          JSON.stringify(matrixOf(imported)) === JSON.stringify(matrixOf(original)),
          "the imported matrix differs from the original",
        );
      });
    }

    if (options.distinguishesGate) {
      api.it("reads a gate back as a gate", async () => {
        const imported = await makeImporter().import(only(await compile(sample())));
        const policy = Object.values(imported.jobs).find(
          (job) => job.name === "Required checks",
        )?.needsPolicy;
        check(policy === "gate", "the gate policy was not restored");
      });
    }

    api.it("rejects text that is not a configuration", async () => {
      const outcome = await outcomeOf(async () =>
        makeImporter().import({ path: "broken", content: "{ not: [valid" }),
      );
      check(outcome instanceof Error, "text that is not a configuration was accepted");
    });

    for (const { name, file } of options.rejects) {
      api.it(`rejects ${name} with the provider and a pointer`, async () => {
        const importer = makeImporter();
        const outcome = await outcomeOf(async () => importer.import(file));
        check(
          outcome instanceof UnsupportedNativeError,
          `${name} was accepted or failed with another error: ${String(outcome)}`,
        );
        check(outcome.provider === importer.provider, "the error names another provider");
      });
    }

    if (options.wrapperForm) {
      api.it("rejects a file in the wrapper form, which only calls this tool", async () => {
        const pipeline = sample();
        const wrapped = pipelineSchema.parse({ ...pipeline, form: "wrapper" });
        const outcome = await outcomeOf(async () =>
          makeImporter().import(only(await compile(wrapped))),
        );
        check(
          outcome instanceof UnsupportedNativeError,
          `a wrapper-form file was accepted or failed with another error: ${String(outcome)}`,
        );
      });
    }
  });
}
