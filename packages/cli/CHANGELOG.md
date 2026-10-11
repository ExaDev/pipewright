## [0.1.7](https://github.com/ExaDev/pipewright/compare/@pipewright/cli@0.1.6...@pipewright/cli@0.1.7) (2026-10-11)


### Dependencies

- Updated @pipewright/pipeline-github-actions to 0.5.0
- Updated @pipewright/check-names to 0.1.6

## [0.1.6](https://github.com/ExaDev/pipewright/compare/@pipewright/cli@0.1.5...@pipewright/cli@0.1.6) (2026-10-11)


### Dependencies

- Updated @pipewright/pipeline-github-actions to 0.4.0
- Updated @pipewright/check-names to 0.1.5

## [0.1.5](https://github.com/ExaDev/pipewright/compare/@pipewright/cli@0.1.4...@pipewright/cli@0.1.5) (2026-10-11)


### Dependencies

- Updated @pipewright/pipeline-contract to 0.2.0
- Updated @pipewright/pipeline-bitbucket to 0.2.0
- Updated @pipewright/pipeline-circleci to 0.2.0
- Updated @pipewright/pipeline-github-actions to 0.3.0
- Updated @pipewright/pipeline-gitlab-ci to 0.2.0
- Updated @pipewright/pipeline-local to 0.1.3
- Updated @pipewright/check-names to 0.1.4

## [0.1.4](https://github.com/ExaDev/pipewright/compare/@pipewright/cli@0.1.3...@pipewright/cli@0.1.4) (2026-10-11)


### Dependencies

- Updated @pipewright/pipeline-github-actions to 0.2.0
- Updated @pipewright/check-names to 0.1.3

## [0.1.3](https://github.com/ExaDev/pipewright/compare/@pipewright/cli@0.1.2...@pipewright/cli@0.1.3) (2026-10-11)


### Dependencies

- Updated @pipewright/pipeline-contract to 0.1.2
- Updated @pipewright/pipeline-bitbucket to 0.1.2
- Updated @pipewright/pipeline-circleci to 0.1.2
- Updated @pipewright/pipeline-github-actions to 0.1.2
- Updated @pipewright/pipeline-gitlab-ci to 0.1.2
- Updated @pipewright/pipeline-local to 0.1.2
- Updated @pipewright/check-names to 0.1.2

## [0.1.2](https://github.com/ExaDev/pipewright/compare/@pipewright/cli@0.1.1...@pipewright/cli@0.1.2) (2026-10-11)

### Bug Fixes

* **cli:** run each step's commands with errexit so an early failure fails the step ([0121910](https://github.com/ExaDev/pipewright/commit/01219109e90d8dd686175be1061e907c4f74dcd5))


### Dependencies

- Updated @pipewright/pipeline-contract to 0.1.1
- Updated @pipewright/pipeline-bitbucket to 0.1.1
- Updated @pipewright/pipeline-circleci to 0.1.1
- Updated @pipewright/pipeline-github-actions to 0.1.1
- Updated @pipewright/pipeline-gitlab-ci to 0.1.1
- Updated @pipewright/pipeline-local to 0.1.1
- Updated @pipewright/check-names to 0.1.1

## [0.1.1](https://github.com/ExaDev/pipewright/compare/@pipewright/cli@0.1.0...@pipewright/cli@0.1.1) (2026-10-11)


### Dependencies

- Updated @pipewright/platform-github to 0.1.1

## [0.1.0](https://github.com/ExaDev/pipewright/compare/@pipewright/cli@0.0.0...@pipewright/cli@0.1.0) (2026-10-11)

### Features

* add the gate policy and feature flags to the conformance sample ([40f5a21](https://github.com/ExaDev/pipewright/commit/40f5a21152a90b4de86893e023f77983a60125a2))
* author pipelines in TypeScript through definePipeline ([1899e5d](https://github.com/ExaDev/pipewright/commit/1899e5d395f9f97d041746fff11e987a55f14a0c))
* **cli:** import a native file and convert between providers ([f49f0b7](https://github.com/ExaDev/pipewright/commit/f49f0b7759d82f07730140c17fbed6266d6d6313))
* execute an emitted workflow on GitHub as an end-to-end test ([8b2cf65](https://github.com/ExaDev/pipewright/commit/8b2cf657f2c390b7f0363c5e04e7c1280d95fba6))
* export any pipeline as a JSON document and check the round trip ([8c0d12b](https://github.com/ExaDev/pipewright/commit/8c0d12b39e1d599be8512e14aa24fbfc83855aa4))
* register the new providers and validate each emitted sample with its own validator ([b241c8a](https://github.com/ExaDev/pipewright/commit/b241c8ad85449c7bd0f5b159136555bca59e3f4b))
* run Atlassian's Bitbucket validator and GitLab's CI linter as tests ([6747faf](https://github.com/ExaDev/pipewright/commit/6747faf7e6ac18440bcc4c3102e3c886901f5c69))
* run circleci config validate in the integration tests and CI ([9732b46](https://github.com/ExaDev/pipewright/commit/9732b466abbe5bdaf1ff5f4672a24a2059d2dd34))

### Bug Fixes

* address the second review round on the provider adapters and runner ([6b95b18](https://github.com/ExaDev/pipewright/commit/6b95b18128f1b96ac05c3165750fdc59b428bf0a))
* **cli:** say where a conversion refusal and a validation failure are ([09dac17](https://github.com/ExaDev/pipewright/commit/09dac174e14fbf7f1ac88697594aeee2b26eabad))
* drive the installed Chrome instead of downloading a browser at test time ([6a073bb](https://github.com/ExaDev/pipewright/commit/6a073bb19e22d81f99ffc6ec3260aa88e97052b1))
* read run context lazily, detect Bitbucket and CircleCI, and locate import-time errors ([65cb26b](https://github.com/ExaDev/pipewright/commit/65cb26bf3beafdfa4e3725d68bcaca805e74ff0c))
* read the run back by id in the platform smoke job ([1439d43](https://github.com/ExaDev/pipewright/commit/1439d43a9803b293ebd3c100ae24a788e31a2509))
* retry a published schema download when the host rate-limits or fails transiently ([2b1e8f3](https://github.com/ExaDev/pipewright/commit/2b1e8f3b1769aef6b847fe7cfc8c18568bd53b7d))

### Code Refactoring

* bring the packages in line with the workspace lint rules ([42eb445](https://github.com/ExaDev/pipewright/commit/42eb445c1e1681f89d957988d58bdb99c712fe6c))
* rename the workspace packages from [@ci-adapters](https://github.com/ci-adapters) to [@pipewright](https://github.com/pipewright) ([faa70f1](https://github.com/ExaDev/pipewright/commit/faa70f1bbaac40a6bb91735c5d5fea34fc2753b5))

### Tests

* **cli:** expect the braced matrix variable in the GitLab example ([a319ac3](https://github.com/ExaDev/pipewright/commit/a319ac340fedb0982bee9fb25942cb3e1b4e989e))

### Build System

* compile each package to dist and check that the packed packages install ([d5c65bd](https://github.com/ExaDev/pipewright/commit/d5c65bdc23b4e91fd866f2b9d673704085143bd4))
* pin dependencies exactly and keep one version of each with syncpack ([840b5d0](https://github.com/ExaDev/pipewright/commit/840b5d0c4590dcbbdb3700afaa12967fe2501f55))
* release from main with semantic-release, as the sibling repositories do ([4644d2e](https://github.com/ExaDev/pipewright/commit/4644d2e18103f0f75a200dfc1f8b2d25d7b93092))
* release the packages from a tag, and ship the schemas in the contract ([05edaa8](https://github.com/ExaDev/pipewright/commit/05edaa8f3fc89a15a1056ce3ed4c44f3866d1a3e))

### Chores

* declare the MIT licence on every package ([979692b](https://github.com/ExaDev/pipewright/commit/979692bfc3eccec267c657bb0ff838fd178e4c14))
* share zod, yaml and ajv versions through a pnpm catalog ([ab538d9](https://github.com/ExaDev/pipewright/commit/ab538d9e7d06fc14123ad1c3a4f0796d02f4ac1c))


### Dependencies

- Updated @pipewright/pipeline-contract to 0.1.0
- Updated @pipewright/platform-contract to 0.1.0
- Updated @pipewright/pipeline-bitbucket to 0.1.0
- Updated @pipewright/pipeline-circleci to 0.1.0
- Updated @pipewright/pipeline-github-actions to 0.1.0
- Updated @pipewright/pipeline-gitlab-ci to 0.1.0
- Updated @pipewright/pipeline-local to 0.1.0
- Updated @pipewright/platform-github to 0.1.0
- Updated @pipewright/check-names to 0.1.0
