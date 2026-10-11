import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  pipelineAuthoringJsonSchema,
  pipelineJsonSchema,
} from "../packages/pipeline-contract/src/index.ts";

/**
 * Compiles one workspace package to its own `dist`: JavaScript and declarations, which is what gets published. The workspace itself runs from source, so this runs only for a release and for the check that a packed package installs.
 *
 * `rewriteRelativeImportExtensions` turns `./x.ts` into `./x.js` in the JavaScript. TypeScript leaves the extension in declarations, where a consumer that has not enabled `allowImportingTsExtensions` would reject it, so the declarations are rewritten here.
 */
const IMPORT_WITH_TS_EXTENSION = /(\bfrom\s+["']\.{1,2}\/[^"']*)\.ts(["'])/g;
const CONTRACT_PACKAGE = "pipeline-contract";

function declarationsIn(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);

    return statSync(path).isDirectory()
      ? declarationsIn(path)
      : path.endsWith(".d.ts")
        ? [path]
        : [];
  });
}

/** Builds the package at `directory` (an absolute path inside `packages/`). */
export function buildPackage(directory: string): void {
  rmSync(join(directory, "dist"), { recursive: true, force: true });
  execFileSync("pnpm", ["exec", "tsc", "-p", "tsconfig.build.json"], {
    cwd: directory,
    stdio: "inherit",
  });
  for (const file of declarationsIn(join(directory, "dist"))) {
    const text = readFileSync(file, "utf8");
    const rewritten = text.replace(IMPORT_WITH_TS_EXTENSION, "$1.js$2");
    if (rewritten !== text) writeFileSync(file, rewritten);
  }
  if (directory.endsWith(`/${CONTRACT_PACKAGE}`)) {
    // The JSON Schemas are derived from the model and shipped inside the contract package, which is where a document's `$schema` resolves once the package is published.
    const dist = join(directory, "dist");
    writeFileSync(
      join(dist, "pipeline.schema.json"),
      `${JSON.stringify(pipelineJsonSchema(), null, 2)}\n`,
    );
    writeFileSync(
      join(dist, "pipeline.authoring.schema.json"),
      `${JSON.stringify(pipelineAuthoringJsonSchema(), null, 2)}\n`,
    );
  }
}

if (import.meta.main) {
  const target = process.argv[2];
  if (target === undefined) throw new Error("expected the package directory to build");
  buildPackage(resolve(target));
}
