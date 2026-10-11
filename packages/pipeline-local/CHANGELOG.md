## [0.1.0](https://github.com/ExaDev/pipewright/compare/@pipewright/pipeline-local@0.0.0...@pipewright/pipeline-local@0.1.0) (2026-10-11)

### Features

* add the gate policy and feature flags to the conformance sample ([40f5a21](https://github.com/ExaDev/pipewright/commit/40f5a21152a90b4de86893e023f77983a60125a2))
* add the GitLab CI adapter and the wrapper form ([2dc7b23](https://github.com/ExaDev/pipewright/commit/2dc7b239896e16d12852411be9216fe728afe90f))
* **pipeline-local:** run a pipeline in-process through an injected executor ([1b4a67d](https://github.com/ExaDev/pipewright/commit/1b4a67d0a37909f28a4ba5941cc0426240fba608))

### Bug Fixes

* address the second review round on the provider adapters and runner ([6b95b18](https://github.com/ExaDev/pipewright/commit/6b95b18128f1b96ac05c3165750fdc59b428bf0a))
* read run context lazily, detect Bitbucket and CircleCI, and locate import-time errors ([65cb26b](https://github.com/ExaDev/pipewright/commit/65cb26bf3beafdfa4e3725d68bcaca805e74ff0c))

### Code Refactoring

* bring the packages in line with the workspace lint rules ([42eb445](https://github.com/ExaDev/pipewright/commit/42eb445c1e1681f89d957988d58bdb99c712fe6c))
* rename the workspace packages from [@ci-adapters](https://github.com/ci-adapters) to [@pipewright](https://github.com/pipewright) ([faa70f1](https://github.com/ExaDev/pipewright/commit/faa70f1bbaac40a6bb91735c5d5fea34fc2753b5))

### Build System

* compile each package to dist and check that the packed packages install ([d5c65bd](https://github.com/ExaDev/pipewright/commit/d5c65bdc23b4e91fd866f2b9d673704085143bd4))
* release from main with semantic-release, as the sibling repositories do ([4644d2e](https://github.com/ExaDev/pipewright/commit/4644d2e18103f0f75a200dfc1f8b2d25d7b93092))

### Chores

* declare the MIT licence on every package ([979692b](https://github.com/ExaDev/pipewright/commit/979692bfc3eccec267c657bb0ff838fd178e4c14))


### Dependencies

- Updated @pipewright/pipeline-contract to 0.1.0
