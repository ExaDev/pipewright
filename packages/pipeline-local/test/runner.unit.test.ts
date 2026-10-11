import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  describeRunnerConformance,
  pipelineSchema,
  type CommandExecution,
  type CommandExecutor,
  type RunOutput,
  type StepCommandFiles,
  type StepFileContents,
  type StepScratch,
} from "@pipewright/pipeline-contract";

import { createLocalRunner } from "../src/index.ts";
import {
  applyMasks,
  parseKeyValueFile,
  parsePathFile,
  parseStdoutLine,
  preferredPaths,
} from "../src/file-commands.ts";

describeRunnerConformance({ describe, it }, createLocalRunner);

describe("parseKeyValueFile", () => {
  it("reads key=value lines, splitting at the first equals", () => {
    expect(parseKeyValueFile("GITHUB_ENV", "A=1\nB=x=y\n")).toEqual([
      { key: "A", value: "1" },
      { key: "B", value: "x=y" },
    ]);
  });

  it("reads a multi-line value between its delimiter lines", () => {
    expect(
      parseKeyValueFile("GITHUB_OUTPUT", "k<<ghadelimiter_1\none\ntwo\nghadelimiter_1\n"),
    ).toEqual([{ key: "k", value: "one\ntwo" }]);
  });

  it("keeps a value that contains << when the equals comes first", () => {
    expect(parseKeyValueFile("GITHUB_OUTPUT", "k=a<<b\n")).toEqual([{ key: "k", value: "a<<b" }]);
  });

  it("rejects a malformed line, an empty key, and an unterminated heredoc, each naming the file and line", () => {
    expect(() => parseKeyValueFile("GITHUB_ENV", "A=1\nnot an entry\n")).toThrow(
      "GITHUB_ENV line 2",
    );
    expect(() => parseKeyValueFile("GITHUB_ENV", "=1\n")).toThrow("GITHUB_ENV line 1");
    expect(() => parseKeyValueFile("GITHUB_OUTPUT", "k<<eof\nvalue\n")).toThrow(
      "GITHUB_OUTPUT line 1",
    );
  });
});

describe("parsePathFile and preferredPaths", () => {
  it("reads one directory per non-blank line", () => {
    expect(parsePathFile("/one\n\n/two\n")).toEqual(["/one", "/two"]);
  });

  it("orders what a step wrote most preferred first, moving a repeated entry rather than duplicating it", () => {
    expect(preferredPaths(["/one", "/two"], ["/old"])).toEqual(["/two", "/one", "/old"]);
    expect(preferredPaths(["/one"], ["/one", "/old"])).toEqual(["/one", "/old"]);
  });
});

describe("parseStdoutLine", () => {
  it("reads each level command with its annotation and unescapes the toolkit's codes", () => {
    const parsed = parseStdoutLine("::error file=a%2Cb.ts,line=3::missing%20nothing");
    expect(parsed).toEqual({
      kind: "command",
      command: {
        kind: "level",
        level: "error",
        message: "missing%20nothing",
        annotation: { file: "a,b.ts", line: 3 },
      },
    });
  });

  it("reads an add-mask command and rejects one with no value", () => {
    expect(parseStdoutLine("::add-mask::hunter2")).toEqual({
      kind: "command",
      command: { kind: "mask", value: "hunter2" },
    });
    expect(() => parseStdoutLine("::add-mask::")).toThrow("add-mask");
  });

  it("treats text that does not parse as a command as output, and rejects an unknown command name", () => {
    expect(parseStdoutLine("a line ::error:: of text")).toEqual({
      kind: "text",
      text: "a line ::error:: of text",
    });
    expect(parseStdoutLine("::no closing marker")).toEqual({
      kind: "text",
      text: "::no closing marker",
    });
    expect(() => parseStdoutLine("::group::name")).toThrow("::group::");
  });

  it("rejects a property outside the documented set and a line number that is not one", () => {
    expect(() => parseStdoutLine("::warning column=3::m")).toThrow("column");
    expect(() => parseStdoutLine("::warning line=three::m")).toThrow("line");
  });

  it("unescapes the codes the toolkit writes, in one pass so a literal code survives", () => {
    expect(parseStdoutLine("::debug::a%0Ab%25")).toEqual({
      kind: "command",
      command: { kind: "level", level: "debug", message: "a\nb%", annotation: undefined },
    });
    expect(parseStdoutLine("::debug::%250A")).toEqual({
      kind: "command",
      command: { kind: "level", level: "debug", message: "%0A", annotation: undefined },
    });
  });
});

describe("applyMasks", () => {
  it("hides every occurrence, longer masks first", () => {
    expect(applyMasks("a token and token2", ["token", "token2"])).toBe("a *** and ***");
    expect(applyMasks("abc and abcd", ["abc", "abcd"])).toBe("*** and ***");
  });
});

/** A scratch in memory, pre-seeding each step's files empty and reading back exactly what was written. */
function memoryScratch(): StepScratch & { readonly written: Map<string, string> } {
  const written = new Map<string, string>();
  let stepCount = 0;

  return {
    written,
    async create(): Promise<StepCommandFiles> {
      const files = {
        output: `s${String(stepCount)}/output`,
        env: `s${String(stepCount)}/env`,
        path: `s${String(stepCount)}/path`,
        summary: `s${String(stepCount)}/summary`,
      };
      stepCount += 1;
      for (const path of [files.output, files.env, files.path, files.summary]) {
        written.set(path, "");
      }

      return Promise.resolve(files);
    },
    async read(files): Promise<StepFileContents> {
      const content = (path: string): string => {
        const value = written.get(path);
        if (value === undefined) throw new Error(`no scratch file at ${path}`);

        return value;
      };

      return Promise.resolve({
        output: content(files.output),
        env: content(files.env),
        path: content(files.path),
        summary: content(files.summary),
      });
    },
    async release(files): Promise<void> {
      for (const path of [files.output, files.env, files.path, files.summary]) {
        written.delete(path);
      }

      return Promise.resolve();
    },
    async dispose(): Promise<void> {
      written.clear();

      return Promise.resolve();
    },
  };
}

/** Writes one of the command files the runner passed a command, as the command itself would have. */
function write(
  execution: CommandExecution,
  file: "GITHUB_OUTPUT" | "GITHUB_ENV" | "GITHUB_PATH" | "GITHUB_STEP_SUMMARY",
  scratch: ReturnType<typeof memoryScratch>,
  content: string,
): void {
  const path = execution.env[file];
  if (path === undefined) throw new Error(`the runner did not pass ${file}`);
  scratch.written.set(path, content);
}

/** The entries and summaries a run produced, as text, so assertions read like the output a host would print. */
interface RunOutputRecorder extends RunOutput {
  readonly lines: string[];
}

function recordedOutput(): RunOutputRecorder {
  const lines: string[] = [];

  return {
    lines,
    log(entry) {
      lines.push(`${entry.level}:${entry.message}`);
    },
    summary(summary) {
      lines.push(`summary:${summary.text}`);
    },
  };
}

describe("the local runner's file commands", () => {
  it("applies what a step wrote and echoes its stdout masked, through fakes", async () => {
    const scratch = memoryScratch();
    const executed: CommandExecution[] = [];
    const executor: CommandExecutor = {
      async execute(execution) {
        executed.push(execution);
        if (execution.command === "first") {
          write(execution, "GITHUB_ENV", scratch, "STEP_ENV=written\n");
          write(execution, "GITHUB_OUTPUT", scratch, "out=here\n");

          return Promise.resolve({ exitCode: 0, stdout: "::add-mask::shh\nshh out there\n" });
        }

        return Promise.resolve({ exitCode: 0, stdout: "" });
      },
    };
    const pipeline = pipelineSchema.parse({
      name: "CI",
      triggers: [{ kind: "push" }],
      jobs: {
        build: {
          name: "Build",
          runsOn: ["x"],
          env: { STEP_ENV: "declared" },
          steps: [
            { kind: "run", run: "first" },
            { kind: "run", run: "second" },
          ],
        },
      },
    });
    const output = recordedOutput();
    const report = await createLocalRunner().run(pipeline, {
      executor,
      scratch,
      output,
      context: {},
    });
    expect(report.jobs[0]?.steps[0]?.outputs).toEqual({ out: "here" });
    expect(output.lines).toEqual(["info:*** out there"]);
    // The env the pipeline declares for the step wins over what an earlier step wrote, as the provider's runner applies the file below the declared env.
    expect(executed[1]?.env.STEP_ENV).toBe("declared");
  });

  it("applies the file commands a real shell step writes", async () => {
    const root = await mkdtemp(join(tmpdir(), "pipewright-local-"));
    try {
      let stepCount = 0;
      const scratch: StepScratch = {
        async create() {
          const directory = join(root, String(stepCount));
          stepCount += 1;
          await mkdir(directory, { recursive: true });
          const files = {
            output: join(directory, "output"),
            env: join(directory, "env"),
            path: join(directory, "path"),
            summary: join(directory, "summary"),
          };
          await Promise.all([
            writeFile(files.output, ""),
            writeFile(files.env, ""),
            writeFile(files.path, ""),
            writeFile(files.summary, ""),
          ]);

          return files;
        },
        async read(files) {
          const [output, env, path, summary] = await Promise.all([
            readFile(files.output, "utf8"),
            readFile(files.env, "utf8"),
            readFile(files.path, "utf8"),
            readFile(files.summary, "utf8"),
          ]);

          return { output, env, path, summary };
        },
        async release(files) {
          await rm(dirname(files.output), { recursive: true, force: true });
        },
        async dispose() {
          await rm(root, { recursive: true, force: true });
        },
      };
      // The real executor's shape from the CLI: spawn `sh -e -c`, pipe stdout, and search the job's path entries before the host's own PATH.
      const executor: CommandExecutor = {
        async execute(execution) {
          return new Promise((done, fail) => {
            const child = spawn("sh", ["-e", "-c", execution.command], {
              stdio: ["inherit", "pipe", "inherit"],
              env: {
                ...process.env,
                ...execution.env,
                PATH: [...execution.pathEntries, process.env.PATH]
                  .filter((entry): entry is string => entry !== undefined)
                  .join(":"),
              },
            });
            child.stdout.setEncoding("utf8");
            let stdout = "";
            child.stdout.on("data", (chunk: string) => {
              stdout += chunk;
            });
            child.on("error", fail);
            child.on("close", (code) => {
              done({ exitCode: code ?? 1, stdout });
            });
          });
        },
      };
      const output = recordedOutput();
      const pipeline = pipelineSchema.parse({
        name: "CI",
        triggers: [{ kind: "push" }],
        jobs: {
          build: {
            name: "Build",
            runsOn: ["x"],
            steps: [
              {
                kind: "run",
                run: [
                  'echo "A=from-file" >> "$GITHUB_ENV"',
                  "printf 'multi<<EOT\\nline one\\nline two\\nEOT\\n' >> \"$GITHUB_OUTPUT\"",
                  'echo "::add-mask::hunter2"',
                  'echo "token=hunter2"',
                  'echo "## Summary" >> "$GITHUB_STEP_SUMMARY"',
                ].join("\n"),
              },
              { kind: "run", run: 'test "$A" = "from-file" && echo "env applied"' },
            ],
          },
        },
      });
      const report = await createLocalRunner().run(pipeline, {
        executor,
        scratch,
        output,
        context: {},
      });
      expect(report.ok).toBe(true);
      expect(report.jobs[0]?.steps[0]?.outputs).toEqual({ multi: "line one\nline two" });
      expect(output.lines).toContain("info:token=***");
      expect(output.lines).toContain("info:env applied");
      expect(output.lines).toContain("summary:## Summary\n");
      // Each step's directory is removed once read and the root at the run's end, so a later step's process cannot read what an earlier one wrote.
      expect(existsSync(root)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("cleans the scratch when a run throws", async () => {
    const scratch = memoryScratch();
    const executor: CommandExecutor = {
      async execute() {
        return Promise.resolve({ exitCode: 0, stdout: "::no-such-command::x\n" });
      },
    };
    const pipeline = pipelineSchema.parse({
      name: "CI",
      triggers: [{ kind: "push" }],
      jobs: {
        build: {
          name: "Build",
          runsOn: ["x"],
          steps: [{ kind: "run", run: "echo" }],
        },
      },
    });

    // An unknown workflow command throws between the step's execution and its files being read, and the run still releases the step's files and disposes the scratch.
    await expect(
      createLocalRunner().run(pipeline, {
        executor,
        scratch,
        output: recordedOutput(),
        context: {},
      }),
    ).rejects.toThrow("unknown workflow command");
    expect(scratch.written.size).toBe(0);
  });
});
