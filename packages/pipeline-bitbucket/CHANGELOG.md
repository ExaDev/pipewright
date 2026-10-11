## [0.2.1](https://github.com/ExaDev/pipewright/compare/@pipewright/pipeline-bitbucket@0.2.0...@pipewright/pipeline-bitbucket@0.2.1) (2026-10-11)


### Dependencies

- Updated @pipewright/pipeline-contract to 0.3.0

## [0.2.0](https://github.com/ExaDev/pipewright/compare/@pipewright/pipeline-bitbucket@0.1.2...@pipewright/pipeline-bitbucket@0.2.0) (2026-10-11)

### Features

* **bitbucket:** carry definitions and tag pipelines at pipeline level ([8093706](https://github.com/ExaDev/pipewright/commit/8093706fd0348c242970984cf08e08ec2f06f0bb))


### Dependencies

- Updated @pipewright/pipeline-contract to 0.2.0

## [0.1.2](https://github.com/ExaDev/pipewright/compare/@pipewright/pipeline-bitbucket@0.1.1...@pipewright/pipeline-bitbucket@0.1.2) (2026-10-11)

### Bug Fixes

* **importers:** read what real GitLab, Bitbucket and GitHub files commonly write ([597bb00](https://github.com/ExaDev/pipewright/commit/597bb00abc96ad0b8edba22bdad653d85498750a))


### Dependencies

- Updated @pipewright/pipeline-contract to 0.1.2

## [0.1.1](https://github.com/ExaDev/pipewright/compare/@pipewright/pipeline-bitbucket@0.1.0...@pipewright/pipeline-bitbucket@0.1.1) (2026-10-11)

### Bug Fixes

* check each run step's status explicitly where steps share a script entry ([ff3f469](https://github.com/ExaDev/pipewright/commit/ff3f4693daaeadda65054a8c35933627c26bc609))
* write consecutive run steps as one script entry on GitLab and Bitbucket ([bc87727](https://github.com/ExaDev/pipewright/commit/bc877278490d6773be75606f9dda587a68ab8d23))


### Dependencies

- Updated @pipewright/pipeline-contract to 0.1.1

## [0.1.0](https://github.com/ExaDev/pipewright/compare/@pipewright/pipeline-bitbucket@0.0.0...@pipewright/pipeline-bitbucket@0.1.0) (2026-10-11)

### Features

* **pipeline-bitbucket:** compile the model to bitbucket-pipelines.yml ([430ec5a](https://github.com/ExaDev/pipewright/commit/430ec5af6a8f365e9e52863c5da871b47b9a5ef7))
* **pipeline-bitbucket:** import a bitbucket-pipelines.yml into the neutral model ([fff388e](https://github.com/ExaDev/pipewright/commit/fff388e4263551670486bd5d8a62ceedc2cd166d))

### Bug Fixes

* address the second review round on the provider adapters and runner ([6b95b18](https://github.com/ExaDev/pipewright/commit/6b95b18128f1b96ac05c3165750fdc59b428bf0a))
* guard provider cases the compilers accepted wrongly ([dfb4418](https://github.com/ExaDev/pipewright/commit/dfb4418fbaa7d293a6f2bcda688adff454f94d74))
* **importers:** own a job or step that carries its provider's own settings ([45cf1cf](https://github.com/ExaDev/pipewright/commit/45cf1cf81e2cef02257584fc959a7d6e0711d70b))
* **pipeline-bitbucket:** emit a final step in a custom pipeline ([75905df](https://github.com/ExaDev/pipewright/commit/75905dfdfef8a4281690ccf67b3d2d19fbaab410))
* **pipeline-bitbucket:** own a gated step whole ([1dc83ea](https://github.com/ExaDev/pipewright/commit/1dc83eaae0d723353fce82c664e5386659c7fdb8))
* **pipeline-bitbucket:** read command lines as one shell and reject branch patterns ([e5ea8eb](https://github.com/ExaDev/pipewright/commit/e5ea8eb72f24817d95f1e62651c8383851ba01af))
* **pipeline-bitbucket:** reject a manual step and carry a script with a GitHub expression ([e8434fe](https://github.com/ExaDev/pipewright/commit/e8434fe6d7c80d2dbb53e0e3bb76dee4022a36a0))

### Code Refactoring

* analyse job dependencies with the process-graph dag package ([441a9d7](https://github.com/ExaDev/pipewright/commit/441a9d7a79bc799559063cd23a84a62929a46cab))
* import process-graph through its primary entrypoint ([4d8aa87](https://github.com/ExaDev/pipewright/commit/4d8aa87f816142d6f3ea41cc3e8e0a30dd9f2e78))
* **pipeline-bitbucket:** hold the provider constants in one module ([50a8728](https://github.com/ExaDev/pipewright/commit/50a87280ea1cbbb5e5a76be561082b50ab6db07e))
* rename the workspace packages from [@ci-adapters](https://github.com/ci-adapters) to [@pipewright](https://github.com/pipewright) ([faa70f1](https://github.com/ExaDev/pipewright/commit/faa70f1bbaac40a6bb91735c5d5fea34fc2753b5))

### Build System

* compile each package to dist and check that the packed packages install ([d5c65bd](https://github.com/ExaDev/pipewright/commit/d5c65bdc23b4e91fd866f2b9d673704085143bd4))
* depend on the process-graph dag package ([55c9e4a](https://github.com/ExaDev/pipewright/commit/55c9e4a7041757114b5f2f35f9cb236f04b16013))
* pin dependencies exactly and keep one version of each with syncpack ([840b5d0](https://github.com/ExaDev/pipewright/commit/840b5d0c4590dcbbdb3700afaa12967fe2501f55))
* release from main with semantic-release, as the sibling repositories do ([4644d2e](https://github.com/ExaDev/pipewright/commit/4644d2e18103f0f75a200dfc1f8b2d25d7b93092))

### Chores

* declare the MIT licence on every package ([979692b](https://github.com/ExaDev/pipewright/commit/979692bfc3eccec267c657bb0ff838fd178e4c14))
* scaffold the Bitbucket Pipelines and CircleCI adapter packages ([365f668](https://github.com/ExaDev/pipewright/commit/365f66886548f0d902925587886a1ae839450e87))


### Dependencies

- Updated @pipewright/pipeline-contract to 0.1.0
- Updated @pipewright/yaml-emit to 0.1.0
