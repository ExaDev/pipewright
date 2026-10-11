#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

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
  executor: {
    async execute(execution, signal) {
      return new Promise((done, fail) => {
        // A run step stops at its first failing command, as it does under GitHub's `bash -e`, so a multi-line step cannot pass with an early command failed.
        const child = spawn("sh", ["-e", "-c", execution.command], {
          stdio: "inherit",
          cwd:
            execution.workingDirectory === undefined
              ? cwd
              : resolve(cwd, execution.workingDirectory),
          env: { ...process.env, ...execution.env },
          ...(signal === undefined ? {} : { signal }),
        });
        child.on("error", fail);
        child.on("close", (code) => {
          done({ exitCode: code ?? 1 });
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
