import type { RcFile } from "syncpack";

/**
 * Exact pins everywhere, third-party and sibling dependencies alike, as the sibling repositories do, and one version of each dependency across the workspace. A published manifest has to carry installable versions, so the single definition a `catalog:` entry gave is kept by `syncpack lint` instead: it fails when two packages pin the same dependency differently, which is what split `zod`'s `instanceof` checks across package boundaries before the catalog.
 */
const config: RcFile = {
  semverGroups: [
    {
      label: "exact versions everywhere",
      dependencies: ["**"],
      dependencyTypes: ["prod", "dev"],
      range: "",
    },
  ],
};

export default config;
