## [0.3.0](https://github.com/ExaDev/pipewright/compare/@pipewright/pipeline-github-actions@0.2.0...@pipewright/pipeline-github-actions@0.3.0) (2026-10-11)

### Features

* **github-actions:** carry workflow-level settings at pipeline level ([348aab7](https://github.com/ExaDev/pipewright/commit/348aab731d356e82b4e35e41f14aa69e1011c588))


### Dependencies

- Updated @pipewright/pipeline-contract to 0.2.0

## [0.2.0](https://github.com/ExaDev/pipewright/compare/@pipewright/pipeline-github-actions@0.1.2...@pipewright/pipeline-github-actions@0.2.0) (2026-10-11)

### Features

* **github-actions:** evaluate expressions and contexts for imported workflows ([1003d23](https://github.com/ExaDev/pipewright/commit/1003d236da4225372b325438f3059f054a396001)), closes [#73](https://github.com/ExaDev/pipewright/issues/73)

## [0.1.2](https://github.com/ExaDev/pipewright/compare/@pipewright/pipeline-github-actions@0.1.1...@pipewright/pipeline-github-actions@0.1.2) (2026-10-11)

### Bug Fixes

* **importers:** read what real GitLab, Bitbucket and GitHub files commonly write ([597bb00](https://github.com/ExaDev/pipewright/commit/597bb00abc96ad0b8edba22bdad653d85498750a))


### Dependencies

- Updated @pipewright/pipeline-contract to 0.1.2

## [0.1.1](https://github.com/ExaDev/pipewright/compare/@pipewright/pipeline-github-actions@0.1.0...@pipewright/pipeline-github-actions@0.1.1) (2026-10-11)


### Dependencies

- Updated @pipewright/pipeline-contract to 0.1.1

## [0.1.0](https://github.com/ExaDev/pipewright/compare/@pipewright/pipeline-github-actions@0.0.0...@pipewright/pipeline-github-actions@0.1.0) (2026-10-11)

### Features

* add the gate policy and feature flags to the conformance sample ([40f5a21](https://github.com/ExaDev/pipewright/commit/40f5a21152a90b4de86893e023f77983a60125a2))
* add the GitLab CI adapter and the wrapper form ([2dc7b23](https://github.com/ExaDev/pipewright/commit/2dc7b239896e16d12852411be9216fe728afe90f))
* **check-names:** derive required check names from a pipeline ([2b29976](https://github.com/ExaDev/pipewright/commit/2b29976dc03fdf05f13cbe929426339bb5cd6751))
* let a run step opt out of the wrapper form, and add the actions permission scope ([929bb84](https://github.com/ExaDev/pipewright/commit/929bb84b6e8c94914d38ff43fb9fcd30ac0431cf))
* **pipeline-github-actions:** compile the model to a GitHub Actions workflow ([f7fa27b](https://github.com/ExaDev/pipewright/commit/f7fa27bf4a710b8f72e5b3d447bbea8ea0fea0c6))
* **pipeline-github-actions:** import a workflow into the neutral model ([7cef8ac](https://github.com/ExaDev/pipewright/commit/7cef8ac3998c6507c906085f1ff143626719077f))

### Bug Fixes

* guard provider cases the compilers accepted wrongly ([dfb4418](https://github.com/ExaDev/pipewright/commit/dfb4418fbaa7d293a6f2bcda688adff454f94d74))
* **importers:** own a job or step that carries its provider's own settings ([45cf1cf](https://github.com/ExaDev/pipewright/commit/45cf1cf81e2cef02257584fc959a7d6e0711d70b))
* pin actions by commit and give the write token only to the steps that use it ([e2b3b4c](https://github.com/ExaDev/pipewright/commit/e2b3b4c0fb8caa1d5227f232d49c58e7672dae86))
* **pipeline-github-actions:** carry a command with an expression as a provider step ([aae7d64](https://github.com/ExaDev/pipewright/commit/aae7d642a52529e742fa005665a5f6b21ee81553))
* **pipeline-github-actions:** keep text from another provider from being evaluated as an expression ([aa36995](https://github.com/ExaDev/pipewright/commit/aa3699598a5a09c18785ee57af7c3fc84545b411))
* **pipeline-github-actions:** put a step's description on the step that carries it ([616fe20](https://github.com/ExaDev/pipewright/commit/616fe20d6378fb7617aa29aa45780fb29bd48454))
* **pipeline-github-actions:** reject a job with no runner label ([abb01ff](https://github.com/ExaDev/pipewright/commit/abb01ffd17f87ebcbcbe1d14b16acf4353b002f0))
* **pipeline-github-actions:** reject or carry what a neutral value would misstate elsewhere ([735de98](https://github.com/ExaDev/pipewright/commit/735de98d7f2bbb43b182e6014881d1cc8d9f9dbe))

### Code Refactoring

* bring the packages in line with the workspace lint rules ([42eb445](https://github.com/ExaDev/pipewright/commit/42eb445c1e1681f89d957988d58bdb99c712fe6c))
* **pipeline-github-actions:** hold the provider vocabulary in one module ([e3754a9](https://github.com/ExaDev/pipewright/commit/e3754a9a3063a60cc8571f91ff522c7d4c7a33cb))
* rename the workspace packages from [@ci-adapters](https://github.com/ci-adapters) to [@pipewright](https://github.com/pipewright) ([faa70f1](https://github.com/ExaDev/pipewright/commit/faa70f1bbaac40a6bb91735c5d5fea34fc2753b5))
* share dependency levels and add feature flags to the conformance sample ([1c10db5](https://github.com/ExaDev/pipewright/commit/1c10db5b2532236ff15e016e18e6393eb2f3aed2))

### Tests

* **pipeline-github-actions:** state that a workflow distinguishes a gate ([fa56dbc](https://github.com/ExaDev/pipewright/commit/fa56dbc4e8d46c1272be07b41e2173acb0583bc6))

### Build System

* compile each package to dist and check that the packed packages install ([d5c65bd](https://github.com/ExaDev/pipewright/commit/d5c65bdc23b4e91fd866f2b9d673704085143bd4))
* release from main with semantic-release, as the sibling repositories do ([4644d2e](https://github.com/ExaDev/pipewright/commit/4644d2e18103f0f75a200dfc1f8b2d25d7b93092))

### Chores

* declare the MIT licence on every package ([979692b](https://github.com/ExaDev/pipewright/commit/979692bfc3eccec267c657bb0ff838fd178e4c14))
* share zod, yaml and ajv versions through a pnpm catalog ([ab538d9](https://github.com/ExaDev/pipewright/commit/ab538d9e7d06fc14123ad1c3a4f0796d02f4ac1c))


### Dependencies

- Updated @pipewright/pipeline-contract to 0.1.0
- Updated @pipewright/yaml-emit to 0.1.0
