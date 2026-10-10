import type { StepInput } from "@pipewright/pipeline-contract";

/**
 * Third-party actions pinned to a commit, because a tag is a mutable reference and every job that uses these holds a token. The tag each commit was resolved from is in the name.
 */
export const ACTIONS = {
  pnpmSetupV6: "pnpm/action-setup@0977fd99725f1db4007ccb2928dbb4e90d06cc86",
  setupNodeV7: "actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1",
} as const;

/**
 * The steps every job starts with. Installing is native in every job: in a wrapper job the tool itself cannot run until the workspace has resolved its own packages.
 */
export const SETUP_STEPS: readonly StepInput[] = [
  { kind: "checkout" },
  { kind: "provider", provider: "github-actions", native: { uses: ACTIONS.pnpmSetupV6 } },
  {
    kind: "provider",
    provider: "github-actions",
    native: {
      uses: ACTIONS.setupNodeV7,
      with: { "node-version-file": ".tool-versions", cache: "pnpm" },
    },
  },
  { kind: "run", name: "Install", run: "pnpm install --frozen-lockfile", form: "native" },
];
