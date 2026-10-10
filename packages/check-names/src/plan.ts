import type { Pipeline, PipelineCompiler } from "@ci-adapters/pipeline-contract";

/**
 * Which jobs' checks are required: `gates` is the fan-in jobs (those with `needsPolicy: always`), which is the single branch-protection target a pipeline is built around; `all` is every job.
 */
export type RequiredScope = "gates" | "all";

/**
 * The check names a provider will report for the jobs in `scope`, derived from the pipeline and the provider's own naming, so a ruleset's required checks cannot drift from the job names that produce them.
 */
export function deriveRequiredChecks(
  pipeline: Pipeline,
  compiler: Readonly<PipelineCompiler>,
  scope: RequiredScope,
): string[] {
  const names = compiler.checkNames(pipeline);
  const selected = Object.entries(pipeline.jobs).filter(
    ([, job]) => scope === "all" || job.needsPolicy === "always",
  );

  return selected.flatMap(([id]) => names.get(id) ?? []);
}

export interface RequiredChecksPlan {
  /** Checks the pipeline produces that the platform does not yet require. */
  readonly add: readonly string[];
  /** Checks the platform requires that no job in scope produces, which would block every merge. */
  readonly remove: readonly string[];
  readonly unchanged: readonly string[];
}

/**
 * Compares the derived names with what the platform currently requires. The result is a plan to review, not an action: ruleset changes are applied by a person, from the platform's own settings or API, after reading the ruleset in full.
 */
export function planRequiredChecks(
  derived: readonly string[],
  current: readonly string[],
): RequiredChecksPlan {
  const wanted = new Set(derived);
  const present = new Set(current);

  return {
    add: [...wanted].filter((name) => !present.has(name)).sort(),
    remove: [...present].filter((name) => !wanted.has(name)).sort(),
    unchanged: [...wanted].filter((name) => present.has(name)).sort(),
  };
}
