import type { ContextKey } from "@pipewright/pipeline-contract";

export const PROVIDER = "circleci";
export const FILE = ".circleci/config.yml";

/** The configuration version the compiler writes, which is what introduces workflow `when` conditions, matrices and job parameters. */
export const CONFIG_VERSION = 2.1;

/** The keys that select a job's executor. A job must name exactly one. */
export const EXECUTOR_KEYS: ReadonlySet<string> = new Set([
  "docker",
  "machine",
  "macos",
  "executor",
]);

/** Names a job parameter cannot take, because CircleCI uses them for workflow job configuration. */
export const RESERVED_PARAMETERS: ReadonlySet<string> = new Set([
  "name",
  "requires",
  "context",
  "type",
  "filters",
  "matrix",
  "alias",
]);

/** The pipeline values CircleCI substitutes when the configuration is processed, which are the only context a job's environment can carry. */
export const PIPELINE_VALUE: Readonly<Partial<Record<ContextKey, string>>> = {
  sha: "<< pipeline.git.revision >>",
  refName: "<< pipeline.git.branch >>",
  runId: "<< pipeline.id >>",
};

/**
 * The neutral context key for each pipeline value above, so the correspondence is defined once and its two directions cannot disagree.
 */
export const CONTEXT_OF_VALUE: ReadonlyMap<string, ContextKey> = new Map(
  Object.entries(PIPELINE_VALUE).flatMap(([key, value]) =>
    isContextKey(key) ? [[value, key] as const] : [],
  ),
);

function isContextKey(key: string): key is ContextKey {
  return key in PIPELINE_VALUE;
}
