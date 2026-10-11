import { existsSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Runs as a package's `postpack` lifecycle script: puts back the source manifest that `prepack.ts` set aside, so the working tree is exactly what it was before the pack.
 */
const directory = resolve(process.cwd());
const backup = join(directory, ".package.json.source");
if (existsSync(backup)) renameSync(backup, join(directory, "package.json"));
