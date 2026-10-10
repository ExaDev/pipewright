# Research

What was checked before and while building this, with sources. Each source is given as the original URL and a Wayback Machine capture. Where a capture has a timestamp it was looked up; where the link is the `web.archive.org/web/<url>` form it resolves to the latest capture and was not individually verified to exist.

## Prior art

### Dagger

A container-based DAG execution engine with SDKs in several languages. It is a step inside a provider's workflow, not a model of the workflow.

- The introduction describes "a portable DAG execution engine" that decouples pipeline logic from its environment. The DAG is the function and check graph inside the engine, not a provider-level job graph. [docs.dagger.io/getting-started/introduction](https://docs.dagger.io/getting-started/introduction) ([capture](https://web.archive.org/web/20260828182129/https://docs.dagger.io/getting-started/introduction/))
- `dagger.toml` has keys for modules, SDKs, ports, ignore and per-module settings. It has none for triggers, matrix, permissions, environments, concurrency or OIDC. [reference](https://docs.dagger.io/reference/config-files/dagger-toml) ([nearest capture](https://web.archive.org/web/20260930084323/https://docs.dagger.io/llms-full.txt))
- In CI the integration is `dagger check` as a step in a workflow the author writes. [using/checking](https://docs.dagger.io/using/checking)
- Cloud Checks runs checks on a push or pull request with no workflow file, on Dagger's hosted engines, for GitHub repositories only. [cloud-checks](https://docs.dagger.io/next/cloud-checks) ([latest capture](https://web.archive.org/web/https://docs.dagger.io/next/cloud-checks))
- A container runtime is needed to run a pipeline; a remote engine is selected with `--engine`. The docs are silent on macOS runners and on runners with no Docker. [installation](https://docs.dagger.io/0.21/getting-started/installation/) ([capture](https://web.archive.org/web/20260828181935/https://docs.dagger.io/0.21/getting-started/installation/)), [CLI reference](https://docs.dagger.io/reference/cli) ([capture](https://web.archive.org/web/20260811213315/https://docs.dagger.io/reference/cli/))
- The GitLab and Azure integration pages describe Dagger Functions replacing the YAML pipeline, with the user still writing the provider file. [GitLab](https://docs.dagger.io/0.21/getting-started/ci-integrations/gitlab-ci/), [Azure](https://docs.dagger.io/0.21/getting-started/ci-integrations/azure-pipelines/)

The two docs sets, 1.0-beta and 0.21, differ, and several integration pages have no capture.

What this repository adds that Dagger does not: a typed model of provider orchestration compiled to native files, steps that run natively with no container engine, pipelines as data that other tooling can compare against rulesets, and no hosted dependency. What it does not attempt: container isolation, content-addressed caching and tracing.

### Pipewright (zero-objects)

An unrelated Rust tool of the same name, found while naming this one. It parses 17 platforms' pipeline definitions into one neutral graph and can inspect, render, run locally in Docker and migrate between them. [repository](https://github.com/zero-objects/Pipewright) ([latest capture](https://web.archive.org/web/https://github.com/zero-objects/Pipewright))

It starts from existing files and translates between them. This repository starts from an authored model and compiles outwards, has typed authoring, and has a separate contract for operating the platform. Its capability profile and friction report (how portable a given pipeline is) is a good idea; the guards here report the same thing per adapter as `UnsupportedFeatureError`, one node at a time, and a portability summary is not built.

The name collision is why the README calls the name a working one.

### CDK for Terraform

TypeScript constructs synthesised into declarative Terraform JSON (`cdktf.out`, one folder per stack), never interacting with the target at synthesis time. `cdktf diff` is synthesis followed by `terraform plan`, which is the same shape as `emit` and `check`. It was archived on 10 December 2025 for lack of product-market fit and its prebuilt provider bindings stopped being published. [repository](https://github.com/hashicorp/terraform-cdk) ([latest capture](https://web.archive.org/web/https://github.com/hashicorp/terraform-cdk)), [Pulumi's account](https://www.pulumi.com/blog/cdktf-is-deprecated-whats-next-for-your-team/) ([latest capture](https://web.archive.org/web/https://www.pulumi.com/blog/cdktf-is-deprecated-whats-next-for-your-team/)), [stacks](https://developer.hashicorp.com/terraform/cdktf/concepts/stacks)

What carries over:

- The cost of generating and maintaining a typed binding for every provider's schema is what this model avoids by staying small and neutral, with a provider-tagged escape hatch for the rest.
- An exit ramp to the native format was cdktf's `synth --hcl`. Here it is built in: the output is already native workflow files, so removing the tool leaves valid workflows.
- cdktf treated its output directory as disposable. This tool commits the generated file because the provider reads it from the repository, and a drift check keeps it honest.

A community fork, CDK Terrain, exists. Nothing here depends on its future.

### Cloudflare Workflows

Code-first durable execution: a class with `run(event, step)` and `step.do`, `sleep` and `waitForEvent`. Only the binding is declarative. Relayed from the Cloudflare documentation search tool and not re-read for this document, so the links below need a capture check before being relied on. [workers API](https://developers.cloudflare.com/workflows/build/workers-api/), [rules](https://developers.cloudflare.com/workflows/build/rules-of-workflows/), [sleeping and retrying](https://developers.cloudflare.com/workflows/build/sleeping-and-retrying/), [triggering](https://developers.cloudflare.com/workflows/build/trigger-workflows/)

What it informed:

- A declarative header over an imperative body is a shared shape with Claude Code's workflow scripts. This model sits at the declarative end because its targets accept only declarative configuration.
- Deterministic, human-assigned names are cache keys there. Job ids here are human-assigned and never generated, because required-check names, drift checks and re-run mapping key off them.
- Per-step retry and timeout as typed data, a failure or `finally` concept and manual approval gates are good neutral concepts. They are not built (see below).

### Claude Code workflows

A JavaScript script with a pure-literal `meta` header and an executable body, using `agent`, `pipeline` and `parallel`, with deterministic replay on resume. Described in the workflow authoring reference loaded in the session that built this, which has no public URL.

### Turborepo and task graphs

Compatible and not replaced: a `run` step invokes `turbo run` unchanged. Turborepo's value is below the job (package graph, input hashing, output caching, affected detection) and a provider-neutral cache declaration is the part that belongs at the CI layer. That work is tracked in the repository's issue 1 and its sub-issues, with an explicit decision point on whether to own an executor or delegate to Turborepo or Nx.

### oRPC

A contract package for the platform half would let one definition serve in-process and remote use (a machine without credentials asking one that holds the token). Established from the installed `@orpc/server` and `@orpc/client` 2.0.0-beta.35 in `agent-comms`: the in-process client is `createRouterClient(router, options)` and remote clients come from `createORPCClient(link)`. Not built, because nothing here needs a remote consumer. Revisit when something must read platform state from a machine that must not hold the credential. [define a contract](https://orpc.unnoq.com/docs/contract-first/define-contract), [implement a contract](https://orpc.unnoq.com/docs/contract-first/implement-contract)

### Zod codecs

Used for the platform wire format only: GitHub's snake_case fields and status strings decode into the contract's `Run` and `Check` and encode back, so the simulated API in the tests produces its responses through the encode direction of the definition the adapter decodes with. Also used for template strings, which accept a typed reference where the model stores a token. Not used for pipeline loading, which merges files and substitutes parameters and so is a function, not a per-value transform. [zod.dev/codecs](https://zod.dev/codecs)

### trilean

Conditions are predicate trees from the ExaDev `trilean` package: serialisable JSON, evaluated through injected resolvers, with a compiler for SQL as precedent for compiling the same tree to a provider's language with a guard that rejects what the target cannot express. Provider expression languages are not three-valued and coerce a missing value differently, so each adapter accepts only the constructs whose result cannot differ and rejects the rest. [package](https://github.com/ExaDev/trilean)

## Provider references

| Provider | Syntax reference | Schema or validator |
| --- | --- | --- |
| GitHub Actions | [workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax) ([capture](https://web.archive.org/web/20261006081840/https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax)) | [actionlint](https://github.com/rhysd/actionlint) ([capture](https://web.archive.org/web/20260914140117/https://github.com/rhysd/actionlint)); SchemaStore's [github-workflow](https://www.schemastore.org/github-workflow.json) ([capture](https://web.archive.org/web/20260922191651/https://www.schemastore.org/github-workflow.json)), a community schema, since no official one was found |
| GitLab CI | [CI/CD YAML reference](https://docs.gitlab.com/ci/yaml/) ([capture](https://web.archive.org/web/20261006105226/https://docs.gitlab.com/ci/yaml/)) | [ci.json in the GitLab repository](https://gitlab.com/gitlab-org/gitlab/-/raw/master/app/assets/javascripts/editor/schema/ci.json) ([capture](https://web.archive.org/web/20260916193933/https://gitlab.com/gitlab-org/gitlab/-/raw/master/app/assets/javascripts/editor/schema/ci.json)) |
| Bitbucket Pipelines | [step options](https://support.atlassian.com/bitbucket-cloud/docs/step-options/) ([capture](https://web.archive.org/web/20261006033332/https://support.atlassian.com/bitbucket-cloud/docs/step-options/)), [triggers](https://support.atlassian.com/bitbucket-cloud/docs/pipeline-triggers/) ([capture](https://web.archive.org/web/20260810100857/https://support.atlassian.com/bitbucket-cloud/docs/pipeline-triggers/)), [start conditions](https://support.atlassian.com/bitbucket-cloud/docs/pipeline-start-conditions/) ([capture](https://web.archive.org/web/20260706005854/https://support.atlassian.com/bitbucket-cloud/docs/pipeline-start-conditions/)), [expression language](https://support.atlassian.com/bitbucket-cloud/docs/expression-language/) ([capture](https://web.archive.org/web/20260907112413/https://support.atlassian.com/bitbucket-cloud/docs/expression-language/)) | [pipelines-configuration schema](https://api.bitbucket.org/schemas/pipelines-configuration) ([capture](https://web.archive.org/web/20260313004040/https://api.bitbucket.org/schemas/pipelines-configuration)); a [web validator](https://bitbucket.org/product/pipelines/validator) with no documented CLI |
| CircleCI | [configuration reference](https://circleci.com/docs/reference/configuration-reference/) ([capture](https://web.archive.org/web/20260929010958/https://circleci.com/docs/reference/configuration-reference/)), [triggers](https://circleci.com/docs/guides/orchestrate/triggers-overview/) ([capture](https://web.archive.org/web/20261006165936/https://circleci.com/docs/guides/orchestrate/triggers-overview/)), [schedule triggers](https://circleci.com/docs/guides/orchestrate/schedule-triggers/) ([capture](https://web.archive.org/web/20260411203954/https://circleci.com/docs/guides/orchestrate/schedule-triggers/)) | `circleci config validate` ([CLI reference](https://cli.circleci.com/reference/), [capture](https://web.archive.org/web/20260909170614/https://cli.circleci.com/reference/)); the [published schema](https://raw.githubusercontent.com/CircleCI-Public/circleci-yaml-language-server/refs/heads/main/schema.json) ([capture](https://web.archive.org/web/20261006224831/https://raw.githubusercontent.com/CircleCI-Public/circleci-yaml-language-server/refs/heads/main/schema.json)) |

## Things established by running them

- **Rulesets are unavailable to this repository.** The rules endpoint answers 403 with "Upgrade to GitHub Pro or make this repository public" for a private repository on a free organisation plan. A required-check comparison therefore cannot run against it, and the self-hosting pipeline reads its own run back instead.
- **A pull request's workflow commit is the merge commit.** No run reports it as its head, so listing runs by `github.sha` finds nothing on a pull request. The head is `github.event.pull_request.head.sha`.
- **The tool cannot run before its dependencies are installed.** A wrapper job's runner invocation absorbed the install step and failed to resolve the workspace's own packages. The install step is marked native.
- **GitHub counts a job skipped because a dependency failed as successful**, and a skipped job does not block a required check. A gate job therefore runs regardless and fails explicitly. [using conditions to control job execution](https://docs.github.com/en/actions/using-jobs/using-conditions-to-control-job-execution)
- **Bitbucket's published schema rejects a `final` step in a custom pipeline, and Atlassian's validator accepts one**, as the step-options page documents. The validator page validates in the browser with its own logic (its bundle embeds no JSON Schema), so the schema lags the product; the adapter follows the validator.
- **`typescript-eslint` cannot load TypeScript 7**, the native compiler, so the repository stays on the 6 line.
- **GitLab's `==` is case-sensitive, GitHub's is not**, and Bitbucket's is case-sensitive with no case-insensitive form, which is why the neutral equality is case-insensitive and Bitbucket accepts no conditions.

## Not verified

- Cloudflare Workflows pages were relayed, not re-read here, and need a capture check.
- CircleCI's matrix job naming with a templated `name` and an `alias` is taken from the configuration reference and accepted by the published schema, but was not run on CircleCI. Bitbucket and GitLab emitted files are validated against their schemas and not run on those providers.
- `circleci config validate` and Bitbucket's web validator were not run; the published schemas stand in for them.
- The GitHub schema from SchemaStore is community-maintained; actionlint is the validator run.
- Turborepo's current feature set was not read; the compatibility answer rests on a sibling repository's `turbo.json` and workflow.

## Considered and not built

- A provider-neutral cache declaration compiled per provider (issue 1 and its sub-issues).
- Per-step retry and timeout as typed data, and a failure or `finally` concept.
- Manual approval gates (protected environments, manual jobs).
- A portability report in the style of Pipewright's capability profile.
- An oRPC contract for the platform half.
- Applying ruleset, secret or settings changes. Plans are computed; a person applies them.
