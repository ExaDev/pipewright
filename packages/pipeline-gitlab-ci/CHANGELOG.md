## [0.2.2](https://github.com/ExaDev/pipewright/compare/@pipewright/pipeline-gitlab-ci@0.2.1...@pipewright/pipeline-gitlab-ci@0.2.2) (2026-10-11)


### Dependencies

- Updated @pipewright/pipeline-contract to 0.4.0

## [0.2.1](https://github.com/ExaDev/pipewright/compare/@pipewright/pipeline-gitlab-ci@0.2.0...@pipewright/pipeline-gitlab-ci@0.2.1) (2026-10-11)


### Dependencies

- Updated @pipewright/pipeline-contract to 0.3.0

## [0.2.0](https://github.com/ExaDev/pipewright/compare/@pipewright/pipeline-gitlab-ci@0.1.2...@pipewright/pipeline-gitlab-ci@0.2.0) (2026-10-11)

### Features

* **gitlab-ci:** carry top-level settings and hidden jobs at pipeline level ([382b5ac](https://github.com/ExaDev/pipewright/commit/382b5ac8761dc7fa7bc7162e5e5fc1a5daaf7f87))


### Dependencies

- Updated @pipewright/pipeline-contract to 0.2.0

## [0.1.2](https://github.com/ExaDev/pipewright/compare/@pipewright/pipeline-gitlab-ci@0.1.1...@pipewright/pipeline-gitlab-ci@0.1.2) (2026-10-11)

### Bug Fixes

* **gitlab-ci:** apply default runner tags only to jobs whose inherit.default allows them ([c5ae96b](https://github.com/ExaDev/pipewright/commit/c5ae96b86494b6e956a4ee409f60716b544cfd7d))
* **importers:** read what real GitLab, Bitbucket and GitHub files commonly write ([597bb00](https://github.com/ExaDev/pipewright/commit/597bb00abc96ad0b8edba22bdad653d85498750a))


### Dependencies

- Updated @pipewright/pipeline-contract to 0.1.2

## [0.1.1](https://github.com/ExaDev/pipewright/compare/@pipewright/pipeline-gitlab-ci@0.1.0...@pipewright/pipeline-gitlab-ci@0.1.1) (2026-10-11)

### Bug Fixes

* check each run step's status explicitly where steps share a script entry ([ff3f469](https://github.com/ExaDev/pipewright/commit/ff3f4693daaeadda65054a8c35933627c26bc609))
* **gitlab-ci:** stop a multi-line script entry at its first failing command ([efc9853](https://github.com/ExaDev/pipewright/commit/efc985374888a207c3d437a1913d7546cbca10cf))
* write consecutive run steps as one script entry on GitLab and Bitbucket ([bc87727](https://github.com/ExaDev/pipewright/commit/bc877278490d6773be75606f9dda587a68ab8d23))


### Dependencies

- Updated @pipewright/pipeline-contract to 0.1.1

## [0.1.0](https://github.com/ExaDev/pipewright/compare/@pipewright/pipeline-gitlab-ci@0.0.0...@pipewright/pipeline-gitlab-ci@0.1.0) (2026-10-11)

### Features

* add the gate policy and feature flags to the conformance sample ([40f5a21](https://github.com/ExaDev/pipewright/commit/40f5a21152a90b4de86893e023f77983a60125a2))
* add the GitLab CI adapter and the wrapper form ([2dc7b23](https://github.com/ExaDev/pipewright/commit/2dc7b239896e16d12852411be9216fe728afe90f))
* **check-names:** derive required check names from a pipeline ([2b29976](https://github.com/ExaDev/pipewright/commit/2b29976dc03fdf05f13cbe929426339bb5cd6751))
* **pipeline-gitlab-ci:** import a .gitlab-ci.yml into the neutral model ([223bcaa](https://github.com/ExaDev/pipewright/commit/223bcaa318136e271d6c876d1395facb98509ce0))
* **pipeline-gitlab-ci:** read a job with no tags as one with no runner label ([396b3f0](https://github.com/ExaDev/pipewright/commit/396b3f0bf2f58506edef950fc90bde4a9733c1ec))
* **pipeline-gitlab-ci:** render the wrapper form ([b910f42](https://github.com/ExaDev/pipewright/commit/b910f42402bb0504a7eab63203bb397e35d9ae43))

### Bug Fixes

* address the second review round on the provider adapters and runner ([6b95b18](https://github.com/ExaDev/pipewright/commit/6b95b18128f1b96ac05c3165750fdc59b428bf0a))
* guard provider cases the compilers accepted wrongly ([dfb4418](https://github.com/ExaDev/pipewright/commit/dfb4418fbaa7d293a6f2bcda688adff454f94d74))
* **pipeline-gitlab-ci:** brace a variable written inside text ([4b30509](https://github.com/ExaDev/pipewright/commit/4b305095698502a00e032e27beda7ab242cf7b63))
* **pipeline-gitlab-ci:** own a gated job whole and keep a literal dollar from expanding ([c6bdd59](https://github.com/ExaDev/pipewright/commit/c6bdd5949352b5634d1c873b98f1a69793140fac))
* **pipeline-gitlab-ci:** own a job with GitLab's own settings and read only constant comparisons ([dba1ce3](https://github.com/ExaDev/pipewright/commit/dba1ce3dbd830d47c9785707c622f6b701c748bf))
* **pipeline-gitlab-ci:** read stage order, shells and global variables as GitLab runs them ([bd0c0f2](https://github.com/ExaDev/pipewright/commit/bd0c0f2f11d35343a5101c401aa352f36e9e6cd8))
* **pipeline-gitlab-ci:** reject a manual start and carry a script with a GitHub expression ([666415a](https://github.com/ExaDev/pipewright/commit/666415a7bfca11cf32f9096f832b2f9e4aad7104))

### Code Refactoring

* analyse job dependencies with the process-graph dag package ([441a9d7](https://github.com/ExaDev/pipewright/commit/441a9d7a79bc799559063cd23a84a62929a46cab))
* bring the packages in line with the workspace lint rules ([42eb445](https://github.com/ExaDev/pipewright/commit/42eb445c1e1681f89d957988d58bdb99c712fe6c))
* import process-graph through its primary entrypoint ([4d8aa87](https://github.com/ExaDev/pipewright/commit/4d8aa87f816142d6f3ea41cc3e8e0a30dd9f2e78))
* **pipeline-gitlab-ci:** hold the provider vocabulary in one module ([e26132e](https://github.com/ExaDev/pipewright/commit/e26132e311a6259c413190826f5090d13307749f))
* **pipeline-gitlab-ci:** take job ids from the contract's uniqueJobIds ([8775b9f](https://github.com/ExaDev/pipewright/commit/8775b9f867c14c8115dcce031d3baea99808f582))
* rename the workspace packages from [@ci-adapters](https://github.com/ci-adapters) to [@pipewright](https://github.com/pipewright) ([faa70f1](https://github.com/ExaDev/pipewright/commit/faa70f1bbaac40a6bb91735c5d5fea34fc2753b5))
* share dependency levels and add feature flags to the conformance sample ([1c10db5](https://github.com/ExaDev/pipewright/commit/1c10db5b2532236ff15e016e18e6393eb2f3aed2))

### Tests

* **pipeline-gitlab-ci:** compare the sample's output with its golden file ([bc13540](https://github.com/ExaDev/pipewright/commit/bc13540afe584ac5f08c56c63b172cf921cfef08))

### Build System

* compile each package to dist and check that the packed packages install ([d5c65bd](https://github.com/ExaDev/pipewright/commit/d5c65bdc23b4e91fd866f2b9d673704085143bd4))
* depend on the process-graph dag package ([55c9e4a](https://github.com/ExaDev/pipewright/commit/55c9e4a7041757114b5f2f35f9cb236f04b16013))
* pin dependencies exactly and keep one version of each with syncpack ([840b5d0](https://github.com/ExaDev/pipewright/commit/840b5d0c4590dcbbdb3700afaa12967fe2501f55))
* release from main with semantic-release, as the sibling repositories do ([4644d2e](https://github.com/ExaDev/pipewright/commit/4644d2e18103f0f75a200dfc1f8b2d25d7b93092))

### Chores

* declare the MIT licence on every package ([979692b](https://github.com/ExaDev/pipewright/commit/979692bfc3eccec267c657bb0ff838fd178e4c14))


### Dependencies

- Updated @pipewright/pipeline-contract to 0.1.0
- Updated @pipewright/yaml-emit to 0.1.0
