## [0.1.0](https://github.com/ExaDev/pipewright/compare/@pipewright/platform-contract@0.0.0...@pipewright/platform-contract@0.1.0) (2026-10-11)

### Features

* add the platform contract and a read-only GitHub adapter ([69b6a7e](https://github.com/ExaDev/pipewright/commit/69b6a7e59c148b0546c0e093e5320423b2190336))

### Bug Fixes

* restrict a step's form to native and decode every documented check conclusion ([3611028](https://github.com/ExaDev/pipewright/commit/3611028e4396356d1ed9ef9b7c4d2ba087107f31))

### Code Refactoring

* bring the packages in line with the workspace lint rules ([42eb445](https://github.com/ExaDev/pipewright/commit/42eb445c1e1681f89d957988d58bdb99c712fe6c))
* rename the workspace packages from [@ci-adapters](https://github.com/ci-adapters) to [@pipewright](https://github.com/pipewright) ([faa70f1](https://github.com/ExaDev/pipewright/commit/faa70f1bbaac40a6bb91735c5d5fea34fc2753b5))

### Build System

* compile each package to dist and check that the packed packages install ([d5c65bd](https://github.com/ExaDev/pipewright/commit/d5c65bdc23b4e91fd866f2b9d673704085143bd4))
* pin dependencies exactly and keep one version of each with syncpack ([840b5d0](https://github.com/ExaDev/pipewright/commit/840b5d0c4590dcbbdb3700afaa12967fe2501f55))
* release from main with semantic-release, as the sibling repositories do ([4644d2e](https://github.com/ExaDev/pipewright/commit/4644d2e18103f0f75a200dfc1f8b2d25d7b93092))

### Chores

* declare the MIT licence on every package ([979692b](https://github.com/ExaDev/pipewright/commit/979692bfc3eccec267c657bb0ff838fd178e4c14))
* share zod, yaml and ajv versions through a pnpm catalog ([ab538d9](https://github.com/ExaDev/pipewright/commit/ab538d9e7d06fc14123ad1c3a4f0796d02f4ac1c))
