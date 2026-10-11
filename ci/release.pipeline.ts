import { SETUP_STEPS } from "./actions.ts";
import { defineJob, definePipeline, jobsOf } from "@pipewright/pipeline-contract";

const RUNNER = "ubuntu-latest";
const TIMEOUT_MINUTES = 30;

/**
 * npm's trusted publishing (OIDC) needs npm 11.5.1 or later, and the Node in `.tool-versions` ships an older one. Pinned, not `latest`: a moved dist-tag must not run new code in a job that goes on to hold a publish identity.
 */
const NPM_VERSION = "11.5.1";

/**
 * The release job: on every push to main it analyses the commits each package's own directory received since its last tag, and publishes the packages that changed, in dependency order, each with its own version, tag, changelog and GitHub Release (`pnpm release`, the same orchestrator the sibling repositories use).
 *
 * It checks the workspace before it releases, since a release workflow has no gate of its own to wait on. The `release` environment is bound to each package's npm trusted publisher, so the registry accepts a publish only from this workflow in that environment, and the environment admits only `main`.
 */
const release = defineJob("release", {
  name: "Release",
  description:
    "Publishes each package whose own directory changed since its last release, from conventional commit messages, with provenance through trusted publishing.",
  runsOn: [RUNNER],
  timeoutMinutes: TIMEOUT_MINUTES,
  environment: "release",
  permissions: {
    contents: "write",
    issues: "write",
    pullRequests: "write",
    identityToken: "write",
  },
  native: {
    "github-actions": {
      env: {
        GITHUB_TOKEN: "${{ secrets.GITHUB_TOKEN }}",
        NPM_CONFIG_PROVENANCE: "true",
        HUSKY: "0",
      },
    },
  },
  steps: [
    // Every package's release is analysed from its own last matching tag, so the whole history is fetched.
    { kind: "checkout", fetchDepth: "full" },
    ...SETUP_STEPS.slice(1),
    { kind: "run", name: "Upgrade npm", run: `npm install --global npm@${NPM_VERSION}` },
    { kind: "run", name: "Check", run: "pnpm run lint && pnpm run typecheck && pnpm run test" },
    { kind: "run", name: "Release", run: "pnpm release" },
  ],
});

export default definePipeline({
  name: "Release",
  description:
    "Releases from main with semantic-release, as the sibling repositories do. It is generated from this file like the others.",
  triggers: [{ kind: "push", branches: ["main"] }],
  permissions: { contents: "read" },
  concurrency: {
    group: "release",
    cancelInProgress: false,
    description:
      "Two pushes to main close together must never release at the same time: the orchestrator pushes its release commit and tags to main, and it refuses to publish when the remote holds a commit the checkout does not. A second run queues behind the first, because cancelling mid-release would leave a package published without its dependents' bumps.",
  },
  jobs: jobsOf(release),
});
