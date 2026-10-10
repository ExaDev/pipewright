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
          include: ["packages/*/test/**/*.integration.test.ts"],
          testTimeout: 60_000,
        },
      },
    ],
  },
});
