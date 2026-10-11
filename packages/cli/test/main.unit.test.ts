import { describe, expect, it } from "vitest";

import type { CommandExecution, StepScratch } from "@pipewright/pipeline-contract";

import { main, resolveContext, type Io } from "../src/index.ts";

const SCHEMA = "https://unpkg.com/@pipewright/pipeline-contract/dist/pipeline.schema.json";

const pipeline = {
  $schema: SCHEMA,
  name: "CI",
  triggers: [{ kind: "push", branches: ["main"] }],
  jobs: {
    lint: {
      name: "Lint",
      runsOn: ["ubuntu-latest"],
      steps: [{ kind: "run", run: "pnpm run lint" }],
    },
    gate: {
      name: "Required checks",
      runsOn: ["ubuntu-latest"],
      needs: ["lint"],
      needsPolicy: "gate",
      steps: [{ kind: "run", run: "echo gate" }],
    },
  },
};

interface Harness {
  readonly io: Io;
  readonly out: string[];
  readonly err: string[];
  readonly files: Map<string, string>;
  readonly commands: string[];
  readonly executions: CommandExecution[];
}

/** What each executed command leaves behind: the stdout it produced and the contents it wrote to the command files its environment names. */
interface HarnessScript {
  readonly stdout: string;
  readonly writes: Partial<Record<"output" | "env" | "path" | "summary", string>>;
}

interface HarnessOptions {
  readonly files?: Record<string, unknown>;
  readonly modules?: Record<string, unknown>;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly failing?: (command: string) => boolean;
  readonly script?: (execution: CommandExecution) => HarnessScript;
}

/** The scratch over the harness's own file store, so a scripted executor can write the command files by the paths the runner passed. */
function storeScratch(store: Map<string, string>): StepScratch {
  let stepCount = 0;

  return {
    async create() {
      const files = {
        output: `.scratch/${String(stepCount)}/output`,
        env: `.scratch/${String(stepCount)}/env`,
        path: `.scratch/${String(stepCount)}/path`,
        summary: `.scratch/${String(stepCount)}/summary`,
      };
      stepCount += 1;
      for (const path of [files.output, files.env, files.path, files.summary]) {
        store.set(path, "");
      }

      return Promise.resolve(files);
    },
    async release(files) {
      for (const path of [files.output, files.env, files.path, files.summary]) {
        store.delete(path);
      }

      return Promise.resolve();
    },
    async dispose() {
      for (const path of [...store.keys()]) {
        if (path.startsWith(".scratch/")) store.delete(path);
      }

      return Promise.resolve();
    },
    async read(files) {
      const content = (path: string): string => {
        const value = store.get(path);
        if (value === undefined) throw new Error(`no such file ${path}`);

        return value;
      };

      return Promise.resolve({
        output: content(files.output),
        env: content(files.env),
        path: content(files.path),
        summary: content(files.summary),
      });
    },
  };
}

function harness(options: HarnessOptions = {}): Harness {
  const {
    files = { "ci/ci.pipeline.json": pipeline },
    env = {},
    failing = () => false,
    modules = {},
    script = (): HarnessScript => ({ stdout: "", writes: {} }),
  } = options;
  const store = new Map(
    Object.entries(files).map(([path, value]) => [
      path,
      typeof value === "string" ? value : JSON.stringify(value),
    ]),
  );
  const out: string[] = [];
  const err: string[] = [];
  const commands: string[] = [];
  const executions: CommandExecution[] = [];
  const io: Io = {
    cwd: "/repo",
    env,
    stdout(text) {
      out.push(text);
    },
    stderr(text) {
      err.push(text);
    },
    reader: {
      async read(path) {
        const content = store.get(path);

        return content === undefined
          ? Promise.reject(new Error(`no such file ${path}`))
          : Promise.resolve(content);
      },
    },
    readOptional: async (path) => Promise.resolve(store.get(path)),
    async writeFile(path, content) {
      store.set(path, content);

      return Promise.resolve();
    },
    scratch: storeScratch(store),
    executor: {
      async execute(execution) {
        commands.push(execution.command);
        executions.push(execution);
        const answer = script(execution);
        const variables = {
          output: "GITHUB_OUTPUT",
          env: "GITHUB_ENV",
          path: "GITHUB_PATH",
          summary: "GITHUB_STEP_SUMMARY",
        } as const;
        for (const file of ["output", "env", "path", "summary"] as const) {
          const content = answer.writes[file];
          if (content === undefined) continue;
          const path = execution.env[variables[file]];
          if (path === undefined) throw new Error(`the runner did not pass ${variables[file]}`);
          store.set(path, content);
        }

        return Promise.resolve({
          exitCode: failing(execution.command) ? 1 : 0,
          stdout: answer.stdout,
          stderr: "",
        });
      },
    },
    async importModule(path) {
      const exports = modules[path];
      if (exports === undefined) throw new Error(`no such module ${path}`);

      return Promise.resolve(exports);
    },
    fetch: async () => Promise.reject(new Error("network is not available in this test")),
  };

  return { io, out, err, files: store, commands, executions };
}

const EMIT = ["--pipeline", "ci/ci.pipeline.json", "--provider", "github-actions"];

describe("emit and check", () => {
  it("writes the provider file, after which check reports no drift", async () => {
    const h = harness();
    expect(await main(["emit", ...EMIT], h.io)).toBe(0);
    expect(h.files.get(".github/workflows/ci.yml")).toContain("name: CI");
    expect(await main(["check", ...EMIT], h.io)).toBe(0);
    expect(h.out.join("")).toContain("no drift");
  });

  it("reports a missing file and a hand-edited file as drift with a failing exit code", async () => {
    const h = harness();
    expect(await main(["check", ...EMIT], h.io)).toBe(1);
    expect(h.err.join("")).toContain("missing: .github/workflows/ci.yml");

    await main(["emit", ...EMIT], h.io);
    h.files.set(".github/workflows/ci.yml", "edited by hand\n");
    h.err.length = 0;
    expect(await main(["check", ...EMIT], h.io)).toBe(1);
    expect(h.err.join("")).toContain("changed: .github/workflows/ci.yml");
  });

  it("emits GitLab configuration for the same pipeline file", async () => {
    const h = harness();
    expect(
      await main(["emit", "--pipeline", "ci/ci.pipeline.json", "--provider", "gitlab-ci"], h.io),
    ).toBe(0);
    expect(h.files.get(".gitlab-ci.yml")).toContain("workflow:");
  });

  it("fails with the source file and pointer for an invalid document", async () => {
    const h = harness({
      files: { "ci/ci.pipeline.json": { ...pipeline, jobs: { lint: { name: "Lint" } } } },
    });
    expect(await main(["emit", ...EMIT], h.io)).toBe(1);
    expect(h.err.join("")).toContain("ci/ci.pipeline.json#/jobs/lint");
  });

  it("rejects an unknown provider by name", async () => {
    const h = harness();
    expect(
      await main(["emit", "--pipeline", "ci/ci.pipeline.json", "--provider", "nope"], h.io),
    ).toBe(1);
    expect(h.err.join("")).toContain("unknown provider nope");
  });

  it("writes the wrapper form with the given tool command", async () => {
    const h = harness({ files: { "ci/ci.pipeline.json": { ...pipeline, form: "wrapper" } } });
    expect(await main(["emit", ...EMIT, "--tool-command", "node tool/bin.ts"], h.io)).toBe(0);
    expect(h.files.get(".github/workflows/ci.yml")).toContain(
      "node tool/bin.ts run --pipeline ci/ci.pipeline.json --job lint --steps 0-0",
    );
  });
});

describe("TypeScript pipelines", () => {
  const definition = {
    name: "CI",
    triggers: [{ kind: "push" }],
    jobs: {
      lint: {
        name: "Lint",
        runsOn: ["ubuntu-latest"],
        steps: [{ kind: "run", run: "pnpm run lint" }],
      },
    },
  };

  it("emits from the default export of a TypeScript module", async () => {
    const h = harness({ modules: { "ci/ci.pipeline.ts": { default: definition } } });
    expect(
      await main(["emit", "--pipeline", "ci/ci.pipeline.ts", "--provider", "github-actions"], h.io),
    ).toBe(0);
    expect(h.files.get(".github/workflows/ci.yml")).toContain(
      "# Generated from ci/ci.pipeline.ts by pipewright.",
    );
  });

  it("locates a violation by module and pointer", async () => {
    const h = harness({
      modules: {
        "ci/ci.pipeline.ts": { default: { ...definition, jobs: { lint: { name: "Lint" } } } },
      },
    });
    expect(
      await main(["emit", "--pipeline", "ci/ci.pipeline.ts", "--provider", "github-actions"], h.io),
    ).toBe(1);
    expect(h.err.join("")).toContain("ci/ci.pipeline.ts#/jobs/lint/runsOn");
  });

  it("escapes a slash in a record key when it locates a violation", async () => {
    const h = harness({
      modules: {
        "ci/ci.pipeline.ts": {
          default: { ...definition, env: { "A/B": "{{ nope }}" } },
        },
      },
    });
    expect(
      await main(["emit", "--pipeline", "ci/ci.pipeline.ts", "--provider", "github-actions"], h.io),
    ).toBe(1);
    expect(h.err.join("")).toContain("ci/ci.pipeline.ts#/env/A~1B");
  });

  it("rejects a module with no default export", async () => {
    const h = harness({ modules: { "ci/ci.pipeline.ts": {} } });
    expect(
      await main(["emit", "--pipeline", "ci/ci.pipeline.ts", "--provider", "github-actions"], h.io),
    ).toBe(1);
  });
});

describe("run", () => {
  const context = [
    "--context",
    "event=push",
    "--context",
    "refName=main",
    "--context",
    "baseRefName=",
    "--context",
    "sha=abc",
    "--context",
    "repository=o/r",
    "--context",
    "workflow=CI",
    "--context",
    "runId=1",
  ];

  it("executes the pipeline directly with no emitted file", async () => {
    const h = harness();
    expect(await main(["run", "--pipeline", "ci/ci.pipeline.json", ...context], h.io)).toBe(0);
    expect(h.commands).toEqual(["pnpm run lint", "echo gate"]);
    expect(h.files.has(".github/workflows/ci.yml")).toBe(false);
  });

  it("exits non-zero when a step fails and reports the gate failed without running it", async () => {
    const h = harness({ failing: (command: string) => command === "pnpm run lint" });
    expect(await main(["run", "--pipeline", "ci/ci.pipeline.json", ...context], h.io)).toBe(1);
    expect(h.commands).toEqual(["pnpm run lint"]);
  });

  it("runs one job and one step range as the wrapper form asks", async () => {
    const h = harness();
    expect(
      await main(
        ["run", "--pipeline", "ci/ci.pipeline.json", "--job", "lint", "--steps", "0-0", ...context],
        h.io,
      ),
    ).toBe(0);
    expect(h.commands).toEqual(["pnpm run lint"]);
  });

  it("derives the context from the GitHub Actions environment", async () => {
    const h = harness({
      env: {
        GITHUB_ACTIONS: "true",
        GITHUB_EVENT_NAME: "pull_request",
        GITHUB_REF_NAME: "feature",
        GITHUB_SHA: "abc",
        GITHUB_REPOSITORY: "o/r",
        GITHUB_WORKFLOW: "CI",
        GITHUB_RUN_ID: "9",
      },
    });
    expect(await main(["run", "--pipeline", "ci/ci.pipeline.json"], h.io)).toBe(0);
  });

  it("runs a pipeline that reads no context with none supplied", async () => {
    const h = harness();
    expect(await main(["run", "--pipeline", "ci/ci.pipeline.json"], h.io)).toBe(0);
  });

  it("names the missing context key at the point it is read, rather than guessing", async () => {
    const reading = {
      ...pipeline,
      jobs: {
        lint: {
          name: "Lint",
          runsOn: ["ubuntu-latest"],
          env: { BRANCH: "{{ refName }}" },
          steps: [{ kind: "run", run: "echo" }],
        },
      },
    };
    const h = harness({ files: { "ci/ci.pipeline.json": reading } });
    expect(await main(["run", "--pipeline", "ci/ci.pipeline.json"], h.io)).toBe(1);
    expect(h.err.join("")).toContain("refName");
    expect(h.commands).toEqual([]);
  });

  it("writes a step's environment file entries into later steps' environments", async () => {
    const oneJob = {
      ...pipeline,
      jobs: {
        build: {
          name: "Build",
          runsOn: ["ubuntu-latest"],
          steps: [
            { kind: "run", run: "pnpm run lint" },
            { kind: "run", run: "echo gate" },
          ],
        },
      },
    };
    const h = harness({
      files: { "ci/ci.pipeline.json": oneJob },
      script: (execution) =>
        execution.command === "pnpm run lint"
          ? { stdout: "", writes: { env: "FROM_STEP=set\n" } }
          : { stdout: "", writes: {} },
    });
    expect(await main(["run", "--pipeline", "ci/ci.pipeline.json", ...context], h.io)).toBe(0);
    const gate = h.executions.find((execution) => execution.command === "echo gate");
    expect(gate?.env.FROM_STEP).toBe("set");
  });

  it("echoes a step's stdout with masked values hidden and routed levels placed", async () => {
    const h = harness({
      script: (execution) =>
        execution.command === "pnpm run lint"
          ? {
              stdout:
                "::add-mask::s3cret\nthe token is s3cret\n::warning file=app.ts,line=2,endLine=4,title=Check::mind the gap\n",
              writes: { summary: "## Lint\n" },
            }
          : { stdout: "", writes: {} },
    });
    expect(await main(["run", "--pipeline", "ci/ci.pipeline.json", ...context], h.io)).toBe(0);
    const printed = h.out.join("");
    expect(printed).toContain("the token is ***");
    expect(printed).toContain("warning app.ts:2-4 (Check): mind the gap\n");
    expect(printed).toContain("## Lint\n");
  });
});

describe("resolveContext", () => {
  it("reads Bitbucket Pipelines and CircleCI variables", () => {
    expect(
      resolveContext(
        {
          BITBUCKET_BUILD_NUMBER: "1",
          BITBUCKET_BRANCH: "main",
          BITBUCKET_COMMIT: "abc",
          BITBUCKET_REPO_FULL_NAME: "o/r",
          BITBUCKET_PR_ID: "7",
        },
        {},
      ),
    ).toMatchObject({ refName: "main", sha: "abc", repository: "o/r", event: "pullRequest" });
    expect(
      resolveContext(
        {
          CIRCLECI: "true",
          CIRCLE_BRANCH: "main",
          CIRCLE_SHA1: "abc",
          CIRCLE_PROJECT_USERNAME: "o",
          CIRCLE_PROJECT_REPONAME: "r",
        },
        {},
      ),
    ).toMatchObject({ refName: "main", sha: "abc", repository: "o/r" });
    expect(
      resolveContext({ CIRCLECI: "true", CIRCLE_PIPELINE_ID: "p1", CIRCLE_WORKFLOW_ID: "w1" }, {})
        .runId,
    ).toBe("p1");
  });

  it("maps GitLab pipeline sources onto the neutral events", () => {
    const context = resolveContext(
      {
        GITLAB_CI: "true",
        CI_PIPELINE_SOURCE: "merge_request_event",
        CI_COMMIT_REF_NAME: "feature",
        CI_COMMIT_SHA: "abc",
        CI_PROJECT_PATH: "o/r",
        CI_PIPELINE_NAME: "CI",
        CI_PIPELINE_ID: "3",
      },
      {},
    );
    expect(context.event).toBe("pullRequest");
  });

  it("lets an explicit value override detection", () => {
    const context = resolveContext(
      {
        GITHUB_ACTIONS: "true",
        GITHUB_EVENT_NAME: "push",
        GITHUB_REF_NAME: "main",
        GITHUB_SHA: "abc",
        GITHUB_REPOSITORY: "o/r",
        GITHUB_WORKFLOW: "CI",
        GITHUB_RUN_ID: "1",
      },
      { event: "manual" },
    );
    expect(context.event).toBe("manual");
  });
});

describe("schema, check-names and platform", () => {
  it("prints the authoring schema", async () => {
    const h = harness();
    expect(await main(["schema", "--authoring"], h.io)).toBe(0);
    expect(JSON.parse(h.out.join(""))).toHaveProperty("$defs.parameterReference");
  });

  it("prints the derived gate check names without touching the network", async () => {
    const h = harness();
    expect(
      await main(
        [
          "check-names",
          "--pipeline",
          "ci/ci.pipeline.json",
          "--provider",
          "github-actions",
          "--scope",
          "gates",
        ],
        h.io,
      ),
    ).toBe(0);
    expect(h.out.join("")).toBe("Required checks\n");
  });

  it("reads one run through the platform adapter", async () => {
    const h = harness({ env: { GH_TOKEN: "test-credential" } });
    const io: Io = {
      ...h.io,
      fetch: async () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              id: 7,
              name: "CI",
              status: "in_progress",
              conclusion: null,
              head_branch: "main",
              head_sha: "abc",
              event: "push",
              html_url: "https://example.com/runs/7",
              created_at: "2026-01-01T00:00:00Z",
            }),
          ),
        ),
    };
    expect(await main(["platform", "run", "--repo", "o/r", "--run", "7"], io)).toBe(0);
    expect(h.out.join("")).toBe("7\trunning\tmain\tCI\n");
  });

  it("refuses a platform query when no token is set", async () => {
    const h = harness();
    expect(await main(["platform", "runs", "--repo", "o/r"], h.io)).toBe(1);
    expect(h.err.join("")).toContain("GH_TOKEN is not set");
  });

  it("prints usage and exits 2 for no command", async () => {
    const h = harness();
    expect(await main([], h.io)).toBe(2);
    expect(h.out.join("")).toContain("pipewright <command>");
  });
});

describe("import and convert", () => {
  const WORKFLOW =
    "name: CI\non:\n  push:\n    branches: [main]\njobs:\n  lint:\n    name: Lint\n    runs-on: ubuntu-latest\n    steps:\n      - run: pnpm run lint\n  test:\n    name: Test\n    runs-on: ubuntu-latest\n    needs: lint\n    steps:\n      - run: pnpm test\n";
  const NATIVE = { ".github/workflows/ci.yml": WORKFLOW };

  it("prints a TypeScript module that defines the pipeline", async () => {
    const h = harness({ files: NATIVE });
    expect(
      await main(
        ["import", "--provider", "github-actions", "--file", ".github/workflows/ci.yml"],
        h.io,
      ),
    ).toBe(0);
    const text = h.out.join("");

    expect(text).toContain('import { definePipeline } from "@pipewright/pipeline-contract";');
    expect(text).toContain("export default definePipeline({");
    expect(text).toContain('"needs": [\n        "lint"\n      ]');
  });

  it("writes a JSON document that loads back as the same pipeline", async () => {
    const h = harness({ files: NATIVE });
    expect(
      await main(
        [
          "import",
          "--provider",
          "github-actions",
          "--file",
          ".github/workflows/ci.yml",
          "--format",
          "json",
          "--output",
          "ci/ci.pipeline.json",
        ],
        h.io,
      ),
    ).toBe(0);
    const document = h.files.get("ci/ci.pipeline.json");
    expect(document).toContain(`"$schema": "${SCHEMA}"`);

    const again = harness({ files: { "ci/ci.pipeline.json": document ?? "" } });
    expect(await main(["emit", ...EMIT], again.io)).toBe(0);
    expect(again.files.get(".github/workflows/ci.yml")).toContain("name: CI");
  });

  it("converts a native file to another provider's files", async () => {
    const h = harness({ files: NATIVE });
    expect(
      await main(
        [
          "convert",
          "--from",
          "github-actions",
          "--file",
          ".github/workflows/ci.yml",
          "--to",
          "gitlab-ci",
        ],
        h.io,
      ),
    ).toBe(0);

    expect(h.files.get(".gitlab-ci.yml")).toContain("script:");
    expect(h.out.join("")).toContain("wrote .gitlab-ci.yml");
  });

  it("locates a construct the model cannot express by file and pointer", async () => {
    const h = harness({
      files: {
        "ci.yml":
          "on:\n  release:\n    types: [created]\njobs:\n  a:\n    runs-on: x\n    steps:\n      - run: a\n",
      },
    });
    expect(await main(["import", "--provider", "github-actions", "--file", "ci.yml"], h.io)).toBe(
      1,
    );

    expect(h.err.join("")).toContain("ci.yml#/on/release: github-actions");
  });

  it("refuses to convert a pipeline that carries settings the target would drop", async () => {
    const h = harness({
      files: {
        "ci.yml":
          "on: push\njobs:\n  a:\n    runs-on: x\n    continue-on-error: true\n    steps:\n      - run: a\n",
      },
    });
    expect(
      await main(
        ["convert", "--from", "github-actions", "--file", "ci.yml", "--to", "gitlab-ci"],
        h.io,
      ),
    ).toBe(1);

    expect(h.err.join("")).toContain(
      'carries github-actions settings that gitlab-ci would drop, so it is not converted: job "a": continue-on-error',
    );
    expect(h.files.has(".gitlab-ci.yml")).toBe(false);
  });

  it("names the providers it can read when one is unknown", async () => {
    const h = harness({ files: NATIVE });
    expect(
      await main(["import", "--provider", "travis", "--file", ".github/workflows/ci.yml"], h.io),
    ).toBe(1);

    expect(h.err.join("")).toContain("--provider expects one of");
  });
});
