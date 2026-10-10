import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

/**
 * Packs every workspace package as a release would, installs the tarballs into an empty directory, and uses them from there. A package whose `dist`, `exports` or dependency list is wrong passes every test that runs from source and fails here, before a tag publishes it.
 */
const root = resolve(import.meta.dirname, "../../../..");
let project = "";

/** Building every package, packing it and installing the tarballs with their third-party dependencies, which takes a registry round trip for each. */
const SETUP_TIMEOUT_MS = 600_000;

function run(command: string, args: readonly string[], cwd: string): string {
  return execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

beforeAll(() => {
  run("node", ["scripts/build.ts"], root);
  const tarballs = mkdtempSync(join(tmpdir(), "pipewright-pack-"));
  project = mkdtempSync(join(tmpdir(), "pipewright-install-"));
  const overrides: Record<string, string> = {};
  for (const name of readdirSync(join(root, "packages"))) {
    const directory = join(root, "packages", name);
    const manifest: unknown = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
    if (typeof manifest !== "object" || manifest === null || !("name" in manifest)) continue;
    run("pnpm", ["pack", "--pack-destination", tarballs], directory);
    const file = readdirSync(tarballs).find((entry) => entry.startsWith(`pipewright-${name}-`));
    if (file === undefined) throw new Error(`no tarball was packed for ${name}`);
    overrides[`@pipewright/${name}`] = `file:${join(tarballs, file)}`;
  }
  writeFileSync(
    join(project, "package.json"),
    JSON.stringify({
      name: "consumer",
      private: true,
      type: "module",
      dependencies: overrides,
      overrides,
    }),
  );
  mkdirSync(join(project, "ci"));
  run("npm", ["install", "--no-audit", "--no-fund"], project);
}, SETUP_TIMEOUT_MS);

describe("packed packages", () => {
  it("resolves the contract's authoring surface from dist", () => {
    const output = run(
      "node",
      [
        "--input-type=module",
        "-e",
        'import { definePipeline } from "@pipewright/pipeline-contract"; console.log(typeof definePipeline);',
      ],
      project,
    );

    expect(output.trim()).toBe("function");
  });

  it("ships the JSON Schemas inside the contract, where a document's $schema resolves", () => {
    for (const name of ["pipeline.schema.json", "pipeline.authoring.schema.json"]) {
      const file = join(project, "node_modules", "@pipewright", "pipeline-contract", "dist", name);
      const schema: unknown = JSON.parse(readFileSync(file, "utf8"));

      expect(schema).toMatchObject({ type: "object" });
    }
  });

  it("runs the pipewright binary, which prints the JSON Schema", () => {
    const output = run(join(project, "node_modules", ".bin", "pipewright"), ["schema"], project);

    expect(JSON.parse(output)).toMatchObject({ type: "object" });
  });

  it("emits a workflow from a pipeline module the consumer wrote", () => {
    writeFileSync(
      join(project, "ci", "ci.pipeline.ts"),
      'import { definePipeline } from "@pipewright/pipeline-contract";\nexport default definePipeline({ name: "CI", triggers: [{ kind: "push" }], jobs: { lint: { name: "Lint", runsOn: ["ubuntu-latest"], steps: [{ kind: "run", run: "true" }] } } });\n',
    );
    const output = run(
      join(project, "node_modules", ".bin", "pipewright"),
      ["emit", "--pipeline", "ci/ci.pipeline.ts", "--provider", "github-actions"],
      project,
    );

    expect(output).toContain("wrote .github/workflows/ci.yml");
  });
});
