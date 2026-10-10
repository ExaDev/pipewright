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
| `always` job | `if: always()` | `when: always` | one trailing `final`, not in a custom pipeline | `requires` with `terminal` |
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
- **Final steps in custom Bitbucket pipelines.** The step-options page documents final steps in custom pipelines, but the published pipelines schema, which the integration tests validate against, rejects one, so the adapter refuses the combination. If the documentation is right the refusal is conservative, not wrong; the schema is what is checked.
- **`native`** on a job is merged verbatim into that provider's job, and a `provider` step is accepted only by the provider that owns it. This is how non-portable parts stay visible in the file.

## Wrapper form

Every adapter can render a job in the wrapper form: orchestration stays native and each contiguous run of portable steps becomes one call to this tool's runner for exactly those step indexes. A run step with `form: "native"` stays in the provider's syntax, which is how an install step runs before the tool exists. A matrix combination is passed as a quoted `--matrix "axis=value"` argument: as a shell-quoted literal where the adapter expands the matrix itself, and through the provider's own substitution (`${{ matrix.node }}`, `$node`, `<< parameters.node >>`) where the provider does. The run context the runner reads comes from the provider's environment variables; a value that provider does not expose (Bitbucket cannot tell a push from a manual run, CircleCI exposes no workflow name) is absent, and the runner fails only if a step or condition reads it.

## Check names

`checkNames` returns, per job, the names under which the provider reports it, one per matrix combination: `Test (22)` on GitHub, `Test: [22]` on GitLab, and the step name on Bitbucket, which reports one status per pipeline. CircleCI names a matrix job from a templated name that the schema accepts and that was not run on CircleCI.

## Validation

What was run, and by what:

| Provider | Validator | Where it runs |
| --- | --- | --- |
| GitHub Actions | actionlint | the `integration` project and its CI job |
| CircleCI | `circleci config validate` (CLI 1.4.0, installed in CI from a pinned archive with a pinned digest), and the published JSON Schema | the `integration` project and its CI job |
| GitLab CI | the published `ci.json` JSON Schema in CI; GitLab's own linter by hand | the schema in the `integration` project; the linter is `Gitlab::Ci::Lint` from GitLab CE 19.4.1 in a container, which reported `valid=true` for the sample output and rejected a control with a misspelt `scripts` key |
| Bitbucket Pipelines | the published pipelines schema in CI; Atlassian's web validator by hand | the schema in the `integration` project; the validator page reported "valid" for the sample output and "Invalid configuration" for a control with a misspelt `scripts` key |

The two by-hand runs are not in CI. GitLab's linter needs a GitLab instance (the CE image and its several minutes of boot) or a token for one, and Bitbucket's validator is a web page with no command line or API, so it was driven through a browser. Neither has been run against the product's scheduler: no emitted file has been executed on its provider.

`pnpm run test:integration` fetches each provider's published schema and runs actionlint and `circleci config validate` over the sample pipeline's output. It is a separate vitest project from the unit tests so the unit suite stays offline, and the CI job that runs it installs both tools first. A validator that cannot run is a failure, never a skip.
