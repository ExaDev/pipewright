# Providers

What each adapter compiles, what it rejects, and how it is validated. An adapter never drops or approximates what it cannot express: it throws `UnsupportedFeatureError` naming the node by JSON pointer in the resolved pipeline. The source of truth is each adapter's doc comment and its unit tests; this page states the shape.

## Support

| | GitHub Actions | GitLab CI | Bitbucket Pipelines | CircleCI |
| --- | --- | --- | --- | --- |
| Output file | `.github/workflows/<name>.yml` | `.gitlab-ci.yml` | `bitbucket-pipelines.yml` | `.circleci/config.yml` |
| Push trigger | yes, with branches | yes, with branches | yes, as `default` or per branch | yes, as a workflow condition |
| Pull request trigger | yes | yes (merge request) | yes, no target-branch filter | no |
| Manual trigger | yes (`workflow_dispatch`) | yes | yes (`custom`) | no |
| Schedule trigger | yes | no, a project setting | no, a repository setting | no, it needs a branch filter the neutral trigger lacks |
| `needs` graph | any DAG | any DAG, stages derived by level | only a sequence of parallel groups | any DAG, through `requires` |
| `gate` job | always-run plus an explicit failing step | ordinary dependent job | ordinary step | ordinary dependent job |
| `always` job | `if: always()` | `when: always` | one trailing `final` | `requires` with `terminal` |
| Matrix | `strategy.matrix` | `parallel: matrix` | expanded into parallel steps | parameterised jobs with `matrix` |
| Job environment | yes | yes | no | yes, over sha, ref and run id |
| Step environment | yes | no | no | yes |
| Conditions | yes | job level, no `not` | none | none |
| Permissions | yes | no | no | no |
| Concurrency group | yes | `interruptible` or `resource_group` | no | no |
| Timeouts | yes | yes | yes, 1 to 720 minutes | no |
| Deployment environment | yes | yes | yes | no |
| Wrapper form | yes | yes | yes | yes |
| Validator run | actionlint | published JSON Schema | published JSON Schema | `circleci config validate` and the published JSON Schema |

## Neutral semantics

- **Text equality is case-insensitive.** GitHub's `==` cannot be made case-sensitive, so the neutral model defines the weaker meaning and every adapter renders it exactly or rejects the condition. GitLab renders an anchored case-insensitive regular expression match. Bitbucket's equality is case-sensitive with no case-insensitive form, so it accepts no conditions.
- **Context values are a closed set** (`event`, `refName`, `baseRefName`, `sha`, `repository`, `workflow`, `runId`), each mapped by the adapter onto the provider's own context. A provider that has no equivalent rejects the use. CircleCI has pipeline values for `sha`, `refName` and `runId` only.
- **Runner labels select a runner.** GitHub uses them as `runs-on` and GitLab as `tags`. Bitbucket documents `runs-on` as available only for self-hosted runners, so labels are written only when they include `self.hosted`; any other set runs on Bitbucket's own infrastructure. CircleCI cannot run a job without exactly one executor (`docker`, `machine`, `macos` or `executor`), so the executor comes from `native.circleci` and labels are not used there.
- **Final steps in custom Bitbucket pipelines.** The step-options page documents them and Atlassian's validator accepts one, but the published pipelines JSON Schema rejects it. The schema lags the product, so the adapter emits the file the validator accepts and the schema test never contains that case.
- **`native`** on a job is merged verbatim into that provider's job, and a `provider` step is accepted only by the provider that owns it. `native` on the pipeline is merged verbatim into that provider's file at the top level, and a provider the carried settings do not belong to rejects the pipeline by pointer, because a pipeline-level setting changes what every job does. This is how non-portable parts stay visible in the file.

## Importing

An importer is the inverse of a compiler: it reads a provider's native file into the neutral model, and `convert` composes one provider's importer with another's compiler. It takes the compilers' stance in the other direction. What the model cannot express is rejected with the file and the JSON pointer of the node in it; what the provider owns and the model carries verbatim is kept, so nothing is dropped or reinterpreted.

The bar every importer meets is a round trip. For each sample the compiler conformance kit uses, `emit`, then `import`, then `emit` again writes the same file, and the importer rejects a wrapper-form file, which holds only a call to this tool and none of the steps.

| | GitHub Actions | GitLab CI | Bitbucket Pipelines | CircleCI |
| --- | --- | --- | --- | --- |
| Triggers read | push and pull request with branches, manual, schedule | workflow rules over the pipeline source and branch | default, branches, pull requests, manual | a workflow with an optional branch condition |
| Graph read from | `needs` | `needs`, and the whole earlier stage for a job with none | the order of steps and parallel groups | `requires` |
| Job id | the job key | derived from the job name | derived from the step name | derived from the job key |
| Matrix | read back as axes | read back as axes | not recoverable, read as separate steps | read back as axes |
| `gate` read back | yes | no, written as an ordinary job | no | no |
| Kept on `native` | any job key the model has no field for, a setting with no neutral form, a condition with no neutral form | any job key the model has no field for, rules with no neutral form | any step key the model has no field for, runner labels naming no self-hosted runner | the executor and other job keys |
| Kept at pipeline level | a workflow key the model has no field for (`run-name`, `defaults`), a permission form its scopes do not cover, a concurrency group the neutral vocabulary cannot name | top-level settings (`include` and the like) and hidden-job templates | `definitions` and pipelines for tags and bookmarks | orbs, commands, executors and other top-level settings, including a `version` other than 2.1 |
| Kept as a `provider` step | a step that is not a plain `run` or the pinned checkout, and a command containing `${{ }}` or a runner variable | a script that reads a GitLab variable or a matrix axis | a pipe, and a script that reads a Bitbucket variable | any step that is not a plain run or checkout, and a command with a substitution or a CircleCI variable |
| Rejected | other trigger filters and events, a branch pattern, a reusable-workflow job, a computed runner label, a job id the model cannot take | no workflow rules, hidden jobs and `extends`, a downstream trigger, a `needs` entry with options, a job with no needs that waits on a job that may not run | `definitions` and other top-level settings, tag pipelines, other custom pipelines, stages, a branch pattern, triggers that run different steps | orbs, more than one workflow, workflow job filters, a job no workflow runs, a job parameter no matrix supplies |

A setting the provider applies to every job that does not set it (GitLab's top-level `image`, `before_script`, `cache` and `default`; Bitbucket's `image` and `clone`) is carried by each job that inherits it, which is what makes that job the provider's own. A GitLab file with no `workflow` section has the provider's default pipeline sources, which the model states as no triggers; GitHub, Bitbucket and CircleCI reject a pipeline with none.

A job (a step, for Bitbucket) that carries settings of its provider's own, such as a condition, a start trigger, an image, services, a `before_script`, `continue-on-error` or a container, is that provider's as a whole: its commands are `provider` steps, because another provider would otherwise run them without those settings. Compiling it for a different provider is then refused at the step, naming it. CircleCI is the exception, since every job carries its executor.

The lines of a GitLab or Bitbucket script run in one shell, so they are read as one step. A command is carried as written, and the model has no vocabulary for a provider's own variables and expressions, so a command that uses one is kept with the provider that evaluates it. A literal `$` or `${{` that a file for another provider carries as text is written so the target provider does not expand it. `convert` also refuses a pipeline whose jobs carry settings for the source provider, because the target would drop them.

A job that names no runner label has an empty `runsOn`, which means the provider's own default runner. GitLab and Bitbucket write nothing for it; GitHub, which selects a runner only by label, rejects it.

## Wrapper form

Every adapter can render a job in the wrapper form: orchestration stays native and each contiguous run of portable steps becomes one call to this tool's runner for exactly those step indexes. A run step with `form: "native"` stays in the provider's syntax, which is how an install step runs before the tool exists. A matrix combination is passed as a quoted `--matrix "axis=value"` argument: as a shell-quoted literal where the adapter expands the matrix itself, and through the provider's own substitution (`${{ matrix.node }}`, `$node`, `<< parameters.node >>`) where the provider does. The run context the runner reads comes from the provider's environment variables; a value that provider does not expose (Bitbucket cannot tell a push from a manual run, CircleCI exposes no workflow name) is absent, and the runner fails only if a step or condition reads it. The runner's own file commands (`GITHUB_OUTPUT` and its siblings) apply between the steps of one wrapper call and are not forwarded to the provider's runner, so a native step after the call does not see what an inner step wrote.

## GitHub's own steps on the host

A `run` that reaches a provider step of GitHub's resolves it on the host, in two moments that mirror the hosted runner's own. Before a job runs, every action the job's `uses` steps name, whose step this run will execute, is resolved and its `pre` and `post` phases are placed: `pre` before the job's own steps in the order the steps name their actions, `post` after them in the reverse of that order, which is where the hosted runner runs them. When the run reaches a step, it is resolved against what the job's earlier steps by then produced, so a `with:` mapping or an `if:` reading a step output, or command text reading the environment a step wrote, works as written. A composite action's steps run as commands; a node action's entry runs under the CLI's own node with its inputs in the environment as `INPUT_<NAME>`; a local `./` reference resolves against the workspace and an `owner/repo@ref` reference is fetched as a tarball, extracted once per reference for the run's lifetime.

Expressions evaluate with the run's context: the neutral context values mapped onto the `github` context's own names, the environment the next command inherits, the outputs and conclusions of the job's steps so far (keyed by the `id` the workflow gave them), the results of needed jobs, and secrets from `--secret`. The platform token, wherever the run holds one, is supplied as `secrets.GITHUB_TOKEN`.

What stays provider-owned: a `docker://` reference, an action whose `runs.using` needs a container, a workflow step naming a shell other than `bash` or `sh` or a setting the model has no step form for (`continue-on-error`, `timeout-minutes`), and every step of another provider. Each is skipped by `--skip-provider-steps` and fails the run without it, naming the construct; `--skip-provider-steps` skips whole actions too, for a host that has already supplied the toolchain those steps would install. An action's declared `outputs` are read as data but not evaluated into the steps context, because the model records no outputs an action declares, and a composite action's step conditions see the view the step was reached with, not the outcomes of the composite's own later steps.

## Check names

`checkNames` returns, per job, the names under which the provider reports it, one per matrix combination: `Test (22)` on GitHub, `Test: [22]` on GitLab, and the step name on Bitbucket, which reports one status per pipeline. CircleCI names a matrix job from a templated name that the schema accepts and that was not run on CircleCI.

## Validation

What runs, and where:

| Provider | Validator | Runs in |
| --- | --- | --- |
| GitHub Actions | actionlint | the `integration` project, CI job `Provider validators` |
| CircleCI | `circleci config validate` (CLI 1.4.0, pinned archive and digest), and the published JSON Schema | the `integration` project, CI job `Provider validators` |
| GitLab CI | `Gitlab::Ci::Lint` from a pinned GitLab CE 19.4.1 container, and the published `ci.json` JSON Schema | the `container` project (CI job `GitLab linter`) and the `integration` project |
| Bitbucket Pipelines | Atlassian's own validator page, driven in the installed Google Chrome, and the published pipelines JSON Schema | the `browser` project (CI job `Bitbucket validator`) and the `integration` project |

Each product validator test also feeds its validator a control with a misspelt keyword and requires it to say invalid, so a validator that stopped checking would fail the suite rather than keep passing. Bitbucket's page validates in the browser with logic of its own (its bundle embeds no JSON Schema), which is why it can disagree with the published schema, as it does for a final step in a custom pipeline.

No emitted file has been executed on Bitbucket, GitLab or CircleCI: nothing here holds an account on them.

`pnpm run test:integration` fetches each provider's published schema and runs actionlint and `circleci config validate` over the sample pipeline's output. `test:browser` drives the installed Google Chrome (GitHub's runner image has it; nothing is downloaded, because a browser fetched at test time is bytes this repository cannot verify) and `test:container` needs Docker and several minutes. Each is a separate vitest project from the unit tests so the unit suite stays offline, and each CI job installs what its project needs. A validator that cannot run is a failure, never a skip.

## Execution on the provider

A validator proves an emitted file is well formed, not that it runs. For GitHub there is also an end-to-end test: `ci/e2e.pipeline.ts` is emitted to `.github/workflows/pipewright-end-to-end.yml`, and the `e2e` vitest project dispatches it through the platform controller, waits for the run through the reader, requires it to conclude `success`, and requires GitHub to report every check name the compiler derived for it (`Build (22)`, `Build (24)`, `Wrapped`, `End to end gate`). That last comparison is what checks the claimed matrix naming against the provider.

It runs in CI only after a merge to `main`, because a workflow can be dispatched only once its file is on the default branch, and it is outside the required-checks gate, which counts a skipped job as failed. The other three providers have no equivalent: nothing here holds an account on them, so no emitted Bitbucket, GitLab or CircleCI file has been executed.
