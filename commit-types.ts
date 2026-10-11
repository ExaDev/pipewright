/**
 * The single source of truth for which Conventional Commit types this workspace accepts, and which release level each one triggers; every type releases, so no change to a package can go unpublished. Both `commitlint.config.ts` and `release-workspace.config.ts` import this file so a commit type can never trigger a release without also passing commit-message validation, or the reverse. One definition, not two that could drift apart.
 */
export interface CommitTypeDefinition {
  readonly type: string;
  readonly section: string;
  readonly release: "patch" | "minor";
}

export const commitTypes: readonly CommitTypeDefinition[] = [
  { type: "feat", section: "Features", release: "minor" },
  { type: "fix", section: "Bug Fixes", release: "patch" },
  { type: "perf", section: "Performance Improvements", release: "patch" },
  { type: "revert", section: "Reverts", release: "patch" },
  { type: "docs", section: "Documentation", release: "patch" },
  { type: "style", section: "Styles", release: "patch" },
  { type: "refactor", section: "Code Refactoring", release: "patch" },
  { type: "test", section: "Tests", release: "patch" },
  { type: "build", section: "Build System", release: "patch" },
  { type: "ci", section: "Continuous Integration", release: "patch" },
  { type: "chore", section: "Chores", release: "patch" },
];

export const commitTypeNames: readonly string[] = commitTypes.map((entry) => entry.type);
