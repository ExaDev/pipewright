# pipewright

Write a CI pipeline once, in TypeScript, and use it however the provider allows: compile it to the provider's native configuration, run it directly with no generated file, or query the platform it ran on. The three are separate and none needs the others.

The repository name is `pipewright`. An unrelated tool of the same name exists (see [`docs/research.md`](docs/research.md)), so the name is a working one.

## Why

A workflow file mixes two things. The orchestration (triggers, job graph, matrix, runners, permissions) is specific to a provider. The logic, the shell in each step, usually is not. This repository models the orchestration as data and leaves the logic in your scripts, so a pipeline can be moved between providers, checked, composed and executed like any other data.

## Ways to use it

**Emit native files.** `emit` compiles a pipeline to the provider's own syntax. `check` fails when a committed file no longer matches what the tool would write. Use this where the provider must read orchestration from the repository.

**Run directly.** `run` executes the pipeline through an in-process runner that asks an injected executor to run each command. Nothing is generated. A single job, a step range or one matrix combination can be run alone.

**Query the platform.** A separate read-only contract lists runs, checks, logs and the checks a branch requires. It does not depend on the pipeline model.

## Authoring

A pipeline is a TypeScript module whose default export comes from `definePipeline`. The type is the model's input type, so an editor completes and checks it, and composition is ordinary TypeScript: functions, spreads and shared constants.

References are values, not strings. `context.sha` and the `axes` a `matrixJob` callback receives are typed, so a misspelt name is a compile error, and `needs` takes the job handles that `defineJob` returns, so a dependency on a job that does not exist is an undefined variable and a cycle cannot be written. ``t`ci-${context.refName}` `` builds a string from references, and `when.event`, `when.equals` and `when.oneOf` build conditions. The model stores the `{{ name }}` token text, which is what a JSON document writes by hand.

```ts
import {
  context,
  defineJob,
  definePipeline,
  jobsOf,
  matrixJob,
} from "@ci-adapters/pipeline-contract";

const lint = defineJob("lint", {
  name: "Lint",
  runsOn: ["ubuntu-latest"],
  steps: [{ kind: "checkout" }, { kind: "run", run: "pnpm run lint" }],
});

const test = defineJob(
  "test",
  matrixJob({ node: ["22", "24"] }, (axes) => ({
    name: "Test",
    runsOn: ["ubuntu-latest"],
    needs: [lint],
    env: { NODE_VERSION: axes.node, COMMIT: context.sha },
    steps: [{ kind: "checkout" }, { kind: "run", run: "pnpm test" }],
  })),
);

export default definePipeline({
  name: "CI",
  triggers: [{ kind: "push", branches: ["main"] }, { kind: "pullRequest" }],
  jobs: jobsOf(lint, test),
});
```

[`ci/ci.pipeline.ts`](ci/ci.pipeline.ts) is this repository's own pipeline and is the fuller example.

JSON is an alternative way to write the same model, and its serialisation. `export` prints any pipeline, whichever format it was written in, as a JSON document, and loading that document gives the same model back; a test holds this repository's own pipeline to that. [`examples/basic.pipeline.json`](examples/basic.pipeline.json) is a pipeline authored directly as JSON.

JSON has no functions, so a JSON document composes with two mechanisms a TypeScript module does not need, provided by [`@exadev/json-compose`](https://github.com/ExaDev/json-compose):

- `extends` pulls in fragments by relative path, in order, with the document's own content applied last. Objects deep-merge, `steps` arrays concatenate, every other array and scalar is replaced, and `{"$replace": ...}` replaces an inherited value outright.
- Typed `parameters` are supplied by the extending document's `with`, and `{"$param": "name"}` is replaced by the value. A load error names the source file and JSON pointer of the offending node, including across `extends`.

Every JSON document declares `$schema`, pointing at the JSON Schema the CLI derives from the model, so an editor can complete and validate it with no tooling installed. JSON has no comments, so every node takes an optional `description`, which emitters write into the generated file as a comment; a TypeScript module can use it the same way.

Conditions are [trilean](https://github.com/ExaDev/trilean) predicate trees. Each adapter compiles the subset its provider can express with the same meaning and rejects the rest, naming the node.

## Providers

| Provider | Output | Wrapper form |
| --- | --- | --- |
| GitHub Actions | `.github/workflows/<name>.yml` | yes |
| GitLab CI | `.gitlab-ci.yml` | yes |
| Bitbucket Pipelines | `bitbucket-pipelines.yml` | yes |
| CircleCI | `.circleci/config.yml` | yes |

[`docs/providers.md`](docs/providers.md) has the support matrix and the semantics every adapter shares.
An adapter never drops or approximates something it cannot express. It throws `UnsupportedFeatureError` carrying the JSON pointer of the node: a schedule trigger on GitLab, where schedules are project settings, or a matrix reference in a job-level condition on GitHub, which evaluates it before the matrix expands.

### Native and wrapper forms

A pipeline or a job can set `form: "wrapper"`. Orchestration (triggers, `needs`, matrix, runners, permissions, conditions) stays native, and each contiguous run of portable steps collapses into one call to this tool's runner for exactly those step indexes. Editing step logic then changes no generated file. The cost is that the provider's UI and linters no longer see those steps. A run step with `form: "native"` stays in the provider's syntax, which is how an install step can run before the tool exists.

## Command line

```sh
node packages/cli/src/bin.ts emit --pipeline ci/ci.pipeline.ts --provider github-actions
node packages/cli/src/bin.ts check --pipeline ci/ci.pipeline.ts --provider github-actions
node packages/cli/src/bin.ts run --pipeline ci/ci.pipeline.ts --local --skip-provider-steps --job lint
node packages/cli/src/bin.ts export --pipeline ci/ci.pipeline.ts --schema ../schemas/pipeline.schema.json
node packages/cli/src/bin.ts schema --authoring
node packages/cli/src/bin.ts check-names --pipeline ci/ci.pipeline.ts --provider github-actions --scope gates
node packages/cli/src/bin.ts platform runs --repo OWNER/REPO --sha SHA
```

`--pipeline` takes a `.ts` module or a `.json` document. `run` takes its context (event, ref, sha and so on) from the environment when it detects GitHub Actions or GitLab CI, or from `--context key=value`. A missing value is an error, not a guess. `--local` supplies the context of a manual run on a branch called `local`.

Platform commands read the token from `GH_TOKEN`; the adapter reads no files or other variables for it.

## Layout

```
packages/
  pipeline-contract         model, loaders, JSON Schema, predicate compiler, conformance kits, reference fake
  pipeline-github-actions   compiler
  pipeline-gitlab-ci        compiler
  pipeline-bitbucket        compiler
  pipeline-circleci         compiler
  pipeline-local            in-process runner
  platform-contract         read and control interfaces, reference fake, conformance kit, wait helper
  platform-github           read-only reader, controller, Zod codecs for the wire format
  check-names               required check names derived from a pipeline
  pipeline-graph            a pipeline as a process-graph model, and run state as its overlay
  yaml-emit                 deterministic YAML with comments
  cli                       composition root
ci/                         this repository's own pipeline definition, in TypeScript
examples/                   a pipeline authored as JSON
schemas/                    JSON Schemas derived from the model
```

Research and sources are in [`docs/research.md`](docs/research.md).

The structure is one contract package per concern with adapters beside it. Each contract ships a reference fake and a conformance kit that every adapter runs, so adapters cannot drift from the spec. The pipeline half and the platform half share nothing; `check-names` and `pipeline-graph` are the only packages that import both.

## Development

```sh
pnpm install
pnpm run lint
pnpm run typecheck
pnpm run test               # unit tests, offline
pnpm run test:integration   # each provider's own validator over the emitted sample
pnpm run ci:local   # this repository's own pipeline, through its own runner
pnpm run ci:check   # fails if the generated workflow has drifted
pnpm run schema     # regenerate the JSON Schemas
```

Packages are source-only workspace members run through Node's type stripping, so there is no build step. Node 22.18 or later.

### This repository uses itself

`.github/workflows/ci.yml` is generated from `ci/ci.pipeline.ts` and is not edited by hand. A job fails if it, or either JSON Schema, differs from what the tool emits. The test job renders in the wrapper form, so CI runs the tests through this tool's own runner, one job reads its own run back through the platform adapter, and the pre-push hook runs the same pipeline locally.

The generated workflow and the schemas are committed because the provider and editors read them from the repository. The drift check is what keeps them honest.

## Constraints

- Text equality in conditions is case-insensitive, because GitHub's `==` cannot be made case-sensitive. A provider whose `==` is case-sensitive renders a case-insensitive comparison instead.
- Required-check comparison needs rulesets, which the GitHub API refuses for a private repository on a free organisation plan. The adapter surfaces the 403.
- This tool never applies a ruleset, secret or settings change. It computes a plan and a person applies it.
