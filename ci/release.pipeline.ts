import { ACTIONS, SETUP_STEPS } from "./actions.ts";
import { defineJob, definePipeline, jobsOf } from "@pipewright/pipeline-contract";

const RUNNER = "ubuntu-latest";
const TIMEOUT_MINUTES = 30;

/**
 * npm's trusted publishing (OIDC) needs npm 11.5.1 or later, and the Node in `.tool-versions` ships an older one. Pinned, not `latest`: a moved dist-tag must not run new code in a job that goes on to hold a publish identity.
 */
const NPM_VERSION = "11.5.1";

/**
 * GitHub's published ed25519 host key for github.com, so the push over ssh verifies the server instead of trusting it on first use.
 * @see https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/githubs-ssh-key-fingerprints
 */
const GITHUB_HOST_KEY =
  "github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl";

/** The ssh command that uses only the deploy key and only the pinned host key, as written in the provisioning step. */
const SSH_COMMAND =
  "/usr/bin/ssh -i $RUNNER_TEMP/release-ssh/id -o IdentitiesOnly=yes -o UserKnownHostsFile=$RUNNER_TEMP/release-ssh/known_hosts -o StrictHostKeyChecking=yes";

/** The same command in a workflow expression context, where the runner's temp directory is `runner.temp`. */
const SSH_COMMAND_IN_EXPRESSION =
  "/usr/bin/ssh -i ${{ runner.temp }}/release-ssh/id -o IdentitiesOnly=yes -o UserKnownHostsFile=${{ runner.temp }}/release-ssh/known_hosts -o StrictHostKeyChecking=yes";

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
    {
      // `ref: main` because the orchestrator pushes to the current branch by name, so a detached HEAD stops the run, and the whole history because each package's release is analysed from its own last matching tag. No credential is persisted: the deploy key below is the push credential, so nothing is left in git config for later steps.
      kind: "provider",
      provider: "github-actions",
      native: {
        uses: ACTIONS.checkoutV7,
        with: { ref: "main", "fetch-depth": 0, "persist-credentials": false },
      },
    },
    ...SETUP_STEPS.slice(1),
    { kind: "run", name: "Upgrade npm", run: `npm install --global npm@${NPM_VERSION}` },
    { kind: "run", name: "Check", run: "pnpm run lint && pnpm run typecheck && pnpm run test" },
    {
      // The default repository token cannot bypass a ruleset, and GitHub does not allow naming it as a bypass actor, so the release commit and tags are pushed with a deploy key that is. The key is written here, to the runner's temp directory with mode 600 from the step's environment and never a command line, alongside GitHub's ed25519 host key, pinned so the connection is verified rather than trusted on first use. The probe pushes nothing: a dry run to a throwaway ref fails the job here if the key is wrong, instead of after the packages are versioned.
      kind: "provider",
      provider: "github-actions",
      native: {
        name: "Provision the deploy key",
        env: {
          RELEASE_DEPLOY_KEY: "${{ secrets.RELEASE_DEPLOY_KEY }}",
          // Blanked so a BASH_ENV exported by an earlier step cannot run in the shell that holds the key.
          BASH_ENV: "",
        },
        run: [
          'install -d -m 700 "$RUNNER_TEMP/release-ssh"',
          "(umask 077 && printf '%s\\n' \"${RELEASE_DEPLOY_KEY%$'\\n'}\" > \"$RUNNER_TEMP/release-ssh/id\")",
          `printf '%s\\n' '${GITHUB_HOST_KEY}' > "$RUNNER_TEMP/release-ssh/known_hosts"`,
          `GIT_SSH_COMMAND="${SSH_COMMAND}" /usr/bin/git push --dry-run --no-verify "git@github.com:$GITHUB_REPOSITORY.git" "HEAD:refs/heads/release-key-probe-$GITHUB_RUN_ID"`,
        ].join("\n"),
      },
    },
    {
      // The repository token goes only to this step, for the GitHub API (releases and comments), never for git. The orchestrator pushes with a plain `git push` to the checkout's https origin, so git's own per-process configuration rewrites that URL to ssh for this one command, and the npm tokens are blanked so an inherited one cannot win over the OIDC exchange.
      kind: "provider",
      provider: "github-actions",
      native: {
        name: "Release",
        run: "pnpm release",
        env: {
          GITHUB_TOKEN: "${{ secrets.GITHUB_TOKEN }}",
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: "url.git@github.com:.insteadOf",
          GIT_CONFIG_VALUE_0: "https://github.com/",
          GIT_SSH_COMMAND: SSH_COMMAND_IN_EXPRESSION,
          NPM_CONFIG_PROVENANCE: "true",
          NPM_TOKEN: "",
          NODE_AUTH_TOKEN: "",
          HUSKY: "0",
        },
      },
    },
    {
      kind: "provider",
      provider: "github-actions",
      native: {
        name: "Remove the deploy key",
        if: "always()",
        run: 'rm -rf "$RUNNER_TEMP/release-ssh"',
      },
    },
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
