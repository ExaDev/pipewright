import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { type ActionResolver, type ActionTree } from "../src/composite.ts";
import { inputEnvironmentName, type NodeRunner } from "../src/node.ts";
import { expanded, rejectionOf, resolverOf, usesStep, type Files } from "./actions.ts";

describe("inputEnvironmentName", () => {
  it("derives the variable the runner passes an input as", () => {
    expect(inputEnvironmentName("who")).toBe("INPUT_WHO");
    expect(inputEnvironmentName("foo bar")).toBe("INPUT_FOO_BAR");
    expect(inputEnvironmentName("cache-key")).toBe("INPUT_CACHE-KEY");
  });
});

describe("a node action", () => {
  const GREET: Files = {
    "action.yml": `
name: Greet
description: Greets someone
inputs:
  who:
    description: Who to greet
    default: world
  cache-key:
    description: A key with a hyphen
    required: true
runs:
  using: node20
  main: dist/index.js
`,
  };

  it("accepts the root outputs and a null default a published action declares", async () => {
    // The shapes actions/checkout itself declares: outputs at the root with descriptions only, and inputs whose default is written with no value.
    const files: Files = {
      "action.yml": `
name: Checkout
description: Checks a repository out
outputs:
  ref:
    description: The ref that was checked out
  commit:
    description: The commit SHA that was checked out
inputs:
  repository:
    description: Repository name with owner
    default:
  ref:
    description: The ref to checkout
runs:
  using: node24
  main: dist/index.js
  post: dist/index.js
`,
    };
    const { steps, post } = await expanded(
      usesStep("exadev/checkout@v1", { repository: "exadev/pipewright" }),
      resolverOf({}, { "exadev/checkout@v1": files }),
    );
    expect(steps[0]?.kind).toBe("run");
    expect(post).toHaveLength(1);
  });

  it("expands the main entry into a run step with the inputs and the action path", async () => {
    const { steps, pre, post } = await expanded(
      usesStep("exadev/greet@v1", { "cache-key": "build-main" }),
      resolverOf({}, { "exadev/greet@v1": GREET }),
    );
    expect(steps).toEqual([
      {
        kind: "run",
        run: "'node' '/actions/exadev/greet@v1/dist/index.js'",
        env: {
          INPUT_WHO: "world",
          "INPUT_CACHE-KEY": "build-main",
          GITHUB_ACTION_PATH: "/actions/exadev/greet@v1",
        },
      },
    ]);
    expect(pre).toEqual([]);
    expect(post).toEqual([]);
  });

  it("carries the workflow step's name and accepts every node runtime the runner names", async () => {
    await Promise.all(
      ["node20", "node16", "node12", "node24"].map(async (using) => {
        const files: Files = {
          "action.yml": `name: Setup\ndescription: Sets up\nruns:\n  using: ${using}\n  main: index.js\n`,
        };
        const { steps } = await expanded(
          {
            kind: "provider",
            provider: "github-actions",
            name: "Set things up",
            native: { uses: "exadev/setup@v1" },
          },
          resolverOf({}, { "exadev/setup@v1": files }),
        );
        const step = steps[0];
        if (step?.kind !== "run") throw new Error("expected a run step");
        expect(step.name).toBe("Set things up");
        expect(step.run).toBe("'node' '/actions/exadev/setup@v1/index.js'");
      }),
    );
  });

  it("builds the command from the host's node invocation", async () => {
    const pinned: NodeRunner = async () =>
      Promise.resolve({ command: "/opt/node/bin/node", args: ["--experimental-vm-modules"] });
    const { steps } = await expanded(
      usesStep("exadev/setup@v1"),
      resolverOf(
        {},
        {
          "exadev/setup@v1": {
            "action.yml":
              "name: Setup\ndescription: Sets up\nruns:\n  using: node20\n  main: index.js\n",
          },
        },
      ),
      pinned,
    );
    const step = steps[0];
    if (step?.kind !== "run") throw new Error("expected a run step");
    expect(step.run).toBe(
      "'/opt/node/bin/node' '--experimental-vm-modules' '/actions/exadev/setup@v1/index.js'",
    );
  });

  it("returns pre and post steps when their conditions allow", async () => {
    const files: Files = {
      "action.yml": `
name: Cache
description: Caches things
runs:
  using: node16
  main: dist/restore/index.js
  pre: dist/pre/index.js
  pre-if: github.ref_name == 'main'
  post: dist/save/index.js
  post-if: success()
`,
    };
    const { pre, post } = await expanded(
      usesStep("exadev/cache@v3"),
      resolverOf({}, { "exadev/cache@v3": files }),
    );
    expect(pre).toEqual([
      {
        kind: "run",
        name: "Pre exadev/cache@v3",
        run: "'node' '/actions/exadev/cache@v3/dist/pre/index.js'",
        env: { GITHUB_ACTION_PATH: "/actions/exadev/cache@v3" },
      },
    ]);
    expect(post).toEqual([
      {
        kind: "run",
        name: "Post exadev/cache@v3",
        run: "'node' '/actions/exadev/cache@v3/dist/save/index.js'",
        env: { GITHUB_ACTION_PATH: "/actions/exadev/cache@v3" },
      },
    ]);
  });

  it("leaves out a phase whose condition does not allow it", async () => {
    const files: Files = {
      "action.yml": `
name: Cache
description: Caches things
runs:
  using: node20
  main: dist/restore/index.js
  pre: dist/pre/index.js
  pre-if: github.ref_name == 'dev'
  post: dist/save/index.js
`,
    };
    const { pre, post } = await expanded(
      usesStep("exadev/cache@v3"),
      resolverOf({}, { "exadev/cache@v3": files }),
    );
    expect(pre).toEqual([]);
    expect(post).toHaveLength(1);
  });

  it("rejects a pre a local action declares, an unknown interpreter and a bad node document", async () => {
    const workspace: Files = {
      "local/action.yml":
        "name: Local\ndescription: Local\nruns:\n  using: node20\n  main: index.js\n  pre: pre.js\n",
    };
    const local = await rejectionOf(expanded(usesStep("./local"), resolverOf(workspace)));
    expect(local.message).toContain("not supported for a local action");
    expect(local.message).toContain("/runs/pre");

    const interpreter = await rejectionOf(
      expanded(
        usesStep("exadev/python@v1"),
        resolverOf(
          {},
          {
            "exadev/python@v1": {
              "action.yml": "name: Py\ndescription: Py\nruns:\n  using: python\n  main: main.py\n",
            },
          },
        ),
      ),
    );
    expect(interpreter.message).toContain('runs.using "python"');
    expect(interpreter.message).toContain("/runs/using");

    const malformed = await rejectionOf(
      expanded(
        usesStep("exadev/bad@v1"),
        resolverOf(
          {},
          {
            "exadev/bad@v1": {
              "action.yml": "name: Bad\ndescription: Bad\nruns:\n  using: node20\n  pre: pre.js\n",
            },
          },
        ),
      ),
    );
    expect(malformed.message).toContain("a node action");
    expect(malformed.message).toContain("/runs/main");
  });

  it("rejects an input the action does not declare", async () => {
    const error = await rejectionOf(
      expanded(
        usesStep("exadev/greet@v1", { who: "you", "cache-key": "k", extra: "1" }),
        resolverOf({}, { "exadev/greet@v1": GREET }),
      ),
    );
    expect(error.message).toContain('the input "extra", which the action does not declare');
  });

  it("runs the expanded command end to end with the host's node, writing GITHUB_OUTPUT", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pipewright-node-action-"));
    await writeFile(
      join(directory, "action.yml"),
      "name: Greet\ndescription: Greets someone\ninputs:\n  who:\n    description: Who to greet\n    default: world\nruns:\n  using: node20\n  main: main.js\n",
    );
    await writeFile(
      join(directory, "main.js"),
      "const fs = require('node:fs');\nfs.appendFileSync(process.env.GITHUB_OUTPUT, `who=${process.env.INPUT_WHO}\\n`);\n",
    );
    const tree: ActionTree = {
      path: directory,
      read: async (path) => readFile(join(directory, path), "utf8"),
      local: async () => Promise.reject(new Error("the fixture holds no nested local action")),
    };
    const resolve: ActionResolver = async () => Promise.resolve(tree);
    const host: NodeRunner = async () => Promise.resolve({ command: process.execPath, args: [] });
    const { steps } = await expanded(
      usesStep("exadev/greet@v1", { who: "pipewright" }),
      resolve,
      host,
    );
    const step = steps[0];
    if (step?.kind !== "run") throw new Error("expected the main entry as a run step");
    expect(step.run).toBe(`'${process.execPath}' '${join(directory, "main.js")}'`);

    // The runner's own wiring: the step's environment plus the output file command variables.
    const output = join(directory, "github-output.txt");
    execFileSync("/bin/sh", ["-c", step.run], { env: { ...step.env, GITHUB_OUTPUT: output } });
    expect(await readFile(output, "utf8")).toBe("who=pipewright\n");
  });
});
