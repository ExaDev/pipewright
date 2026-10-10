import type { ContextKey, EventKind } from "@ci-adapters/pipeline-contract";

export const PROVIDER = "gitlab-ci";

/**
 * The variable each neutral context key stands for. The compiler writes this table and the importer reads it back, so the two cannot disagree.
 */
export const CONTEXT_VARIABLE: Readonly<Record<ContextKey, string>> = {
  event: "$CI_PIPELINE_SOURCE",
  refName: "$CI_COMMIT_REF_NAME",
  baseRefName: "$CI_MERGE_REQUEST_TARGET_BRANCH_NAME",
  sha: "$CI_COMMIT_SHA",
  repository: "$CI_PROJECT_PATH",
  workflow: "$CI_PIPELINE_NAME",
  runId: "$CI_PIPELINE_ID",
};

export const PIPELINE_SOURCE: Readonly<Record<EventKind, string>> = {
  push: "push",
  pullRequest: "merge_request_event",
  schedule: "schedule",
  manual: "web",
};

/** Top-level keys that are configuration rather than job names, so a job cannot be called one of them. */
export const RESERVED_NAMES: ReadonlySet<string> = new Set([
  "image",
  "services",
  "stages",
  "types",
  "before_script",
  "after_script",
  "variables",
  "cache",
  "include",
  "default",
  "workflow",
]);

const REGEX_METACHARACTERS = /[.*+?^${}()|[\]\\/]/g;

export function escapeRegex(text: string): string {
  return text.replaceAll(REGEX_METACHARACTERS, "\\$&");
}

/**
 * The inverse of `escapeRegex`: the literal text a regular expression body matches, or `undefined` when the body uses a metacharacter as an operator and so matches more than one string.
 */
export function literalOfRegex(body: string): string | undefined {
  let text = "";
  for (let index = 0; index < body.length; index += 1) {
    const char = body.charAt(index);
    if (char === "\\") {
      const escaped = body.charAt(index + 1);
      if (escaped === "" || /[A-Za-z0-9]/.test(escaped)) return undefined;
      text += escaped;
      index += 1;
    } else if (/[.*+?^${}()|[\]/]/.test(char)) {
      return undefined;
    } else {
      text += char;
    }
  }

  return text;
}

/**
 * The neutral name for each provider spelling in a table above, so each correspondence is defined once and its two directions cannot disagree.
 */
function invert<Key extends string>(
  table: Readonly<Record<Key, string>>,
): ReadonlyMap<string, Key> {
  const keys: Key[] = Object.keys(table).filter((key): key is Key => key in table);

  return new Map(keys.map((key) => [table[key], key]));
}

export const CONTEXT_OF_VARIABLE = invert(CONTEXT_VARIABLE);
export const EVENT_OF_SOURCE = invert(PIPELINE_SOURCE);
