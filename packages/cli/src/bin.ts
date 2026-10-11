#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter as pathDelimiter, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { StepScratch } from "@pipewright/pipeline-contract";

import { main, type Io } from "./main.ts";

const cwd = process.cwd();

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(resolve(cwd, path), "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * The run's scratch area: one directory per run under the operating system's temporary directory, one empty file per command per step, left in place for the process's life as a hosted runner leaves its `_temp`. Reading a file that is gone is an error, not an empty read, so a step that deletes its own command file is heard.
 */
async function stepScratch(): Promise<StepScratch> {
  const root = await mkdtemp(join(tmpdir(), "pipewright-"));
  let stepCount = 0;

  return {
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
  };
}

const io: Io = {
  cwd,
  env: process.env,
  stdout(text) {
    process.stdout.write(text);
  },
  stderr(text) {
    process.stderr.write(text);
  },
  reader: { read: async (path) => readFile(resolve(cwd, path), "utf8") },
  readOptional,
  async writeFile(path, content) {
    const target = resolve(cwd, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  },
  scratch: await stepScratch(),
  executor: {
    async execute(execution, signal) {
      return new Promise((done, fail) => {
        // A run step stops at its first failing command, as it does under GitHub's `bash -e`, so a multi-line step cannot pass with an early command failed.
        const child = spawn("sh", ["-e", "-c", execution.command], {
          // stdout is piped, not inherited, because the runner reads it for workflow commands and echoes it after masking; stderr has no commands in it and stays on the terminal as it happens.
          stdio: ["inherit", "pipe", "inherit"],
          cwd:
            execution.workingDirectory === undefined
              ? cwd
              : resolve(cwd, execution.workingDirectory),
          env: {
            ...process.env,
            ...execution.env,
            // The job's accumulated path entries are searched before the host's own PATH.
            PATH: [...execution.pathEntries, process.env.PATH]
              .filter((entry): entry is string => entry !== undefined)
              .join(pathDelimiter),
          },
          ...(signal === undefined ? {} : { signal }),
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
  },
  async importModule(path): Promise<unknown> {
    const loaded: unknown = await import(pathToFileURL(resolve(cwd, path)).href);

    return loaded;
  },
  fetch,
};

process.exitCode = await main(process.argv.slice(2), io);
