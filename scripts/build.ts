import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";

import { buildPackage } from "./build-package.ts";

/**
 * Compiles every workspace package to its own `dist`. See `build-package.ts`.
 */
const packages = resolve(import.meta.dirname, "..", "packages");
for (const name of readdirSync(packages)) buildPackage(join(packages, name));
