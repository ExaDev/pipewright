import type { ContextKey, RunContext } from "@pipewright/pipeline-contract";

type Environment = Readonly<Record<string, string | undefined>>;
type Values = Partial<Record<ContextKey, string>>;

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

/** Keeps only the entries that have a value, so an absent environment variable is an absent context value. */
function defined(entries: readonly (readonly [ContextKey, string | undefined])[]): Values {
  return Object.fromEntries(
    entries.filter((entry): entry is readonly [ContextKey, string] => entry[1] !== undefined),
  );
}

function fromGitHub(env: Environment): Values {
  const event = env.GITHUB_EVENT_NAME;

  return defined([
    ["event", event === undefined ? undefined : (GITHUB_EVENT[event] ?? event)],
    ["refName", env.GITHUB_REF_NAME],
    ["baseRefName", env.GITHUB_BASE_REF ?? ""],
    ["sha", env.GITHUB_SHA],
    ["repository", env.GITHUB_REPOSITORY],
    ["workflow", env.GITHUB_WORKFLOW],
    ["runId", env.GITHUB_RUN_ID],
  ]);
}

function fromGitLab(env: Environment): Values {
  const source = env.CI_PIPELINE_SOURCE;

  return defined([
    ["event", source === undefined ? undefined : (GITLAB_SOURCE[source] ?? source)],
    ["refName", env.CI_COMMIT_REF_NAME],
    ["baseRefName", env.CI_MERGE_REQUEST_TARGET_BRANCH_NAME ?? ""],
    ["sha", env.CI_COMMIT_SHA],
    ["repository", env.CI_PROJECT_PATH],
    ["workflow", env.CI_PIPELINE_NAME],
    ["runId", env.CI_PIPELINE_ID],
  ]);
}

/**
 * Bitbucket exposes no variable that says whether a branch pipeline was started by a push or by hand, so `event` is supplied only for a pull request and is otherwise left for the caller.
 */
function fromBitbucket(env: Environment): Values {
  return defined([
    ["event", env.BITBUCKET_PR_ID === undefined ? undefined : "pullRequest"],
    ["refName", env.BITBUCKET_BRANCH],
    ["baseRefName", env.BITBUCKET_PR_DESTINATION_BRANCH ?? ""],
    ["sha", env.BITBUCKET_COMMIT],
    ["repository", env.BITBUCKET_REPO_FULL_NAME],
    ["runId", env.BITBUCKET_PIPELINE_UUID],
  ]);
}

/**
 * CircleCI exposes no workflow name as a variable, and no variable distinguishing a push from a manual run, so those are left for the caller.
 */
function fromCircleCi(env: Environment): Values {
  const owner = env.CIRCLE_PROJECT_USERNAME;
  const repo = env.CIRCLE_PROJECT_REPONAME;

  return defined([
    ["event", env.CIRCLE_PULL_REQUEST === undefined ? undefined : "pullRequest"],
    ["refName", env.CIRCLE_BRANCH],
    ["sha", env.CIRCLE_SHA1],
    ["repository", owner === undefined || repo === undefined ? undefined : `${owner}/${repo}`],
    ["runId", env.CIRCLE_PIPELINE_ID],
  ]);
}

function detect(env: Environment): Values {
  if (env.GITHUB_ACTIONS === "true") return fromGitHub(env);
  if (env.GITLAB_CI === "true") return fromGitLab(env);
  if (env.BITBUCKET_BUILD_NUMBER !== undefined) return fromBitbucket(env);
  if (env.CIRCLECI === "true") return fromCircleCi(env);

  return {};
}

/**
 * Builds the neutral run context from the provider's own environment variables when run inside a supported one, with explicit `overrides` taking precedence. Nothing is guessed: a value neither the environment nor the caller supplies stays absent, and the runner fails at the first step or condition that reads it.
 */
export function resolveContext(env: Environment, overrides: Readonly<Values>): RunContext {
  return { ...detect(env), ...overrides };
}
