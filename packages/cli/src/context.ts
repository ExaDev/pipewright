import { CONTEXT_KEYS, type ContextKey, type RunContext } from "@ci-adapters/pipeline-contract";

type Environment = Readonly<Record<string, string | undefined>>;

const GITHUB_EVENT: Readonly<Record<string, string>> = {
  push: "push",
  pull_request: "pullRequest",
  pull_request_target: "pullRequest",
  schedule: "schedule",
  workflow_dispatch: "manual",
};

const GITLAB_SOURCE: Readonly<Record<string, string>> = {
  push: "push",
  merge_request_event: "pullRequest",
  schedule: "schedule",
  web: "manual",
  api: "manual",
};

function fromGitHub(env: Environment): Partial<Record<ContextKey, string>> {
  const event = env.GITHUB_EVENT_NAME;

  return {
    ...(event === undefined ? {} : { event: GITHUB_EVENT[event] ?? event }),
    ...(env.GITHUB_REF_NAME === undefined ? {} : { refName: env.GITHUB_REF_NAME }),
    baseRefName: env.GITHUB_BASE_REF ?? "",
    ...(env.GITHUB_SHA === undefined ? {} : { sha: env.GITHUB_SHA }),
    ...(env.GITHUB_REPOSITORY === undefined ? {} : { repository: env.GITHUB_REPOSITORY }),
    ...(env.GITHUB_WORKFLOW === undefined ? {} : { workflow: env.GITHUB_WORKFLOW }),
    ...(env.GITHUB_RUN_ID === undefined ? {} : { runId: env.GITHUB_RUN_ID }),
  };
}

function fromGitLab(env: Environment): Partial<Record<ContextKey, string>> {
  const source = env.CI_PIPELINE_SOURCE;

  return {
    ...(source === undefined ? {} : { event: GITLAB_SOURCE[source] ?? source }),
    ...(env.CI_COMMIT_REF_NAME === undefined ? {} : { refName: env.CI_COMMIT_REF_NAME }),
    baseRefName: env.CI_MERGE_REQUEST_TARGET_BRANCH_NAME ?? "",
    ...(env.CI_COMMIT_SHA === undefined ? {} : { sha: env.CI_COMMIT_SHA }),
    ...(env.CI_PROJECT_PATH === undefined ? {} : { repository: env.CI_PROJECT_PATH }),
    ...(env.CI_PIPELINE_NAME === undefined ? {} : { workflow: env.CI_PIPELINE_NAME }),
    ...(env.CI_PIPELINE_ID === undefined ? {} : { runId: env.CI_PIPELINE_ID }),
  };
}

/**
 * Builds the neutral run context from the provider's own environment variables when run inside one, with explicit `overrides` taking precedence. Every key must resolve: a missing one throws naming it, because a condition evaluated against a guessed value is silently wrong.
 */
export function resolveContext(
  env: Environment,
  overrides: Readonly<Partial<Record<ContextKey, string>>>,
): RunContext {
  const detected =
    env.GITHUB_ACTIONS === "true"
      ? fromGitHub(env)
      : env.GITLAB_CI === "true"
        ? fromGitLab(env)
        : {};
  const merged: Partial<Record<ContextKey, string>> = { ...detected, ...overrides };
  const missing = CONTEXT_KEYS.filter((key) => merged[key] === undefined);
  if (missing.length > 0) {
    throw new Error(
      `no value for context ${missing.join(", ")}; run inside a supported CI or pass --context <key>=<value>`,
    );
  }

  const value = (key: ContextKey): string => merged[key] ?? "";

  return {
    event: value("event"),
    refName: value("refName"),
    baseRefName: value("baseRefName"),
    sha: value("sha"),
    repository: value("repository"),
    workflow: value("workflow"),
    runId: value("runId"),
  };
}
