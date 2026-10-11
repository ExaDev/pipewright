import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { buildPackage } from "./build-package.ts";

/**
 * Runs as a package's `prepack` lifecycle script, which `npm publish` and `pnpm pack` both run before they read the manifest.
 *
 * The workspace runs from source, so each manifest's `exports` and `bin` point at `src`. A release publishes `dist`, and `npm publish` (which semantic-release uses) does not apply `publishConfig` the way pnpm does. This builds the package and writes `publishConfig`'s `exports` and `bin` over the manifest, after copying the original aside for `postpack.ts` to restore.
 */
const BACKUP = ".package.json.source";
const APPLIED = ["exports", "bin", "main", "types"] as const;

const directory = resolve(process.cwd());
const manifestPath = join(directory, "package.json");
const backupPath = join(directory, BACKUP);

// A previous run that was interrupted before `postpack` leaves the source manifest aside; put it back first so it is never lost or applied twice.
if (existsSync(backupPath)) renameSync(backupPath, manifestPath);

const parsed: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
if (typeof parsed !== "object" || parsed === null)
  throw new Error(`${manifestPath} is not an object`);
const manifest: Record<string, unknown> = { ...parsed };
const config = manifest.publishConfig;
if (typeof config !== "object" || config === null) {
  throw new Error(`${manifestPath} has no publishConfig to apply`);
}

buildPackage(directory);
copyFileSync(manifestPath, backupPath);
const published: Record<string, unknown> = { ...manifest };
for (const key of APPLIED) {
  if (key in config) {
    const value: unknown = Reflect.get(config, key);
    published[key] = value;
  }
}
writeFileSync(manifestPath, `${JSON.stringify(published, null, 2)}\n`);
