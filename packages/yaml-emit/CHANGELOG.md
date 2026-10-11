## [0.1.0](https://github.com/ExaDev/pipewright/compare/@pipewright/yaml-emit@0.0.0...@pipewright/yaml-emit@0.1.0) (2026-10-11)

### Features

* **pipeline-github-actions:** compile the model to a GitHub Actions workflow ([f7fa27b](https://github.com/ExaDev/pipewright/commit/f7fa27bf4a710b8f72e5b3d447bbea8ea0fea0c6))
* **yaml-emit:** expand merge keys when reading ([219e78b](https://github.com/ExaDev/pipewright/commit/219e78b6f4b18f3d0b8b0676f91ecad59e5aa9f0))
* **yaml-emit:** read YAML back with the comments the emitter wrote ([a14b9aa](https://github.com/ExaDev/pipewright/commit/a14b9aaf6fd99a0b906ecc546a8f7558adb56c43))

### Bug Fixes

* address the second review round on the provider adapters and runner ([6b95b18](https://github.com/ExaDev/pipewright/commit/6b95b18128f1b96ac05c3165750fdc59b428bf0a))
* **yaml-emit:** strip the generated header only from the first root key's comment ([91f68ea](https://github.com/ExaDev/pipewright/commit/91f68eab6986c17f9c2e38cac1030edb1a6c245a))

### Code Refactoring

* bring the packages in line with the workspace lint rules ([42eb445](https://github.com/ExaDev/pipewright/commit/42eb445c1e1681f89d957988d58bdb99c712fe6c))
* rename the workspace packages from [@ci-adapters](https://github.com/ci-adapters) to [@pipewright](https://github.com/pipewright) ([faa70f1](https://github.com/ExaDev/pipewright/commit/faa70f1bbaac40a6bb91735c5d5fea34fc2753b5))
* share dependency levels and add feature flags to the conformance sample ([1c10db5](https://github.com/ExaDev/pipewright/commit/1c10db5b2532236ff15e016e18e6393eb2f3aed2))

### Build System

* compile each package to dist and check that the packed packages install ([d5c65bd](https://github.com/ExaDev/pipewright/commit/d5c65bdc23b4e91fd866f2b9d673704085143bd4))
* pin dependencies exactly and keep one version of each with syncpack ([840b5d0](https://github.com/ExaDev/pipewright/commit/840b5d0c4590dcbbdb3700afaa12967fe2501f55))
* release from main with semantic-release, as the sibling repositories do ([4644d2e](https://github.com/ExaDev/pipewright/commit/4644d2e18103f0f75a200dfc1f8b2d25d7b93092))

### Chores

* declare the MIT licence on every package ([979692b](https://github.com/ExaDev/pipewright/commit/979692bfc3eccec267c657bb0ff838fd178e4c14))
* share zod, yaml and ajv versions through a pnpm catalog ([ab538d9](https://github.com/ExaDev/pipewright/commit/ab538d9e7d06fc14123ad1c3a4f0796d02f4ac1c))
