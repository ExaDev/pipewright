# Releasing

A release publishes every workspace package under the `@pipewright` scope from one tag, with provenance, through npm trusted publishing. No registry token is stored anywhere.

## What a tag does

Pushing a tag `vMAJOR.MINOR.PATCH` runs `.github/workflows/release.yml`. It installs, runs lint, typecheck and the unit tests, stamps the tag's version onto every package and each dependency on a sibling (`scripts/set-version.ts`), builds `dist` (`pnpm run build`), packs and installs the tarballs into an empty directory (`pnpm run test:pack`), and then publishes each tarball with `npm publish --provenance`. The working tree always carries `0.0.0`; the version exists only in the build that is published.

Packages are packed with pnpm before publishing, because pnpm applies each manifest's `publishConfig` (the `dist` exports and the `pipewright` binary), which `npm publish` of a directory does not.

## What the owner does

These are registry settings, so they are done by a person and never by the workflow or an agent.

1. Own the `@pipewright` scope on npm (an organisation of that name).
2. For each package, add a trusted publisher in the package's settings on npmjs.com: provider GitHub Actions, organisation `ExaDev`, repository `pipewright`, workflow `release.yml`, no environment. A package must exist on the registry before its settings page does, so the first version of each is published once by hand (`npm publish --access public` from a packed tarball while logged in), after which every later release is the tag.
3. Push the tag: `git tag v0.1.0 && git push origin v0.1.0`.

## Schemas

`$schema` in a JSON pipeline resolves to `@pipewright/pipeline-contract`'s `dist/pipeline.schema.json` (and `pipeline.authoring.schema.json`), served by unpkg. They are derived from the model by `pnpm run build` and are not committed.
