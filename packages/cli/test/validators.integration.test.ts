import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import Ajv from "ajv";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import {
  samplePipeline,
  type PipelineCompiler,
  type SampleFeatures,
} from "@pipewright/pipeline-contract";
import { createBitbucketPipelinesCompiler } from "@pipewright/pipeline-bitbucket";
import { createCircleCiCompiler } from "@pipewright/pipeline-circleci";
import { createGitHubActionsCompiler } from "@pipewright/pipeline-github-actions";
import { createGitLabCiCompiler } from "@pipewright/pipeline-gitlab-ci";

/**
 * Runs a provider's own validator and rejects with its output when it exits non-zero. A missing binary is a failure, not a skip.
 */
async function runTool(command: string, args: readonly string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    execFile(command, [...args], (error, stdout, stderr) => {
      if (error === null) resolve();
      else reject(new Error(`${command} rejected the file: ${error.message}\n${stdout}${stderr}`));
    });
  });
}

/** What the sample pipeline keeps for each provider, matching that adapter's own conformance run. */
const GITHUB: SampleFeatures = {
  environment: true,
  concurrency: true,
  timeouts: true,
  manualTrigger: true,
};
const BITBUCKET: SampleFeatures = {
  environment: false,
  concurrency: false,
  timeouts: true,
  manualTrigger: true,
};
const CIRCLECI: SampleFeatures = {
  environment: true,
  concurrency: false,
  timeouts: false,
  manualTrigger: false,
};

async function emit(compiler: Readonly<PipelineCompiler>, features: SampleFeatures) {
  const files = await compiler.compile(samplePipeline(features), {
    source: "ci/sample.pipeline.json",
  });
  const [file] = files;
  if (file === undefined) throw new Error("no file emitted");

  return file;
}

/** Attempts per schema download. A published schema host that rate-limits answers 429, which is transient by definition. */
const FETCH_ATTEMPTS = 5;
/** The wait after the first refusal when the server gives no Retry-After, doubled on each further one. */
const FIRST_BACKOFF_MS = 2000;
const MS_PER_SECOND = 1000;
/** HTTP statuses that mean the request may succeed if repeated. */
const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_SERVER_ERROR_FLOOR = 500;

async function fetchSchema(url: string): Promise<unknown> {
  const attempt = async (number: number, backoff: number): Promise<unknown> => {
    const response = await fetch(url);
    if (response.ok) return response.json();
    const transient =
      response.status === HTTP_TOO_MANY_REQUESTS || response.status >= HTTP_SERVER_ERROR_FLOOR;
    if (!transient || number >= FETCH_ATTEMPTS) {
      throw new Error(`could not fetch ${url}: ${String(response.status)}`);
    }
    const retryAfter = Number(response.headers.get("retry-after"));
    const wait =
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * MS_PER_SECOND : backoff;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, wait);
    });

    return attempt(number + 1, backoff * 2);
  };

  return attempt(1, FIRST_BACKOFF_MS);
}

async function schemaErrors(url: string, document: unknown): Promise<unknown[]> {
  const schema = await fetchSchema(url);
  if (typeof schema !== "object" || schema === null) throw new Error(`${url} is not a schema`);
  const validate = new Ajv({ strict: false, allErrors: true, logger: false }).compile(schema);
  validate(document);

  return validate.errors ?? [];
}

describe("each provider's own validator accepts the emitted sample", () => {
  it("actionlint accepts the GitHub Actions workflow", async () => {
    const file = await emit(createGitHubActionsCompiler(), GITHUB);
    const root = await mkdtemp(join(tmpdir(), "pipewright-actionlint-"));
    const target = join(root, file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.content);

    await expect(runTool("actionlint", [target])).resolves.toBeUndefined();
  });

  it("GitLab's CI schema accepts the GitLab configuration", async () => {
    const file = await emit(createGitLabCiCompiler(), GITHUB);
    expect(
      await schemaErrors(
        "https://gitlab.com/gitlab-org/gitlab/-/raw/master/app/assets/javascripts/editor/schema/ci.json",
        parse(file.content),
      ),
    ).toEqual([]);
  });

  it("Bitbucket's pipelines schema accepts the Bitbucket configuration", async () => {
    const file = await emit(createBitbucketPipelinesCompiler(), BITBUCKET);
    expect(
      await schemaErrors(
        "https://api.bitbucket.org/schemas/pipelines-configuration",
        parse(file.content),
      ),
    ).toEqual([]);
  });

  it("circleci config validate accepts the CircleCI configuration", async () => {
    const file = await emit(createCircleCiCompiler(), CIRCLECI);
    const root = await mkdtemp(join(tmpdir(), "pipewright-circleci-"));
    const target = join(root, file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.content);

    await expect(
      runTool("circleci", ["config", "validate", target, "--skip-update-check"]),
    ).resolves.toBeUndefined();
  });

  it("CircleCI's published schema accepts the CircleCI configuration", async () => {
    const file = await emit(createCircleCiCompiler(), CIRCLECI);
    expect(
      await schemaErrors(
        "https://raw.githubusercontent.com/CircleCI-Public/circleci-yaml-language-server/refs/heads/main/schema.json",
        parse(file.content),
      ),
    ).toEqual([]);
  });
});
