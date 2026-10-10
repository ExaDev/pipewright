import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { samplePipeline } from "@pipewright/pipeline-contract";
import { createGitLabCiCompiler } from "@pipewright/pipeline-gitlab-ci";

/** The GitLab release whose own linter judges the output. Pinned, because the linter's behaviour is the thing under test. */
const IMAGE = "gitlab/gitlab-ce:19.4.1-ce.0";
const CONTAINER = `pipewright-gitlab-lint-${String(process.pid)}`;
/** Generous for a container log, far below anything a lint result needs. */
const MAX_OUTPUT_BYTES = 16_777_216;
const HEALTH_POLL_MS = 15_000;
const HEALTH_POLLS = 120;

async function docker(args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("docker", [...args], { maxBuffer: MAX_OUTPUT_BYTES }, (error, stdout, stderr) => {
      if (error === null) resolve(stdout);
      else
        reject(new Error(`docker ${args.join(" ")} failed: ${error.message}\n${stdout}${stderr}`));
    });
  });
}

async function sleep(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

async function waitUntilHealthy(remaining: number): Promise<void> {
  if (remaining === 0) throw new Error("GitLab did not become healthy in time");
  const status = (await docker(["inspect", "-f", "{{.State.Health.Status}}", CONTAINER])).trim();
  if (status === "healthy") return;
  await sleep(HEALTH_POLL_MS);

  return waitUntilHealthy(remaining - 1);
}

/** Attempts at preparing the project. A container reports healthy before the internal API a commit's pre-receive hook calls is reachable, so the first attempts can fail. */
const PREPARE_ATTEMPTS = 20;
const PREPARE_WAIT_MS = 15_000;

/** Creates the project and its first commit, which the linter needs as the ref it resolves a configuration against. Retried until the instance is really ready. */
async function prepareProject(remaining: number): Promise<void> {
  const script = `
    user = User.find_by(username: "root")
    project = Project.first || Projects::CreateService.new(user, name: "lint", path: "lint", namespace_id: user.namespace.id).execute
    project.repository.create_file(user, "README.md", "lint", message: "init", branch_name: "main") unless project.repository.commit("main")
    puts "prepared=#{project.repository.commit("main") ? "true" : "false"}"
  `;
  try {
    const output = await docker(["exec", CONTAINER, "gitlab-rails", "runner", script]);
    if (/^prepared=true$/m.test(output)) return;
  } catch (error) {
    if (remaining === 0) throw error;
  }
  if (remaining === 0) throw new Error("the GitLab project could not be prepared");
  await sleep(PREPARE_WAIT_MS);

  return prepareProject(remaining - 1);
}

/** Runs GitLab's own `Gitlab::Ci::Lint` on a file already copied into the container, and returns whether it was valid with its errors. */
async function lint(containerPath: string): Promise<{ valid: boolean; errors: string }> {
  const script = `
    content = File.read("${containerPath}")
    user = User.find_by(username: "root")
    project = Project.first
    result = Gitlab::Ci::Lint.new(project: project, current_user: user).validate(content, dry_run: false, ref: "main")
    puts "valid=#{result.valid?}"
    puts "errors=#{result.errors.inspect}"
  `;
  const output = await docker(["exec", CONTAINER, "gitlab-rails", "runner", script]);
  const valid = /^valid=(true|false)$/m.exec(output)?.[1] === "true";
  const errors = /^errors=(.*)$/m.exec(output)?.[1] ?? "";

  return { valid, errors };
}

async function copyIn(name: string, content: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pipewright-gitlab-"));
  const local = join(directory, name);
  await writeFile(local, content);
  const target = `/tmp/${name}`;
  await docker(["cp", local, `${CONTAINER}:${target}`]);

  return target;
}

beforeAll(async () => {
  await docker(["run", "-d", "--name", CONTAINER, "--shm-size", "256m", IMAGE]);
  await waitUntilHealthy(HEALTH_POLLS);
  await prepareProject(PREPARE_ATTEMPTS);
});

afterAll(async () => {
  await docker(["rm", "-f", CONTAINER]).catch(() => "");
});

describe("GitLab's own CI linter", () => {
  it("accepts the emitted sample", async () => {
    const [file] = await createGitLabCiCompiler().compile(samplePipeline(), {
      source: "ci/sample.pipeline.json",
    });
    if (file === undefined) throw new Error("no file emitted");
    const result = await lint(await copyIn("gitlab-ci.yml", file.content));
    expect(result).toEqual({ valid: true, errors: "[]" });
  });

  it("rejects a control with a misspelt keyword", async () => {
    const control = "stages: [test]\nbroken:\n  stage: test\n  scripts:\n    - echo nope\n";
    const result = await lint(await copyIn("invalid.yml", control));
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("script");
  });
});
