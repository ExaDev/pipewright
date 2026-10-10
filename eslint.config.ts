import { exadevConfig } from "@exadev/eslint-config";
import { defineConfig } from "eslint/config";
import eslintPluginPrettierRecommended from "eslint-plugin-prettier/recommended";
import globals from "globals";

/**
 * One configuration for the whole workspace. Packages are source-only members of a single TypeScript program, so type-aware rules resolve every file through the root tsconfig rather than one per package.
 */
export default defineConfig(
  ...exadevConfig(),
  {
    ignores: [
      "node_modules",
      "coverage",
      "pnpm-lock.yaml",
      // Generated: the workflow, and the schemas the CLI derives from the model. Both are verified by the drift job instead of formatted here.
      ".github/workflows/ci.yml",
      "schemas",
      // Golden files are the exact bytes an adapter must emit.
      "packages/*/test/golden",
    ],
  },
  {
    files: ["**/*.ts"],
    languageOptions: {
      parserOptions: {
        project: ["./tsconfig.json"],
        tsconfigRootDir: import.meta.dirname,
      },
      globals: { ...globals.node },
    },
  },
  {
    files: ["**/*.ts"],
    rules: {
      "@typescript-eslint/consistent-type-imports": ["error", { fixStyle: "inline-type-imports" }],
    },
  },
  eslintPluginPrettierRecommended,
  {
    // json-canonical is the JSON formatter here, and it disagrees with Prettier about array layout, so letting both fix a file makes them undo each other.
    files: ["**/*.json"],
    rules: { "prettier/prettier": "off" },
  },
);
