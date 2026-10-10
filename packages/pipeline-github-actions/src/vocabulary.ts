import type { ContextKey, EventKind, Permissions } from "@ci-adapters/pipeline-contract";

export const PROVIDER = "github-actions";

/**
 * The checkout action, pinned to the commit its v7 tag pointed at when it was resolved, because a tag is a mutable reference and a checkout runs in every job. It is pinned here, in one place, so a bump is a single reviewed change to the adapter rather than an edit to every pipeline.
 */
export const CHECKOUT_ACTION = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1";

/**
 * The expression each neutral context key stands for. The compiler writes these and the importer reads them back, so the two share one table and cannot disagree.
 */
export const CONTEXT_EXPRESSION: Readonly<Record<ContextKey, string>> = {
  event: "github.event_name",
  refName: "github.ref_name",
  baseRefName: "github.base_ref",
  sha: "github.sha",
  repository: "github.repository",
  workflow: "github.workflow",
  runId: "github.run_id",
};

export const EVENT_NAME: Readonly<Record<EventKind, string>> = {
  push: "push",
  pullRequest: "pull_request",
  schedule: "schedule",
  manual: "workflow_dispatch",
};

/**
 * The step a gate job starts with. GitHub reports a job skipped because a dependency failed as successful, and a skipped job does not block a required check, so a gate has to run regardless and fail explicitly when any job it needs did not succeed.
 * @see https://docs.github.com/en/actions/using-jobs/using-conditions-to-control-job-execution
 */
export const GATE_STEP = {
  name: "Fail unless every needed job succeeded",
  if: "contains(needs.*.result, 'failure') || contains(needs.*.result, 'cancelled') || contains(needs.*.result, 'skipped')",
  run: "exit 1",
} as const;

export const PERMISSION_SCOPE: Readonly<Record<keyof Permissions, string>> = {
  actions: "actions",
  contents: "contents",
  pullRequests: "pull-requests",
  issues: "issues",
  checks: "checks",
  packages: "packages",
  identityToken: "id-token",
};

/**
 * The neutral name for each provider spelling in a table above. The compiler writes the tables and the importer reads them back through these, so each correspondence is defined once and its two directions cannot disagree.
 */
function invert<Key extends string>(
  table: Readonly<Record<Key, string>>,
): ReadonlyMap<string, Key> {
  const keys: Key[] = Object.keys(table).filter((key): key is Key => key in table);

  return new Map(keys.map((key) => [table[key], key]));
}

export const CONTEXT_OF_EXPRESSION = invert(CONTEXT_EXPRESSION);
export const EVENT_OF_NAME = invert(EVENT_NAME);
export const SCOPE_OF_PERMISSION = invert(PERMISSION_SCOPE);
