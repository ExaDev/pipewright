import { resolve } from "node:path";

import { pipelineSchema, type Pipeline } from "@pipewright/pipeline-contract";

const ROOT = resolve(import.meta.dirname, "../../..");

/** This repository's own pipeline, loaded the way the CLI tests load it. */
export async function repositoryPipeline(): Promise<Pipeline> {
  const module: unknown = await import(resolve(ROOT, "ci/ci.pipeline.ts"));

  return pipelineSchema.parse(
    typeof module === "object" && module !== null && "default" in module
      ? module.default
      : undefined,
  );
}

/** The length of the longest `needs` chain ending at each job, counting jobs, computed without the graph packages. */
export function longestChains(jobs: Pipeline["jobs"]): Map<string, number> {
  const chains = new Map<string, number>();
  const visit = (id: string): number => {
    const known = chains.get(id);
    if (known !== undefined) return known;
    const below = (jobs[id]?.needs ?? []).map(visit);
    const length = 1 + Math.max(0, ...below);
    chains.set(id, length);

    return length;
  };
  for (const id of Object.keys(jobs)) visit(id);

  return chains;
}
