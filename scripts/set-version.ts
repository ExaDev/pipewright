import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Sets the version of every workspace package, and of each dependency on a sibling package, to the one a release publishes. Versions are not committed by hand: the working tree carries `0.0.0` and a release stamps the tag's version for the build it publishes.
 *
 * Usage: `node scripts/set-version.ts 1.2.3 [root]`, where `root` is the workspace to stamp and defaults to this repository.
 */
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const SCOPE = "@pipewright/";

const version = process.argv[2];
if (version === undefined || !SEMVER.test(version)) {
  throw new Error(`expected a semantic version such as 1.2.3, got ${String(version)}`);
}

const packages = resolve(process.argv[3] ?? join(import.meta.dirname, ".."), "packages");
for (const name of readdirSync(packages)) {
  const file = join(packages, name, "package.json");
  const manifest: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (typeof manifest !== "object" || manifest === null)
    throw new Error(`${file} is not an object`);
  const updated: Record<string, unknown> = { ...manifest, version };
  for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
    const entries: unknown = updated[field];
    if (typeof entries !== "object" || entries === null) continue;
    updated[field] = Object.fromEntries(
      Object.entries(entries).map(([dependency, range]) => [
        dependency,
        dependency.startsWith(SCOPE) ? version : range,
      ]),
    );
  }
  writeFileSync(file, `${JSON.stringify(updated, null, 2)}\n`);
}
