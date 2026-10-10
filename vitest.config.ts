import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["packages/*/test/**/*.unit.test.ts", "ci/**/*.unit.test.ts"],
        },
      },
      {
        // Reaches outside the repository: fetches each provider's published schema and runs the provider's own linter. A separate project so the unit suite stays offline and a failure here is never silently skipped.
        test: {
          name: "integration",
          include: ["packages/*/test/*.integration.test.ts"],
          testTimeout: 60_000,
        },
      },
      {
        // Drives Atlassian's validator page in a headless browser. Needs Google Chrome installed and the network.
        test: {
          name: "browser",
          include: ["packages/*/test/browser/*.integration.test.ts"],
          testTimeout: 120_000,
          hookTimeout: 120_000,
        },
      },
      {
        // Boots GitLab CE in a container and runs its own CI linter. Needs Docker and several minutes.
        test: {
          name: "container",
          include: ["packages/*/test/container/*.integration.test.ts"],
          testTimeout: 600_000,
          hookTimeout: 1_800_000,
        },
      },
      {
        // Executes an emitted workflow on GitHub through the platform adapter. It needs a token, a repository and a ref, runs only after a merge to main, and fails rather than skips when any is missing.
        test: {
          name: "e2e",
          include: ["packages/*/test/**/*.e2e.test.ts"],
          testTimeout: 700_000,
        },
      },
    ],
  },
});
