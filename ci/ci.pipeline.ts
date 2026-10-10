import {
  context,
  defineJob,
  definePipeline,
  jobsOf,
  t,
  type JobDefinition,
  type StepInput,
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
const setup: StepInput[] = [
  { kind: "checkout" },
  { kind: "provider", provider: "github-actions", native: { uses: "pnpm/action-setup@v6" } },
  {
    kind: "provider",
    provider: "github-actions",
    native: {
      uses: "actions/setup-node@v7",
      with: { "node-version-file": ".tool-versions", cache: "pnpm" },
    },
  },
  { kind: "run", name: "Install", run: "pnpm install --frozen-lockfile", form: "native" },
];

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
    steps: [...setup, { kind: "run", name: options.name, run: options.run }],
  };
}

const READ_BACK_TIMEOUT_MINUTES = 10;
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

const validators = defineJob("validators", {
  name: "Provider validators",
  description:
    "Runs each provider's own validator over the configuration the tool emits for it: actionlint for GitHub, and the published JSON Schemas for GitLab, Bitbucket and CircleCI.",
  runsOn: [RUNNER],
  timeoutMinutes: DEFAULT_TIMEOUT_MINUTES,
  steps: [
    ...setup,
    {
      kind: "run",
      name: "Install actionlint",
      run: 'go install github.com/rhysd/actionlint/cmd/actionlint@v1.7.12 && echo "$(go env GOPATH)/bin" >> "$GITHUB_PATH"',
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
        GH_TOKEN: "${{ github.token }}",
        REPOSITORY: "${{ github.repository }}",
        COMMIT: "${{ github.event.pull_request.head.sha || github.sha }}",
        RUN_ID: "${{ github.run_id }}",
      },
    },
  },
  steps: [
    ...setup,
    {
      kind: "run",
      name: "Read this run",
      run: `${TOOL} platform run --repo "$REPOSITORY" --run "$RUN_ID" | grep -E "queued|running|waiting"`,
    },
    {
      kind: "run",
      name: "List this commit's checks",
      run: `${TOOL} platform checks --repo "$REPOSITORY" --sha "$COMMIT"`,
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
  needs: [lint, typecheck, test, drift, actionlint, validators, platformSmoke],
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
  jobs: jobsOf(lint, typecheck, test, drift, actionlint, validators, platformSmoke, requiredChecks),
});
