## [0.3.0](https://github.com/ExaDev/pipewright/compare/@pipewright/pipeline-local@0.2.0...@pipewright/pipeline-local@0.3.0) (2026-10-11)

### Features

* **local:** run the steps a host prepares and resolves for a job ([1ebcee8](https://github.com/ExaDev/pipewright/commit/1ebcee8666b972dd8b89c17172ea4bebb67da0d1))

### Bug Fixes

* **local:** prepare only the steps a run's range will execute ([b11e5a2](https://github.com/ExaDev/pipewright/commit/b11e5a251f1f0a7a568487c12e1068684608a349))


### Dependencies

- Updated @pipewright/pipeline-contract to 0.4.0

## [0.2.0](https://github.com/ExaDev/pipewright/compare/@pipewright/pipeline-local@0.1.3...@pipewright/pipeline-local@0.2.0) (2026-10-11)

### Features

* apply the runner's file commands between steps ([3ef85f1](https://github.com/ExaDev/pipewright/commit/3ef85f12dc32edc02d5af9abba9437c9afae6ca8))

### Bug Fixes

* **runner:** emit a step's stderr through the run's masks ([04b6c2e](https://github.com/ExaDev/pipewright/commit/04b6c2eebe31946bb24684d438a4721513382545))
* **runner:** mask a log command's annotation fields as its message ([0dd165b](https://github.com/ExaDev/pipewright/commit/0dd165bc7b0ef685dabdf93c49437f35235527ec))
* **runner:** never quote a command file's line in a parse error ([ae37c0a](https://github.com/ExaDev/pipewright/commit/ae37c0ac8d946d432d596a4958619e404332c4a6))
* **runner:** quote no malformed property in an annotation error ([2667792](https://github.com/ExaDev/pipewright/commit/2667792a1f00a26deb3351f86f630f8db5c89418))
* **runner:** quote no step-controlled name in a stream error ([25ce3f6](https://github.com/ExaDev/pipewright/commit/25ce3f6c4bab4e95bd5c75a86f93c0240b2fd00b))
* **runner:** register each line of a multiline mask and quote no parser value ([245af13](https://github.com/ExaDev/pipewright/commit/245af130279d2801da2df43ad8cd5e5ebc0b2328))
* **runner:** release a step's files and dispose the scratch when a run throws ([1fe9330](https://github.com/ExaDev/pipewright/commit/1fe93306c30c3fc71c45b1327f7f06f8e014edc3))
* **runner:** remove each step's command files once read and the scratch at the run's end ([92dd4a0](https://github.com/ExaDev/pipewright/commit/92dd4a014d259ede971d7f55c1089d60fce12761))


### Dependencies

- Updated @pipewright/pipeline-contract to 0.3.0

## [0.1.3](https://github.com/ExaDev/pipewright/compare/@pipewright/pipeline-local@0.1.2...@pipewright/pipeline-local@0.1.3) (2026-10-11)


### Dependencies

- Updated @pipewright/pipeline-contract to 0.2.0

## [0.1.2](https://github.com/ExaDev/pipewright/compare/@pipewright/pipeline-local@0.1.1...@pipewright/pipeline-local@0.1.2) (2026-10-11)


### Dependencies

- Updated @pipewright/pipeline-contract to 0.1.2

## [0.1.1](https://github.com/ExaDev/pipewright/compare/@pipewright/pipeline-local@0.1.0...@pipewright/pipeline-local@0.1.1) (2026-10-11)


### Dependencies

- Updated @pipewright/pipeline-contract to 0.1.1

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
