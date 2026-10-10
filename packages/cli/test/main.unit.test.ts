import { describe, expect, it } from "vitest";

import { main, resolveContext, type Io } from "../src/index.ts";

const SCHEMA = "../schemas/pipeline.schema.json";

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
}

interface HarnessOptions {
  readonly files?: Record<string, unknown>;
  readonly modules?: Record<string, unknown>;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly failing?: (command: string) => boolean;
}

function harness(options: HarnessOptions = {}): Harness {
  const {
    files = { "ci/ci.pipeline.json": pipeline },
    env = {},
    failing = () => false,
    modules = {},
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
    executor: {
      async execute(execution) {
        commands.push(execution.command);

        return Promise.resolve({ exitCode: failing(execution.command) ? 1 : 0 });
      },
    },
    async importModule(path) {
      const exports = modules[path];
      if (exports === undefined) throw new Error(`no such module ${path}`);

      return Promise.resolve(exports);
    },
    fetch: async () => Promise.reject(new Error("network is not available in this test")),
  };

  return { io, out, err, files: store, commands };
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
      "# Generated from ci/ci.pipeline.ts by ci-adapters.",
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

  it("names the missing context key rather than guessing", async () => {
    const h = harness();
    expect(await main(["run", "--pipeline", "ci/ci.pipeline.json"], h.io)).toBe(1);
    expect(h.err.join("")).toContain("no value for context");
    expect(h.err.join("")).toContain("refName");
  });
});

describe("resolveContext", () => {
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
    expect(h.out.join("")).toContain("ci-adapters <command>");
  });
});
