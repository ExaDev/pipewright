import type { ReleaseWorkspaceOptions } from "@exadev/semantic-release-workspace";
import { commitTypes } from "./commit-types.ts";

/**
 * Independent per-package releases through `@exadev/semantic-release-workspace`, invoked as `pnpm release`. Each publishable package gets its own version, `<name>@<version>` tag, CHANGELOG.md and GitHub Release, decided from the commits that touched its own directory, and a package is released after every sibling it depends on.
 *
 * The commit types and which of them release come from `commit-types.ts`, the same list `commitlint.config.ts` validates against, so a type cannot trigger a release without also passing commit-message validation, or the reverse.
 *
 * The orchestrator sets the tag format, plugins and analysis options on every per-package run itself, so a `release.config.*` inside a package would be overridden by construction: release configuration lives only in this file.
 *
 * `commitStrategy: "single"` folds every version bump, changelog and dependency-range rewrite of one run into one commit and pushes it with the tags atomically before anything publishes, so a rejected push leaves nothing half-released. It is why `@semantic-release/git` is absent from the plugin list: the orchestrator makes that commit itself and rejects the plugin in this mode.
 */

/**
 * Every commit type releases, at the level `commit-types.ts` names, and appears in the notes under its own section. commit-analyzer only falls back to its default rules, which include "a breaking change is a major release", when no custom rule matches a commit. A breaking `feat` matches `feat -> minor` here, so without this rule it would release as a minor version.
 */
const releaseRules = [
  { breaking: true, release: "major" },
  ...commitTypes.map((entry) => ({
    type: entry.type,
    release: entry.release,
  })),
];

/**
 * Every commit type gets its section name and is shown. The conventionalcommits preset hides docs, style, refactor, test, build, ci and chore by default, so `hidden: false` is stated for each type rather than left to that default: a release must never publish empty notes.
 */
const noteTypes = commitTypes.map((entry) => ({
  type: entry.type,
  section: entry.section,
  hidden: false,
}));

const config: Pick<
  ReleaseWorkspaceOptions,
  "branches" | "commitStrategy" | "plugins" | "analyzeCommits" | "generateNotes"
> = {
  branches: ["main"],
  commitStrategy: "single",
  plugins: [
    "@semantic-release/changelog",
    ["@semantic-release/npm", { npmPublish: true }],
    "@semantic-release/github",
  ],
  analyzeCommits: {
    preset: "conventionalcommits",
    releaseRules,
  },
  generateNotes: {
    preset: "conventionalcommits",
    presetConfig: { types: noteTypes },
  },
};

export default config;
