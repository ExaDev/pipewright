## [0.2.0](https://github.com/ExaDev/pipewright/compare/@pipewright/pipeline-circleci@0.1.2...@pipewright/pipeline-circleci@0.2.0) (2026-10-11)

### Features

* **circleci:** carry orbs and other top-level settings at pipeline level ([d5adf20](https://github.com/ExaDev/pipewright/commit/d5adf20dd89d889d60217cc1ad98be6cd2387935))


### Dependencies

- Updated @pipewright/pipeline-contract to 0.2.0

## [0.1.2](https://github.com/ExaDev/pipewright/compare/@pipewright/pipeline-circleci@0.1.1...@pipewright/pipeline-circleci@0.1.2) (2026-10-11)

### Bug Fixes

* **importers:** read what real GitLab, Bitbucket and GitHub files commonly write ([597bb00](https://github.com/ExaDev/pipewright/commit/597bb00abc96ad0b8edba22bdad653d85498750a))


### Dependencies

- Updated @pipewright/pipeline-contract to 0.1.2

## [0.1.1](https://github.com/ExaDev/pipewright/compare/@pipewright/pipeline-circleci@0.1.0...@pipewright/pipeline-circleci@0.1.1) (2026-10-11)


### Dependencies

- Updated @pipewright/pipeline-contract to 0.1.1

## [0.1.0](https://github.com/ExaDev/pipewright/compare/@pipewright/pipeline-circleci@0.0.0...@pipewright/pipeline-circleci@0.1.0) (2026-10-11)

### Features

* **pipeline-circleci:** compile the model to .circleci/config.yml ([f557f65](https://github.com/ExaDev/pipewright/commit/f557f65054a881ce63a085bb710f808acc6595eb))
* **pipeline-circleci:** import a .circleci/config.yml into the neutral model ([042e3c3](https://github.com/ExaDev/pipewright/commit/042e3c3036f8962bbc50d4cd7e32831fd37ca0a5))

### Bug Fixes

* address the second review round on the provider adapters and runner ([6b95b18](https://github.com/ExaDev/pipewright/commit/6b95b18128f1b96ac05c3165750fdc59b428bf0a))
* guard provider cases the compilers accepted wrongly ([dfb4418](https://github.com/ExaDev/pipewright/commit/dfb4418fbaa7d293a6f2bcda688adff454f94d74))
* **pipeline-circleci:** carry a command with a GitHub expression as a provider step ([3b614e1](https://github.com/ExaDev/pipewright/commit/3b614e1247e7c0416587141617051c875ef12d23))
* **pipeline-circleci:** carry commands CircleCI evaluates and reject what the compiler would drop ([7904d64](https://github.com/ExaDev/pipewright/commit/7904d64fa22cb91420b7d3a8d82a285c5638a805))

### Code Refactoring

* **pipeline-circleci:** hold the provider vocabulary in one module ([0bad47b](https://github.com/ExaDev/pipewright/commit/0bad47b2e98133b00e05d259c1d4c0a3467b62ab))
* rename the workspace packages from [@ci-adapters](https://github.com/ci-adapters) to [@pipewright](https://github.com/pipewright) ([faa70f1](https://github.com/ExaDev/pipewright/commit/faa70f1bbaac40a6bb91735c5d5fea34fc2753b5))

### Build System

* compile each package to dist and check that the packed packages install ([d5c65bd](https://github.com/ExaDev/pipewright/commit/d5c65bdc23b4e91fd866f2b9d673704085143bd4))
* release from main with semantic-release, as the sibling repositories do ([4644d2e](https://github.com/ExaDev/pipewright/commit/4644d2e18103f0f75a200dfc1f8b2d25d7b93092))

### Chores

* declare the MIT licence on every package ([979692b](https://github.com/ExaDev/pipewright/commit/979692bfc3eccec267c657bb0ff838fd178e4c14))
* scaffold the Bitbucket Pipelines and CircleCI adapter packages ([365f668](https://github.com/ExaDev/pipewright/commit/365f66886548f0d902925587886a1ae839450e87))


### Dependencies

- Updated @pipewright/pipeline-contract to 0.1.0
- Updated @pipewright/yaml-emit to 0.1.0
