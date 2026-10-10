# Providers

What each adapter compiles, what it rejects, and how it is validated. An adapter never drops or approximates what it cannot express: it throws `UnsupportedFeatureError` naming the node by JSON pointer in the resolved pipeline. The source of truth is each adapter's doc comment and its unit tests; this page states the shape.

## Support

| | GitHub Actions | GitLab CI | Bitbucket Pipelines | CircleCI |
| --- | --- | --- | --- | --- |
| Output file | `.github/workflows/<name>.yml` | `.gitlab-ci.yml` | `bitbucket-pipelines.yml` | `.circleci/config.yml` |
| Push trigger | yes, with branches | yes, with branches | yes, as `default` or per branch | yes, as a workflow condition |
| Pull request trigger | yes | yes (merge request) | yes, no target-branch filter | no |
| Manual trigger | yes (`workflow_dispatch`) | yes | yes (`custom`) | no |
| Schedule trigger | yes | no, a project setting | no, a repository setting | yes, as a scheduled workflow |
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
| Validator run | actionlint | published JSON Schema | published JSON Schema | published JSON Schema |

## Neutral semantics

- **Text equality is case-insensitive.** GitHub's `==` cannot be made case-sensitive, so the neutral model defines the weaker meaning and every adapter renders it exactly or rejects the condition. GitLab renders an anchored case-insensitive regular expression match. Bitbucket's equality is case-sensitive with no case-insensitive form, so it accepts no conditions.
- **Context values are a closed set** (`event`, `refName`, `baseRefName`, `sha`, `repository`, `workflow`, `runId`), each mapped by the adapter onto the provider's own context. A provider that has no equivalent rejects the use. CircleCI has pipeline values for `sha`, `refName` and `runId` only.
- **Runner labels select a runner.** GitHub uses them as `runs-on`, GitLab as `tags`, Bitbucket as `runs-on`. CircleCI cannot run a job without an executor, so the executor comes from `native.circleci` and labels are not used there.
- **`native`** on a job is merged verbatim into that provider's job, and a `provider` step is accepted only by the provider that owns it. This is how non-portable parts stay visible in the file.

## Wrapper form

Every adapter can render a job in the wrapper form: orchestration stays native and each contiguous run of portable steps becomes one call to this tool's runner for exactly those step indexes. A run step with `form: "native"` stays in the provider's syntax, which is how an install step runs before the tool exists. A matrix combination is passed as `--matrix axis=value`: as a literal where the adapter expands the matrix itself, and through the provider's own substitution (`${{ matrix.node }}`, `<< parameters.node >>`) where the provider does.

## Check names

`checkNames` returns, per job, the names under which the provider reports it, one per matrix combination: `Test (22)` on GitHub, `Test: [22]` on GitLab, and the step name on Bitbucket, which reports one status per pipeline. CircleCI names a matrix job from a templated name that the schema accepts and that was not run on CircleCI.

## Validation

`pnpm run test:integration` fetches each provider's published schema and runs actionlint over the sample pipeline's output. It is a separate vitest project from the unit tests so the unit suite stays offline, and the CI job that runs it installs actionlint first. A validator that cannot run is a failure, never a skip.
