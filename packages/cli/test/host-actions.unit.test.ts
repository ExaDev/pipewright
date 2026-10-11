import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

import { CONTEXT_EXPRESSION } from "@pipewright/pipeline-github-actions";
import type {
  CommandExecution,
  CommandExecutor,
  CommandResult,
  StepCommandFiles,
  StepFileContents,
  StepScratch,
} from "@pipewright/pipeline-contract";
import { afterAll, describe, expect, it } from "vitest";

import { GITHUB_FIELD } from "../src/actions.ts";
import { main, type Io } from "../src/index.ts";

/** The schema reference a JSON pipeline document must declare. */
const SCHEMA = "https://unpkg.com/@pipewright/pipeline-contract/dist/pipeline.schema.json";

/** Where the demonstration fixtures live, beside this test file. */
const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures/host-actions");

/** The workspaces and scratch roots this test created, removed once every case has run. */
const created: string[] = [];

afterAll(async () => {
  await Promise.all(created.map(async (path) => rm(path, { recursive: true, force: true })));
});

/** A fresh directory under the system temporary directory, tracked for removal when the test ends. */
async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "pipewright-host-"));
  created.push(path);

  return path;
}

/** The executor the real CLI uses: each command through `sh -e -c`, both streams read back. */
function executor(cwd: string): CommandExecutor {
  return {
    async execute(execution: CommandExecution, signal?: AbortSignal): Promise<CommandResult> {
      return new Promise((done, fail) => {
        const child = spawn("sh", ["-e", "-c", execution.command], {
          stdio: ["inherit", "pipe", "pipe"],
          cwd:
            execution.workingDirectory === undefined
              ? cwd
              : resolve(cwd, execution.workingDirectory),
          env: {
            ...process.env,
            ...execution.env,
            PATH: [execution.pathEntries.join(":"), process.env.PATH]
              .filter((entry): entry is string => entry !== undefined)
              .join(":"),
          },
          ...(signal === undefined ? {} : { signal }),
        });
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk: string) => {
          stdout += chunk;
        });
        child.stderr.on("data", (chunk: string) => {
          stderr += chunk;
        });
        child.on("error", fail);
        child.on("close", (code) => {
          done({ exitCode: code ?? 1, stdout, stderr });
        });
      });
    },
  };
}

/** The scratch the real CLI uses: one directory per run, one empty file per command, removed once read. */
async function scratch(): Promise<StepScratch> {
  const root = await directory();
  let stepCount = 0;

  return {
    async create(): Promise<StepCommandFiles> {
      const step = join(root, String(stepCount));
      stepCount += 1;
      await mkdir(step, { recursive: true });
      const files = {
        output: join(step, "output"),
        env: join(step, "env"),
        path: join(step, "path"),
        summary: join(step, "summary"),
      };
      await Promise.all([
        writeFile(files.output, ""),
        writeFile(files.env, ""),
        writeFile(files.path, ""),
        writeFile(files.summary, ""),
      ]);

      return files;
    },
    async read(files): Promise<StepFileContents> {
      return {
        output: await readFile(files.output, "utf8"),
        env: await readFile(files.env, "utf8"),
        path: await readFile(files.path, "utf8"),
        summary: await readFile(files.summary, "utf8"),
      };
    },
    async release(files) {
      await rm(dirname(files.output), { recursive: true, force: true });
    },
    async dispose() {
      await rm(root, { recursive: true, force: true });
    },
  };
}

interface Harness {
  readonly io: Io;
  readonly out: () => string;
  readonly err: () => string;
  readonly workspace: string;
}

/** A run of the real CLI over a real workspace: the fixture tree copied to a fresh directory, a real executor and scratch, output collected. */
async function harness(fetch: typeof globalThis.fetch = globalThis.fetch): Promise<Harness> {
  const workspace = await directory();
  await cp(FIXTURES, workspace, { recursive: true });
  const out: string[] = [];
  const err: string[] = [];

  return {
    workspace,
    out: () => out.join(""),
    err: () => err.join(""),
    io: {
      cwd: workspace,
      env: {},
      stdout(text) {
        out.push(text);
      },
      stderr(text) {
        err.push(text);
      },
      reader: { read: async (path) => readFile(resolve(workspace, path), "utf8") },
      readOptional: async (path) => {
        try {
          return await readFile(resolve(workspace, path), "utf8");
        } catch (error) {
          if (error instanceof Error && "code" in error && error.code === "ENOENT") {
            return undefined;
          }
          throw error;
        }
      },
      async writeFile(path, content) {
        const target = resolve(workspace, path);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, content);
      },
      scratch: await scratch(),
      executor: executor(workspace),
      importModule: async () => Promise.reject(new Error("this test loads no TypeScript module")),
      fetch,
    },
  };
}

/** A pipeline document authored directly, written into the workspace as JSON. */
async function authored(harness_: Harness, document: unknown, name: string): Promise<string> {
  const path = join(harness_.workspace, name);
  await writeFile(path, `${JSON.stringify(document, null, 2)}\n`);

  return name;
}

describe("run through the real CLI", () => {
  it("imports a workflow and runs its actions end to end on the host", async () => {
    const run = await harness();
    const imported = await main(
      [
        "import",
        "--provider",
        "github-actions",
        "--file",
        "workflow.yml",
        "--output",
        "ci.pipeline.json",
        "--format",
        "json",
      ],
      run.io,
    );
    expect(imported).toBe(0);
    const code = await main(
      [
        "run",
        "--pipeline",
        "ci.pipeline.json",
        "--local",
        "--secret",
        "API_TOKEN=demo-secret-value",
      ],
      run.io,
    );
    expect(code).toBe(0);
    expect(run.out()).toContain("success: build");
    // The composite action's steps ran with the input mapped from the workflow's own step output and the run's context.
    await expect(readFile(join(run.workspace, "composite.txt"), "utf8")).resolves.toBe(
      "input=from-yes\nref=local\n",
    );
    // The node action's entry ran under the host's node with its input in the environment.
    await expect(readFile(join(run.workspace, "node.txt"), "utf8")).resolves.toBe("wrote-local\n");
    // The value one step wrote through GITHUB_OUTPUT reached a later step's expression, and the secret it read never appeared.
    await expect(readFile(join(run.workspace, "hand-off.txt"), "utf8")).resolves.toBe(
      "hand-off=yes token=true\n",
    );
    await expect(readFile(join(run.workspace, "never.txt"), "utf8")).rejects.toThrow();
    expect(run.out()).not.toContain("demo-secret-value");
  });

  it("fails the run naming a secret it was not given", async () => {
    const run = await harness();
    await main(
      [
        "import",
        "--provider",
        "github-actions",
        "--file",
        "workflow.yml",
        "--output",
        "ci.pipeline.json",
        "--format",
        "json",
      ],
      run.io,
    );
    const code = await main(["run", "--pipeline", "ci.pipeline.json", "--local"], run.io);
    expect(code).toBe(1);
    expect(run.err()).toContain("API_TOKEN");
    expect(run.err()).not.toContain("demo-secret-value");
  });

  it("leaves a container reference to the provider, skipped only when asked", async () => {
    const run = await harness();
    const pipeline = await authored(
      run,
      {
        $schema: SCHEMA,
        name: "Container",
        triggers: [{ kind: "push" }],
        jobs: {
          build: {
            name: "Build",
            runsOn: ["ubuntu-latest"],
            steps: [
              { kind: "run", run: "echo ran >> ran.txt" },
              {
                kind: "provider",
                provider: "github-actions",
                native: { uses: "docker://alpine:3.20" },
              },
            ],
          },
        },
      },
      "container.pipeline.json",
    );
    const rejected = await main(["run", "--pipeline", pipeline, "--local"], run.io);
    expect(rejected).toBe(1);
    expect(run.err()).toContain("docker://alpine:3.20");
    expect(run.err()).toContain("container runtime");
    // The step before the container reference ran before the run rejected on it.
    await expect(readFile(join(run.workspace, "ran.txt"), "utf8")).resolves.toBe("ran\n");
    const skipped = await main(
      ["run", "--pipeline", pipeline, "--local", "--skip-provider-steps"],
      run.io,
    );
    expect(skipped).toBe(0);
    await expect(readFile(join(run.workspace, "ran.txt"), "utf8")).resolves.toBe("ran\nran\n");
  });

  it("rejects a workflow step whose shell the host would not run as written", async () => {
    const run = await harness();
    const pipeline = await authored(
      run,
      {
        $schema: SCHEMA,
        name: "Shell",
        triggers: [{ kind: "push" }],
        jobs: {
          build: {
            name: "Build",
            runsOn: ["ubuntu-latest"],
            steps: [
              {
                kind: "provider",
                provider: "github-actions",
                native: { run: "Write-Output done", shell: "pwsh" },
              },
            ],
          },
        },
      },
      "shell.pipeline.json",
    );
    const code = await main(["run", "--pipeline", pipeline, "--local"], run.io);
    expect(code).toBe(1);
    expect(run.err()).toContain("pwsh");
  });
});

/** The tar header's field offsets, in bytes, as the format fixes them; the reader this feed exercises reads the same fields. */
const HEADER = 512;
const NAME_LIMIT = 100;
const MODE_AT = 100;
const OWNER_AT = 108;
const GROUP_AT = 116;
const SIZE_AT = 124;
const SIZE_DIGITS = 11;
const TIME_AT = 136;
const CHECK_AT = 148;
const CHECK_DIGITS = 6;
const TYPE_AT = 156;
const MAGIC_AT = 257;
const VERSION_AT = 264;
/** The octal radix the format's numeric fields are written in. */
const OCTAL = 8;

/** One tar entry: a header block of the given type flag, an optional name, and the data, padded to a full block. */
function tarEntry(typeflag: string, data: string, name = ""): number[] {
  const header = Buffer.alloc(HEADER);
  header.write(name, 0, "ascii");
  header.write("0000644", MODE_AT, "ascii");
  header.write("0000000", OWNER_AT, "ascii");
  header.write("0000000", GROUP_AT, "ascii");
  header.write(data.length.toString(OCTAL).padStart(SIZE_DIGITS, "0"), SIZE_AT, "ascii");
  header.write("00000000000", TIME_AT, "ascii");
  header.fill(" ", CHECK_AT, CHECK_AT + CHECK_DIGITS + 2);
  header.write(typeflag, TYPE_AT, "ascii");
  header.write("ustar", MAGIC_AT, "ascii");
  header.write("00", VERSION_AT, "ascii");
  const sum = header.reduce((total, byte) => total + byte, 0);
  header.write(`${sum.toString(OCTAL).padStart(CHECK_DIGITS, "0")}\0 `, CHECK_AT, "ascii");
  const bytes = [...Buffer.from(data, "utf8")];
  const padding = (HEADER - (bytes.length % HEADER)) % HEADER;

  return [...header, ...bytes, ...new Array<number>(padding).fill(0)];
}

/** One pax header entry: `x` for the entry that follows it, `g` for the whole archive, over the records given. */
function paxEntry(typeflag: "x" | "g", records: Readonly<Record<string, string>>): number[] {
  const data = Object.entries(records)
    .map(([key, value]) => {
      const record = `${key}=${value}\n`;
      // A record's length prefix counts the digits and the space it is written with, so the length is found by widening until it is stable.
      let digits = 1;
      for (;;) {
        const length = String(record.length + digits + 1).length;
        if (length === digits) break;
        digits = length;
      }

      return `${String(record.length + digits + 1)} ${record}`;
    })
    .join("");

  return tarEntry(typeflag, data, typeflag === "g" ? "pax_global_header" : "");
}

/** A repository tarball over the files given, in the shape GitHub serves one: a pax global header first, a path too long for the header's own field carried in an extended header, gzip over the whole. */
function tarballOf(files: Readonly<Record<string, string>>): Uint8Array {
  const entries = [
    paxEntry("g", { comment: "1234567890abcdef1234567890abcdef12345678" }),
    ...Object.entries(files).flatMap(([name, content]) => [
      ...(name.length > NAME_LIMIT ? [paxEntry("x", { path: name })] : []),
      tarEntry("0", content, name.length > NAME_LIMIT ? "" : name),
    ]),
  ].flat();

  return gzipSync(new Uint8Array(entries));
}

describe("a fetched action", () => {
  /** How many directory segments the long-path fixture nests, past the header's hundred-byte name field. */
  const PATH_DEPTH = 25;
  /** A path past the tar header's name field, carried in a pax extended header as a real tarball does. */
  const LONG_PATH = `phased-v1/${"docs/".repeat(PATH_DEPTH)}notes.md`;

  /** A node action whose phases write one file each, so the order the run placed them in is the file's order. */
  const ACTION: Readonly<Record<string, string>> = {
    "phased-v1/action.yml": `name: Phased
description: Runs around the job's own steps
inputs:
  text:
    description: The text to carry
    required: true
runs:
  using: node20
  main: index.js
  pre: pre.js
  post: post.js
`,
    "phased-v1/index.js": `const fs = require("node:fs");
const path = require("node:path");
const text = process.env.INPUT_TEXT;
if (text === undefined) throw new Error("INPUT_TEXT was not supplied");
fs.appendFileSync("phases.txt", \`main=\${text}\\n\`);
const deep = Array(25).fill("docs").join("/") + "/notes.md";
const carried = fs.readFileSync(path.join(process.env.GITHUB_ACTION_PATH, deep), "utf8");
fs.appendFileSync("phases.txt", \`long=\${carried.trim()}\\n\`);
`,
    "phased-v1/pre.js": `const fs = require("node:fs");
fs.appendFileSync("phases.txt", "pre\\n");
`,
    "phased-v1/post.js": `const fs = require("node:fs");
fs.appendFileSync("phases.txt", "post\\n");
`,
    [LONG_PATH]: "a long path\n",
  };
  // A path past the header's name field, so the tarball carries it in a pax extended header as a real one does.

  it("is fetched once, extracted, and its phases placed around the job's steps", async () => {
    const tarball = tarballOf(ACTION);
    const fetched: string[] = [];
    const serving: typeof globalThis.fetch = async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      fetched.push(url);

      return Promise.resolve(
        new Response(tarball, {
          status: 200,
          headers: { "content-type": "application/x-gzip" },
        }),
      );
    };
    const run = await harness(serving);
    const pipeline = await authored(
      run,
      {
        $schema: SCHEMA,
        name: "Phased",
        triggers: [{ kind: "push" }],
        jobs: {
          build: {
            name: "Build",
            runsOn: ["ubuntu-latest"],
            steps: [
              { kind: "run", run: `echo "before" >> phases.txt` },
              {
                kind: "provider",
                provider: "github-actions",
                native: { uses: "owner/repo@v1", with: { text: "carried" } },
              },
              { kind: "run", run: `echo "after" >> phases.txt` },
            ],
          },
        },
      },
      "phased.pipeline.json",
    );
    const code = await main(["run", "--pipeline", pipeline, "--local"], run.io);
    if (code !== 0) throw new Error(run.err());
    expect(code).toBe(0);
    expect(fetched).toEqual(["https://api.github.com/repos/owner/repo/tarball/v1"]);
    // The entry read the long-path file out of its own tree, so the pax header that carried the path was extracted with it.
    await expect(readFile(join(run.workspace, "phases.txt"), "utf8")).resolves.toBe(
      "pre\nbefore\nmain=carried\nlong=a long path\nafter\npost\n",
    );
  });

  it("skips the action entirely when the run was told to skip provider steps", async () => {
    const fetched: string[] = [];
    const serving: typeof globalThis.fetch = async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      fetched.push(url);

      return Promise.reject(new Error("a skipped run fetches nothing"));
    };
    const run = await harness(serving);
    const pipeline = await authored(
      run,
      {
        $schema: SCHEMA,
        name: "Skipped",
        triggers: [{ kind: "push" }],
        jobs: {
          build: {
            name: "Build",
            runsOn: ["ubuntu-latest"],
            steps: [
              { kind: "run", run: "echo before >> skipped.txt" },
              {
                kind: "provider",
                provider: "github-actions",
                native: { uses: "owner/repo@v1", with: { text: "carried" } },
              },
            ],
          },
        },
      },
      "skipped.pipeline.json",
    );
    const code = await main(
      ["run", "--pipeline", pipeline, "--local", "--skip-provider-steps"],
      run.io,
    );
    expect(code).toBe(0);
    expect(fetched).toEqual([]);
    await expect(readFile(join(run.workspace, "skipped.txt"), "utf8")).resolves.toBe("before\n");
    await expect(readFile(join(run.workspace, "phases.txt"), "utf8")).rejects.toThrow();
  });
});

describe("the host's context table", () => {
  it("maps each neutral key onto the field the adapter's own expression table names", () => {
    for (const [key, expression] of Object.entries(CONTEXT_EXPRESSION)) {
      expect(GITHUB_FIELD[key as keyof typeof GITHUB_FIELD]).toBe(
        expression.slice("github.".length),
      );
    }
  });
});
