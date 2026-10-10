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
} from "@ci-adapters/pipeline-contract";
import { createBitbucketPipelinesCompiler } from "@ci-adapters/pipeline-bitbucket";
import { createCircleCiCompiler } from "@ci-adapters/pipeline-circleci";
import { createGitHubActionsCompiler } from "@ci-adapters/pipeline-github-actions";
import { createGitLabCiCompiler } from "@ci-adapters/pipeline-gitlab-ci";

async function runActionlint(path: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    execFile("actionlint", [path], (error) => {
      if (error === null) resolve();
      else reject(new Error(`actionlint rejected the workflow: ${error.message}`));
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

async function schemaErrors(url: string, document: unknown): Promise<unknown[]> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`could not fetch ${url}: ${String(response.status)}`);
  const schema: unknown = await response.json();
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

    await expect(runActionlint(target)).resolves.toBeUndefined();
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
