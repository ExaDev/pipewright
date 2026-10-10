import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Compiles every workspace package to its own `dist`: JavaScript and declarations, which is what gets published. The workspace itself runs from source, so this is only for a release and for the check that a packed package installs.
 *
 * `rewriteRelativeImportExtensions` turns `./x.ts` into `./x.js` in the JavaScript. TypeScript leaves the extension in declarations, where a consumer that has not enabled `allowImportingTsExtensions` would reject it, so the declarations are rewritten here.
 */
const root = resolve(import.meta.dirname, "..");
const packagesDirectory = join(root, "packages");
const IMPORT_WITH_TS_EXTENSION = /(\bfrom\s+["']\.{1,2}\/[^"']*)\.ts(["'])/g;

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

for (const name of readdirSync(packagesDirectory)) {
  const directory = join(packagesDirectory, name);
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
}
