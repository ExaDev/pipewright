import { describe, expect, it } from "vitest";

import { ActionReferenceError, parseActionReference } from "../src/action.ts";
import { ActionExpansionError, COMPOSITE_ACTION_MAX_DEPTH } from "../src/composite.ts";
import { expanded, rejectionOf, resolverOf, usesStep, type Files } from "./actions.ts";

/** The workspace: one composite action with inputs, defaults, conditions and environments. */
const WORKSPACE: Files = {
  ".github/actions/build/action.yml": `
name: Build
description: Builds the project
branding:
  icon: package
  color: blue
inputs:
  mode:
    description: How to build
    default: debug
  flags:
    description: Extra flags
    required: true
runs:
  using: composite
  steps:
    - name: Configure
      run: echo mode=\${{ inputs.mode }} flags=\${{ inputs.flags }}
      shell: bash
    - name: Release only
      if: inputs.mode == 'release'
      run: echo releasing
      shell: bash
    - name: Never
      if: 'false'
      run: echo never
      shell: sh
    - name: Report
      run: echo "\${{ env.REPORT }} in $(basename $GITHUB_ACTION_PATH)"
      shell: bash
      env:
        REPORT: on-\${{ github.ref_name }}
      working-directory: \${{ github.action_path }}
`,
};

describe("parseActionReference", () => {
  it("reads each form of a uses value", () => {
    expect(parseActionReference("./.github/actions/build")).toEqual({
      kind: "local",
      path: ".github/actions/build",
    });
    expect(parseActionReference("exadev/pipewright")).toEqual({
      kind: "remote",
      owner: "exadev",
      repo: "pipewright",
      subpath: undefined,
      ref: undefined,
    });
    expect(parseActionReference("exadev/pipewright@v2")).toEqual({
      kind: "remote",
      owner: "exadev",
      repo: "pipewright",
      subpath: undefined,
      ref: "v2",
    });
    expect(parseActionReference("exadev/pipewright/.github/actions/setup@main")).toEqual({
      kind: "remote",
      owner: "exadev",
      repo: "pipewright",
      subpath: ".github/actions/setup",
      ref: "main",
    });
  });

  it("keeps a local path's climb and normalises its stops", () => {
    expect(parseActionReference("./inner/./../sibling")).toEqual({
      kind: "local",
      path: "inner/../sibling",
    });
  });

  it("rejects the values that name no repository tree", () => {
    const rejected = (uses: string): string => {
      try {
        parseActionReference(uses);
      } catch (error) {
        if (!(error instanceof ActionReferenceError)) throw error;

        return error.construct;
      }

      throw new Error(`expected ${JSON.stringify(uses)} to fail`);
    };
    expect(rejected("docker://alpine:3.20")).toBe(
      "a container image, which needs a container runtime; container actions are out of scope on the host",
    );
    expect(rejected("$/path/to/action")).toContain("the same-repository alias");
    expect(rejected("checkout@v4")).toContain("that is not owner/repo");
    expect(rejected("exadev/pipewright/sub/../..@main")).toContain(
      "climbs above the repository it names",
    );
    expect(rejected("exadev/pipewright@")).toContain("no ref after @");
  });
});

describe("expandAction", () => {
  it("expands a local composite action with defaults, conditions and environments", async () => {
    const { steps } = await expanded(
      usesStep("./.github/actions/build", { flags: "--fast" }),
      resolverOf(WORKSPACE),
    );
    const where = "/workspace/.github/actions/build";
    expect(steps).toEqual([
      {
        kind: "run",
        name: "Configure",
        run: "echo mode=debug flags=--fast",
        env: { GITHUB_ACTION_PATH: where },
      },
      {
        kind: "run",
        name: "Report",
        run: 'echo "on-main in $(basename $GITHUB_ACTION_PATH)"',
        env: { REPORT: "on-main", GITHUB_ACTION_PATH: where },
        workingDirectory: where,
      },
    ]);
  });

  it("keeps a step whose condition holds and drops one whose does not", async () => {
    const { steps } = await expanded(
      usesStep("./.github/actions/build", { mode: "release", flags: "-O2" }),
      resolverOf(WORKSPACE),
    );
    expect(steps.map((step) => (step.kind === "run" ? step.name : undefined))).toEqual([
      "Configure",
      "Release only",
      "Report",
    ]);
    expect(steps[1]).toEqual({
      kind: "run",
      name: "Release only",
      run: "echo releasing",
      env: { GITHUB_ACTION_PATH: "/workspace/.github/actions/build" },
    });
  });

  it("expands a same-repository reference served from the checkout", async () => {
    const resolve = resolverOf(WORKSPACE, { "exadev/pipewright@main": WORKSPACE });
    const { steps } = await expanded(
      usesStep("exadev/pipewright/.github/actions/build@main", { flags: "--ci" }),
      resolve,
    );
    expect(steps).toHaveLength(2);
    expect(steps[0]).toEqual({
      kind: "run",
      name: "Configure",
      run: "echo mode=debug flags=--ci",
      env: { GITHUB_ACTION_PATH: "/actions/exadev/pipewright@main/.github/actions/build" },
    });
  });

  it("treats a default written with no value as no default", async () => {
    const files: Files = {
      "action.yml": `
name: Sparse
description: Maps inputs the way published actions declare them
inputs:
  mode:
    description: How to run
    default:
  extra:
    description: An extra flag
    required: true
runs:
  using: composite
  steps:
    - run: echo mode=\${{ inputs.mode }} extra=\${{ inputs.extra }}
      shell: bash
`,
    };
    const { steps } = await expanded(
      usesStep("exadev/sparse@v1", { extra: "--fast" }),
      resolverOf({}, { "exadev/sparse@v1": files }),
    );
    expect(steps[0]).toMatchObject({ run: "echo mode= extra=--fast" });
    const rejected = await rejectionOf(
      expanded(usesStep("exadev/sparse@v1"), resolverOf({}, { "exadev/sparse@v1": files })),
    );
    expect(rejected.message).toContain('the required input "extra"');
  });

  it("expands a remote action's nesting, running a nested node action and carrying a docker reference", async () => {
    const OUTER: Files = {
      "action.yml": `
name: Outer
description: Wraps other actions
inputs:
  name:
    description: Who to greet
    default: world
runs:
  using: composite
  steps:
    - name: Start
      run: echo start
      shell: bash
    - name: Greet
      uses: ./inner
      with:
        who: \${{ inputs.name }}
    - name: Cache
      uses: actions/cache@v4
      with:
        key: build-\${{ github.sha }}
    - name: Scan
      uses: docker://aquasec/trivy:latest
    - name: Finish
      run: echo done
      shell: bash
`,
      "inner/action.yml": `
name: Inner
description: Greets someone
inputs:
  who:
    description: Who
    default: someone
  suffix:
    description: How to end the greeting
    default: '!'
runs:
  using: composite
  steps:
    - run: echo hello \${{ inputs.who }}\${{ inputs.suffix }}
      shell: bash
`,
    };
    const remotes: Readonly<Record<string, Files>> = {
      "exadev/outer@v1": OUTER,
      "actions/cache@v4": {
        "action.yml": `
name: Cache
description: Caches things
inputs:
  key:
    description: The cache key
runs:
  using: node20
  main: dist/index.js
  post: dist/save/index.js
  post-if: success()
`,
      },
    };
    const { steps, post } = await expanded(
      usesStep("exadev/outer@v1", { name: "pipewright" }),
      resolverOf(WORKSPACE, remotes),
    );
    expect(steps).toEqual([
      {
        kind: "run",
        name: "Start",
        run: "echo start",
        env: { GITHUB_ACTION_PATH: "/actions/exadev/outer@v1" },
      },
      {
        kind: "run",
        run: "echo hello pipewright!",
        env: { GITHUB_ACTION_PATH: "/actions/exadev/outer@v1/inner" },
      },
      {
        kind: "run",
        name: "Cache",
        run: "'node' '/actions/actions/cache@v4/dist/index.js'",
        env: { INPUT_KEY: "build-abc123def456", GITHUB_ACTION_PATH: "/actions/actions/cache@v4" },
      },
      {
        kind: "provider",
        provider: "github-actions",
        name: "Scan",
        native: { uses: "docker://aquasec/trivy:latest" },
      },
      {
        kind: "run",
        name: "Finish",
        run: "echo done",
        env: { GITHUB_ACTION_PATH: "/actions/exadev/outer@v1" },
      },
    ]);
    expect(post).toEqual([
      {
        kind: "run",
        name: "Post Cache",
        run: "'node' '/actions/actions/cache@v4/dist/save/index.js'",
        env: { INPUT_KEY: "build-abc123def456", GITHUB_ACTION_PATH: "/actions/actions/cache@v4" },
      },
    ]);
  });

  it("rejects a cycle naming the whole reference chain", async () => {
    const files: Files = {
      "actions/outer/action.yml": `
name: Outer
description: Calls its neighbour
runs:
  using: composite
  steps:
    - uses: ./inner
`,
      "actions/outer/inner/action.yml": `
name: Inner
description: Calls back
runs:
  using: composite
  steps:
    - uses: ./..
`,
    };
    const error = await rejectionOf(expanded(usesStep("./actions/outer"), resolverOf(files)));
    if (!(error instanceof ActionExpansionError)) {
      throw new Error(`expected ActionExpansionError, got ${String(error)}`);
    }
    expect(error.chain).toEqual(["./actions/outer", "./actions/outer/inner", "./actions/outer"]);
    expect(error.message).toContain("already being expanded");
    expect(error.message).toContain("./actions/outer -> ./actions/outer/inner -> ./actions/outer");
  });

  it("expands the bound's depth of nesting and rejects one deeper", async () => {
    const chainOf = (count: number): Record<string, string> => {
      const files: Record<string, string> = {};
      for (let level = 1; level <= count; level += 1) {
        const deepest = level === count;
        // Each level's action lives inside the one before it, because its step's ./ reference is relative to that action's directory.
        const directory = Array.from(
          { length: level },
          (_unused, index) => `a${String(index + 1)}`,
        ).join("/");
        files[`${directory}/action.yml`] = `
name: Level
description: One level of a generated chain
runs:
  using: composite
  steps:
${deepest ? "    - run: echo deepest\n      shell: bash" : `    - uses: ./a${String(level + 1)}`}
`;
      }

      return files;
    };
    const ten = chainOf(COMPOSITE_ACTION_MAX_DEPTH);
    const { steps: within } = await expanded(usesStep("./a1"), resolverOf(ten));
    expect(within).toEqual([
      {
        kind: "run",
        run: "echo deepest",
        env: {
          GITHUB_ACTION_PATH: `/workspace/a1/${Array.from(
            { length: COMPOSITE_ACTION_MAX_DEPTH - 1 },
            (_unused, index) => `a${String(index + 2)}`,
          ).join("/")}`,
        },
      },
    ]);

    const error = await rejectionOf(
      expanded(usesStep("./a1"), resolverOf(chainOf(COMPOSITE_ACTION_MAX_DEPTH + 1))),
    );
    expect(error.message).toContain(
      `nesting ${String(COMPOSITE_ACTION_MAX_DEPTH + 1)} composite actions deep`,
    );
  });

  it("rejects malformed metadata with the file and the pointer", async () => {
    const files: Files = {
      "bad/action.yml": `
name: Bad
description: A step with no shell
runs:
  using: composite
  steps:
    - run: echo hi
`,
    };
    const error = await rejectionOf(expanded(usesStep("./bad"), resolverOf(files)));
    if (!(error instanceof ActionExpansionError)) {
      throw new Error(`expected ActionExpansionError, got ${String(error)}`);
    }
    expect(error.file).toBe("./bad/action.yml");
    expect(error.pointer).toBe("/runs/steps/0/shell");
    expect(error.message).toContain("./bad/action.yml /runs/steps/0/shell");
  });

  it("rejects a step with both run and uses, and a key no composite step has", async () => {
    const files: Files = {
      "both/action.yml": `
name: Both
description: A step that has both
runs:
  using: composite
  steps:
    - run: echo hi
      uses: ./other
      shell: bash
`,
      "unknown-key/action.yml": `
name: Unknown
description: A step key outside the documented set
runs:
  using: composite
  steps:
    - run: echo hi
      shell: bash
      timeout-minutes: 10
`,
    };
    const both = await rejectionOf(expanded(usesStep("./both"), resolverOf(files)));
    expect(both.message).toContain("a step that has both run and uses");
    expect(both.message).toContain("/runs/steps/0");

    const unknown = await rejectionOf(expanded(usesStep("./unknown-key"), resolverOf(files)));
    expect(unknown.message).toContain('Unrecognized key: "timeout-minutes"');
    expect(unknown.message).toContain("/runs/steps/0");
  });

  it("rejects an action whose runs.using names a container image, an undeclared input and an unset required one", async () => {
    const containerAction: Files = {
      "action.yml": "name: Scan\ndescription: Scans\nruns:\n  using: docker\n  image: Dockerfile\n",
    };
    const container = await rejectionOf(
      expanded(
        usesStep("exadev/scan@v1"),
        resolverOf(WORKSPACE, { "exadev/scan@v1": containerAction }),
      ),
    );
    expect(container.message).toContain('runs.using "docker"');
    expect(container.message).toContain("out of scope on the host");
    expect(container.message).toContain("/runs/using");

    const undeclared = await rejectionOf(
      expanded(
        usesStep("./.github/actions/build", { flags: "-v", extra: "1" }),
        resolverOf(WORKSPACE),
      ),
    );
    expect(undeclared.message).toContain('the input "extra", which the action does not declare');

    const required = await rejectionOf(
      expanded(usesStep("./.github/actions/build"), resolverOf(WORKSPACE)),
    );
    expect(required.message).toContain(
      'the required input "flags", which no with supplied and which declares no default',
    );
  });

  it("rejects a shell and a continue-on-error the model has no form for", async () => {
    const files: Files = {
      "pwsh/action.yml": `
name: Powershell
description: A step in another interpreter
runs:
  using: composite
  steps:
    - run: Write-Output hi
      shell: pwsh
`,
      "tolerant/action.yml": `
name: Tolerant
description: A step that may not fail the job
runs:
  using: composite
  steps:
    - run: rm -rf out
      shell: bash
      continue-on-error: true
`,
    };
    const pwsh = await rejectionOf(expanded(usesStep("./pwsh"), resolverOf(files)));
    expect(pwsh.message).toContain('the shell "pwsh"');
    expect(pwsh.message).toContain("/runs/steps/0/shell");

    const tolerant = await rejectionOf(expanded(usesStep("./tolerant"), resolverOf(files)));
    expect(tolerant.message).toContain("continue-on-error");
  });

  it("rejects a step that is not a provider step of this provider", async () => {
    const error = await rejectionOf(
      expanded({ kind: "run", run: "echo hi" }, resolverOf(WORKSPACE)),
    );
    expect(error.message).toContain("a step that is not a provider step");
  });
});
