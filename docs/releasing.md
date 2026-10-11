# Releasing

Every push to `main` releases the packages whose own directory changed, with provenance, through npm trusted publishing. There is no tag to push and no token to store. It is the same arrangement as ExaDev's other monorepos: `@exadev/semantic-release-workspace` runs semantic-release once per package.

## What a push to main does

`.github/workflows/release.yml` (generated from `ci/release.pipeline.ts`) checks out the whole history, installs, runs lint, typecheck and the unit tests, and then runs `pnpm release`. For each package, in dependency order, the orchestrator:

1. reads the conventional commits that touched that package's directory since its last `@pipewright/<name>@<version>` tag;
2. chooses the next version from them (`feat` is minor, `fix` and every other accepted type is patch, a breaking change is major, as in `commit-types.ts`), and a package whose sibling dependency released gets a patch release;
3. writes the version, changelog and updated sibling ranges in one commit to `main`, tags each released package and publishes it with provenance, and creates a GitHub Release.

A package is published from its own directory by `npm publish`. Its `prepack` script (`scripts/prepack.ts`) builds `dist` and writes the manifest's `publishConfig` `exports` and `bin` over the source ones, and `postpack` puts the source manifest back, so the workspace keeps running from `src` and what is published runs from `dist`.

Commit messages are validated by commitlint against `commit-types.ts`, the same list the release reads, so a type cannot pass validation and then not release.

## Dependencies

Every dependency, third-party or sibling, is an exact pin in each package's manifest, and `pnpm run deps:lint` (part of `pnpm run lint`) fails when one dependency is pinned to two versions. A `catalog:` or `workspace:` specifier cannot be published by `npm publish`, and the orchestrator refuses it.

## What the owner does once

These are registry and repository settings, so they are a person's to apply.

1. Own the `@pipewright` scope on npm.
2. For each package, register the trusted publisher in its settings on npmjs.com: provider GitHub Actions, organisation `ExaDev`, repository `pipewright`, workflow `release.yml`, environment `release` (`npm-reserve @pipewright/<name> --trust ExaDev/pipewright --workflow release.yml --environment release` does this, and reserves the name first).
3. Keep the `release` GitHub environment's deployment branches limited to `main`. The job runs in it, so the registry accepts a publish only from this workflow on `main`.

Anything pushed to `main` after that releases. To start at a version other than 1.0.0, create a baseline tag `@pipewright/<name>@0.0.0` on the commit before the first release.

## Schemas

`$schema` in a JSON pipeline resolves to `@pipewright/pipeline-contract`'s `dist/pipeline.schema.json` (and `pipeline.authoring.schema.json`), served by unpkg. They are derived from the model by `pnpm run build` and are not committed.
