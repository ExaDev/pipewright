import { SETUP_STEPS } from "./actions.ts";
import {
  context,
  defineJob,
  definePipeline,
  jobsOf,
  t,
  when,
  type JobDefinition,
} from "@ci-adapters/pipeline-contract";

/** Every job runs on the same runner label. */
const RUNNER = "ubuntu-latest";

/** The tool invoked from a job that needs the workspace's own CLI. */
const TOOL = "node packages/cli/src/bin.ts";

/** The pipeline definition the tool itself is generated from, so the repository both uses and tests its own output. */
const PIPELINE_FILE = "ci/ci.pipeline.ts";

/**
 * The steps every job starts with. Installing is native in every job: in a wrapper job the tool itself cannot run until the workspace has resolved its own packages.
 */

interface CheckJob {
  readonly name: string;
  readonly description: string;
  readonly run: string;
  readonly form?: "native" | "wrapper";
  readonly timeoutMinutes?: number;
}

const DEFAULT_TIMEOUT_MINUTES = 15;

function check(options: CheckJob): JobDefinition {
  return {
    name: options.name,
    description: options.description,
    runsOn: [RUNNER],
    timeoutMinutes: options.timeoutMinutes ?? DEFAULT_TIMEOUT_MINUTES,
    ...(options.form === undefined ? {} : { form: options.form }),
    steps: [...SETUP_STEPS, { kind: "run", name: options.name, run: options.run }],
  };
}

const READ_BACK_TIMEOUT_MINUTES = 10;
const E2E_TIMEOUT_MINUTES = 20;
const CONTAINER_TIMEOUT_MINUTES = 45;
const GATE_TIMEOUT_MINUTES = 5;

const lint = defineJob(
  "lint",
  check({
    name: "Lint",
    description: "ESLint over the whole workspace, with no warnings allowed.",
    run: "pnpm run lint",
  }),
);

const typecheck = defineJob(
  "typecheck",
  check({
    name: "Typecheck",
    description: "One TypeScript program for every package.",
    run: "pnpm run typecheck",
  }),
);

const test = defineJob(
  "test",
  check({
    name: "Test",
    description:
      "Unit tests, including each adapter's conformance kit. Rendered in the wrapper form, so this job runs through the tool's own runner.",
    run: "pnpm run test",
    form: "wrapper",
  }),
);

const drift = defineJob(
  "drift",
  check({
    name: "Generated files",
    description: "Fails when a generated file differs from what the tool emits now.",
    run: [
      `${TOOL} check --pipeline ${PIPELINE_FILE} --provider github-actions --tool-command "${TOOL}"`,
      `${TOOL} check --pipeline ci/e2e.pipeline.ts --provider github-actions --tool-command "${TOOL}"`,
      `${TOOL} schema | diff -u schemas/pipeline.schema.json -`,
      `${TOOL} schema --authoring | diff -u schemas/pipeline.authoring.schema.json -`,
    ].join(" && "),
  }),
);

const actionlint = defineJob("actionlint", {
  name: "Actionlint",
  description: "Validates the emitted workflow with GitHub's own linter rules.",
  runsOn: [RUNNER],
  timeoutMinutes: READ_BACK_TIMEOUT_MINUTES,
  steps: [
    { kind: "checkout" },
    {
      kind: "run",
      name: "Install actionlint",
      run: "go install github.com/rhysd/actionlint/cmd/actionlint@v1.7.12",
    },
    { kind: "run", name: "Lint workflows", run: '"$(go env GOPATH)/bin/actionlint"' },
  ],
});

/** The CircleCI CLI release the integration tests validate with, and the digest of its Linux archive, so the binary that runs is the one that was tested. */
const CIRCLECI_CLI_URL =
  "https://github.com/CircleCI-Public/circleci-cli/releases/download/v1.4.0/circleci-cli_1.4.0_linux_amd64.tar.gz";
const CIRCLECI_CLI_SHA256 = "96c3de64d815b076725f5f05aa626d83eaf39b1332a6b1f7e5dbaf46af43f169";

const bitbucketValidator = defineJob("bitbucket-validator", {
  name: "Bitbucket validator",
  description:
    "Pastes the emitted Bitbucket sample into Atlassian's own validator page in a headless browser and requires its verdict, with a misspelt control that it must reject. The page validates in the browser with logic of its own, so this is the product's validator and not the published JSON Schema.",
  runsOn: [RUNNER],
  timeoutMinutes: DEFAULT_TIMEOUT_MINUTES,
  steps: [
    ...SETUP_STEPS,
    {
      kind: "run",
      name: "Install chromium",
      run: "pnpm --dir packages/cli exec playwright-core install --with-deps chromium",
    },
    { kind: "run", name: "Validate", run: "pnpm run test:browser" },
  ],
});

const gitlabLint = defineJob("gitlab-lint", {
  name: "GitLab linter",
  description:
    "Boots a pinned GitLab CE container and runs its own CI linter over the emitted GitLab sample, with a misspelt control that it must reject. It is the product's own validator; the published JSON Schema is checked separately.",
  runsOn: [RUNNER],
  timeoutMinutes: CONTAINER_TIMEOUT_MINUTES,
  steps: [...SETUP_STEPS, { kind: "run", name: "Lint", run: "pnpm run test:container" }],
});

const e2e = defineJob("e2e", {
  name: "End to end on GitHub",
  description:
    "Dispatches the emitted end-to-end workflow on GitHub through the platform adapter, waits for it, and compares the check names GitHub reports with the ones the compiler derived. It runs after a merge to main, because a workflow can be dispatched only once its file is on the default branch, and it is not part of the gate, which counts a skipped job as failed.",
  runsOn: [RUNNER],
  timeoutMinutes: E2E_TIMEOUT_MINUTES,
  when: when.allOf(when.event("push"), when.equals(context.refName, "main")),
  permissions: { actions: "write", checks: "read", contents: "read" },
  native: {
    "github-actions": {
      env: {
        REPOSITORY: "${{ github.repository }}",
        E2E_REF: "${{ github.ref_name }}",
      },
    },
  },
  steps: [
    ...SETUP_STEPS,
    {
      // The write token goes to this one step, after setup and install have run, so no setup action ever holds it in its environment.
      kind: "provider",
      provider: "github-actions",
      native: {
        name: "Dispatch and watch",
        run: "pnpm run test:e2e",
        env: { GH_TOKEN: "${{ github.token }}" },
      },
    },
  ],
});

const validators = defineJob("validators", {
  name: "Provider validators",
  description:
    "Runs each provider's own validator over the configuration the tool emits for it: actionlint for GitHub, and the published JSON Schemas for GitLab, Bitbucket and CircleCI.",
  runsOn: [RUNNER],
  timeoutMinutes: DEFAULT_TIMEOUT_MINUTES,
  steps: [
    ...SETUP_STEPS,
    {
      kind: "run",
      name: "Install actionlint",
      run: 'go install github.com/rhysd/actionlint/cmd/actionlint@v1.7.12 && echo "$(go env GOPATH)/bin" >> "$GITHUB_PATH"',
    },
    {
      kind: "run",
      name: "Install the CircleCI CLI",
      run: [
        `curl -fsSL -o "$RUNNER_TEMP/circleci.tgz" ${CIRCLECI_CLI_URL}`,
        `echo "${CIRCLECI_CLI_SHA256}  $RUNNER_TEMP/circleci.tgz" | sha256sum -c -`,
        'mkdir -p "$HOME/.local/bin"',
        'tar -xzf "$RUNNER_TEMP/circleci.tgz" -C "$HOME/.local/bin" circleci',
        'echo "$HOME/.local/bin" >> "$GITHUB_PATH"',
      ].join(" && "),
    },
    { kind: "run", name: "Validate", run: "pnpm run test:integration" },
  ],
});

const platformSmoke = defineJob("platform-smoke", {
  name: "Platform read path",
  description:
    "Reads this very run back through the platform adapter with the workflow token, so the live read path is exercised on every run. A required-check comparison is not possible here: rulesets are unavailable to a private repository on this organisation's plan, and the API answers 403.",
  runsOn: [RUNNER],
  timeoutMinutes: READ_BACK_TIMEOUT_MINUTES,
  permissions: { actions: "read", checks: "read", contents: "read" },
  native: {
    "github-actions": {
      env: {
        REPOSITORY: "${{ github.repository }}",
        COMMIT: "${{ github.event.pull_request.head.sha || github.sha }}",
        RUN_ID: "${{ github.run_id }}",
      },
    },
  },
  steps: [
    ...SETUP_STEPS,
    {
      kind: "provider",
      provider: "github-actions",
      native: {
        name: "Read this run",
        run: `${TOOL} platform run --repo "$REPOSITORY" --run "$RUN_ID" | grep -E "queued|running|waiting"`,
        env: { GH_TOKEN: "${{ github.token }}" },
      },
    },
    {
      kind: "provider",
      provider: "github-actions",
      native: {
        name: "List this commit's checks",
        run: `${TOOL} platform checks --repo "$REPOSITORY" --sha "$COMMIT"`,
        env: { GH_TOKEN: "${{ github.token }}" },
      },
    },
  ],
});

const requiredChecks = defineJob("required-checks", {
  name: "Required checks",
  description:
    "The single branch-protection target. It runs whatever the other jobs concluded and fails unless all succeeded.",
  runsOn: [RUNNER],
  timeoutMinutes: GATE_TIMEOUT_MINUTES,
  needsPolicy: "gate",
  needs: [
    lint,
    typecheck,
    test,
    drift,
    actionlint,
    validators,
    bitbucketValidator,
    gitlabLint,
    platformSmoke,
  ],
  steps: [{ kind: "run", name: "Report", run: "echo all required jobs succeeded" }],
});

export default definePipeline({
  name: "CI",
  description: "One workflow for the whole workspace. Every check runs from the repository root.",
  triggers: [{ kind: "push", branches: ["main"] }, { kind: "pullRequest" }, { kind: "manual" }],
  permissions: { contents: "read" },
  concurrency: {
    group: t`ci-${context.workflow}-${context.refName}`,
    cancelInProgress: true,
    description: "A new push to a branch supersedes that branch's in-flight run.",
  },
  jobs: jobsOf(
    lint,
    typecheck,
    test,
    drift,
    actionlint,
    validators,
    bitbucketValidator,
    gitlabLint,
    platformSmoke,
    e2e,
    requiredChecks,
  ),
});
