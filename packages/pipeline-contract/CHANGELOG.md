## [0.1.2](https://github.com/ExaDev/pipewright/compare/@pipewright/pipeline-contract@0.1.1...@pipewright/pipeline-contract@0.1.2) (2026-10-11)

### Bug Fixes

* **importers:** read what real GitLab, Bitbucket and GitHub files commonly write ([597bb00](https://github.com/ExaDev/pipewright/commit/597bb00abc96ad0b8edba22bdad653d85498750a))

## [0.1.1](https://github.com/ExaDev/pipewright/compare/@pipewright/pipeline-contract@0.1.0...@pipewright/pipeline-contract@0.1.1) (2026-10-11)

### Bug Fixes

* check each run step's status explicitly where steps share a script entry ([ff3f469](https://github.com/ExaDev/pipewright/commit/ff3f4693daaeadda65054a8c35933627c26bc609))

## [0.1.0](https://github.com/ExaDev/pipewright/compare/@pipewright/pipeline-contract@0.0.0...@pipewright/pipeline-contract@0.1.0) (2026-10-11)

### Features

* add the gate policy and feature flags to the conformance sample ([40f5a21](https://github.com/ExaDev/pipewright/commit/40f5a21152a90b4de86893e023f77983a60125a2))
* add the GitLab CI adapter and the wrapper form ([2dc7b23](https://github.com/ExaDev/pipewright/commit/2dc7b239896e16d12852411be9216fe728afe90f))
* author pipelines in TypeScript through definePipeline ([1899e5d](https://github.com/ExaDev/pipewright/commit/1899e5d395f9f97d041746fff11e987a55f14a0c))
* **check-names:** derive required check names from a pipeline ([2b29976](https://github.com/ExaDev/pipewright/commit/2b29976dc03fdf05f13cbe929426339bb5cd6751))
* let a run step opt out of the wrapper form, and add the actions permission scope ([929bb84](https://github.com/ExaDev/pipewright/commit/929bb84b6e8c94914d38ff43fb9fcd30ac0431cf))
* **pipeline-contract:** define the importer contract and its round-trip conformance kit ([53ba649](https://github.com/ExaDev/pipewright/commit/53ba649c9998466e059f95d4f5d8e410ca8545b8))
* **pipeline-contract:** define the pipeline model, composition loader and conformance kits ([dcfa232](https://github.com/ExaDev/pipewright/commit/dcfa2327aa44766c7c9c06033165361a0b025839))
* **pipeline-contract:** derive unique job ids from display names ([3033a34](https://github.com/ExaDev/pipewright/commit/3033a341162b66166b77177af28e21e45ecdc104))
* **pipeline-contract:** let a job name no runner label ([557f158](https://github.com/ExaDev/pipewright/commit/557f15872dc07f7e44b4a60d8d9fb2fa7721d086))
* **pipeline-contract:** let the importer kit compare jobs by name and skip the gate policy ([193dfbe](https://github.com/ExaDev/pipewright/commit/193dfbee3341df2222c1ab6bb9e35343bd34712e))
* **pipeline-contract:** share one parsed-condition form between importers ([a62b23e](https://github.com/ExaDev/pipewright/commit/a62b23e463c6cbf65440ced4cf48446691faaabe))
* typed references, matrix axes, job handles and condition builders ([d153abe](https://github.com/ExaDev/pipewright/commit/d153abea88e2b4645b46ab501a1e8f3d46f9e99a))

### Bug Fixes

* address the second review round on the provider adapters and runner ([6b95b18](https://github.com/ExaDev/pipewright/commit/6b95b18128f1b96ac05c3165750fdc59b428bf0a))
* read run context lazily, detect Bitbucket and CircleCI, and locate import-time errors ([65cb26b](https://github.com/ExaDev/pipewright/commit/65cb26bf3beafdfa4e3725d68bcaca805e74ff0c))
* restrict a step's form to native and decode every documented check conclusion ([3611028](https://github.com/ExaDev/pipewright/commit/3611028e4396356d1ed9ef9b7c4d2ba087107f31))

### Code Refactoring

* analyse job dependencies with the process-graph dag package ([441a9d7](https://github.com/ExaDev/pipewright/commit/441a9d7a79bc799559063cd23a84a62929a46cab))
* bring the packages in line with the workspace lint rules ([42eb445](https://github.com/ExaDev/pipewright/commit/42eb445c1e1681f89d957988d58bdb99c712fe6c))
* compose pipeline documents with @exadev/json-compose ([ff3a607](https://github.com/ExaDev/pipewright/commit/ff3a6073b6ab53389ce6953e8dd6a057efb6ccf5))
* import process-graph through its primary entrypoint ([4d8aa87](https://github.com/ExaDev/pipewright/commit/4d8aa87f816142d6f3ea41cc3e8e0a30dd9f2e78))
* rename the workspace packages from [@ci-adapters](https://github.com/ci-adapters) to [@pipewright](https://github.com/pipewright) ([faa70f1](https://github.com/ExaDev/pipewright/commit/faa70f1bbaac40a6bb91735c5d5fea34fc2753b5))
* share dependency levels and add feature flags to the conformance sample ([1c10db5](https://github.com/ExaDev/pipewright/commit/1c10db5b2532236ff15e016e18e6393eb2f3aed2))

### Build System

* add the process-graph schema, projection and domain packages ([bfb1d53](https://github.com/ExaDev/pipewright/commit/bfb1d53690f9f6fcaf9a866081a6dd4d056dc82f))
* compile each package to dist and check that the packed packages install ([d5c65bd](https://github.com/ExaDev/pipewright/commit/d5c65bdc23b4e91fd866f2b9d673704085143bd4))
* depend on @exadev/json-compose in pipeline-contract ([6a631e5](https://github.com/ExaDev/pipewright/commit/6a631e5fdb4ab51cc7d705a3185cd21c8fb74521))
* depend on the process-graph dag package ([55c9e4a](https://github.com/ExaDev/pipewright/commit/55c9e4a7041757114b5f2f35f9cb236f04b16013))
* pin dependencies exactly and keep one version of each with syncpack ([840b5d0](https://github.com/ExaDev/pipewright/commit/840b5d0c4590dcbbdb3700afaa12967fe2501f55))
* release from main with semantic-release, as the sibling repositories do ([4644d2e](https://github.com/ExaDev/pipewright/commit/4644d2e18103f0f75a200dfc1f8b2d25d7b93092))
* release the packages from a tag, and ship the schemas in the contract ([05edaa8](https://github.com/ExaDev/pipewright/commit/05edaa8f3fc89a15a1056ce3ed4c44f3866d1a3e))

### Chores

* declare the MIT licence on every package ([979692b](https://github.com/ExaDev/pipewright/commit/979692bfc3eccec267c657bb0ff838fd178e4c14))
* share zod, yaml and ajv versions through a pnpm catalog ([ab538d9](https://github.com/ExaDev/pipewright/commit/ab538d9e7d06fc14123ad1c3a4f0796d02f4ac1c))
