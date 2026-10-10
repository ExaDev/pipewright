import { generatedHeaderLines, type EmittedFile, type PipelineCompiler } from "./compiler.ts";
import { UnsupportedFeatureError } from "./errors.ts";
import { expandMatrix, matrixValues } from "./matrix.ts";
import type { Pipeline, ProviderId } from "./schema.ts";

/**
 * A reference compiler with real behaviour and no provider: it emits the canonical JSON of the pipeline under a header. Adapters are built and tested against the contract before any provider's syntax is involved, and the conformance kit holds real adapters to the same behavioural spec as this one.
 */
export function createReferenceCompiler(provider: ProviderId = "github-actions"): PipelineCompiler {
  return {
    provider,
    checkNames(pipeline: Pipeline): ReadonlyMap<string, readonly string[]> {
      return new Map(
        Object.entries(pipeline.jobs).map(([id, job]) => [
          id,
          expandMatrix(job.matrix).map((combination) =>
            job.matrix === undefined
              ? job.name
              : `${job.name} (${matrixValues(job.matrix, combination).join(", ")})`,
          ),
        ]),
      );
    },
    async compile(pipeline: Pipeline, options): Promise<readonly EmittedFile[]> {
      for (const [id, job] of Object.entries(pipeline.jobs)) {
        for (const [index, step] of job.steps.entries()) {
          if (step.kind === "provider" && step.provider !== provider) {
            return Promise.reject(
              new UnsupportedFeatureError(
                provider,
                `/jobs/${id}/steps/${String(index)}`,
                `a step owned by ${step.provider}`,
              ),
            );
          }
        }
      }
      const header = generatedHeaderLines(options.source)
        .map((line) => `// ${line}`)
        .join("\n");

      return Promise.resolve([
        {
          path: `.reference/${pipeline.name}.json`,
          content: `${header}\n${JSON.stringify(pipeline, null, 2)}\n`,
        },
      ]);
    },
  };
}
