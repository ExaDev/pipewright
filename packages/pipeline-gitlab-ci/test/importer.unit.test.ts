import { describe, expect, it } from "vitest";

import {
  UnsupportedNativeError,
  context,
  describeImporterConformance,
  when,
  type Pipeline,
} from "@ci-adapters/pipeline-contract";

import { createGitLabCiCompiler, createGitLabCiImporter } from "../src/index.ts";

const FILE = ".gitlab-ci.yml";

async function importText(text: string): Promise<Pipeline> {
  return createGitLabCiImporter().import({ path: FILE, content: text });
}

async function rejection(text: string): Promise<UnsupportedNativeError> {
  try {
    await importText(text);
  } catch (error) {
    if (error instanceof UnsupportedNativeError) return error;
    throw error;
  }
  throw new Error("the file was accepted");
}

const WORKFLOW = 'workflow:\n  name: CI\n  rules:\n    - if: $CI_PIPELINE_SOURCE == "push"\n';
const JOB = "  script:\n    - echo\n  tags:\n    - linux\n";

const REJECTS = [
  {
    name: "a job with no tags",
    text: `${WORKFLOW}build:\n  script:\n    - echo\n`,
  },
  {
    name: "a file with no workflow rules",
    text: `build:\n${JOB}`,
  },
  {
    name: "a job that extends a hidden job",
    text: `${WORKFLOW}.base:\n${JOB}build:\n  extends: .base\n${JOB}`,
  },
  {
    name: "a downstream trigger",
    text: `${WORKFLOW}deploy:\n  trigger: other/project\n`,
  },
  {
    name: "a needs entry with options",
    text: `${WORKFLOW}a:\n${JOB}b:\n${JOB}  needs:\n    - job: a\n      artifacts: false\n`,
  },
];

describeImporterConformance({ describe, it }, createGitLabCiCompiler, createGitLabCiImporter, {
  rejects: REJECTS.map(({ name, text }) => ({ name, file: { path: FILE, content: text } })),
  wrapperForm: true,
  distinguishesGate: false,
});

describe("GitLab CI import", () => {
  it("reads a branch-filtered trigger and the pipeline name", async () => {
    const pipeline = await importText(
      'workflow:\n  name: Build\n  rules:\n    - if: $CI_PIPELINE_SOURCE == "push" && $CI_COMMIT_BRANCH =~ /^(main|release\\/1)$/i\n    - if: $CI_PIPELINE_SOURCE == "merge_request_event"\nbuild:\n' +
        JOB,
    );

    expect(pipeline.name).toBe("Build");
    expect(pipeline.triggers).toEqual([
      { kind: "push", branches: ["main", "release/1"] },
      { kind: "pullRequest" },
    ]);
  });

  it("makes a job with no needs wait for the whole stage before it", async () => {
    const pipeline = await importText(
      `${WORKFLOW}stages: [build, test]\nlint:\n  stage: build\n${JOB}compile:\n  stage: build\n${JOB}check:\n  stage: test\n${JOB}`,
    );

    expect(pipeline.jobs.check?.needs).toEqual(["lint", "compile"]);
    expect(pipeline.jobs.lint?.needs).toBeUndefined();
  });

  it("keeps an explicit empty needs as no dependencies", async () => {
    const pipeline = await importText(
      `${WORKFLOW}stages: [build, test]\nlint:\n  stage: build\n${JOB}check:\n  stage: test\n  needs: []\n${JOB}`,
    );

    expect(pipeline.jobs.check?.needs).toEqual([]);
  });

  it("reads GIT_DEPTH as the checkout depth and context variables as references", async () => {
    const pipeline = await importText(
      `${WORKFLOW}build:\n${JOB}  variables:\n    GIT_DEPTH: "0"\n    REF: $CI_COMMIT_REF_NAME\n`,
    );

    expect(pipeline.jobs.build?.steps[0]).toEqual({ kind: "checkout", fetchDepth: "full" });
    expect(pipeline.jobs.build?.env).toEqual({ REF: "{{ refName }}" });
  });

  it("reads a case-insensitive anchored match as the model's equality", async () => {
    const pipeline = await importText(
      `${WORKFLOW}build:\n${JOB}  rules:\n    - if: $CI_PIPELINE_SOURCE =~ /^merge_request_event$/i && $CI_COMMIT_REF_NAME !~ /^wip$/i\n`,
    );

    expect(pipeline.jobs.build?.when).toEqual({
      kind: "allOf",
      operands: [
        when.equals(context.event, "pullRequest"),
        { ...when.equals(context.refName, "wip"), op: "notEquals" },
      ],
    });
  });

  it("keeps rules it cannot express, such as a case-sensitive comparison, as written", async () => {
    const pipeline = await importText(
      `${WORKFLOW}build:\n${JOB}  rules:\n    - if: $CI_COMMIT_REF_NAME == "main"\n`,
    );

    expect(pipeline.jobs.build?.when).toBeUndefined();
    expect(pipeline.jobs.build?.native).toEqual({
      "gitlab-ci": { rules: [{ if: '$CI_COMMIT_REF_NAME == "main"' }] },
    });
  });

  it("keeps settings the model has no field for on the job's native mapping", async () => {
    const pipeline = await importText(
      `${WORKFLOW}build:\n${JOB}  image: node:22\n  parallel: 3\n  timeout: 1h\n  artifacts:\n    paths: [dist]\n`,
    );

    expect(pipeline.jobs.build?.native).toEqual({
      "gitlab-ci": {
        parallel: 3,
        timeout: "1h",
        image: "node:22",
        artifacts: { paths: ["dist"] },
      },
    });
  });

  it("reads a matrix and a matrix axis used as a variable", async () => {
    const pipeline = await importText(
      `${WORKFLOW}test:\n${JOB}  parallel:\n    matrix:\n      - NODE: ["22", "24"]\n  variables:\n    V: $NODE\n`,
    );

    expect(pipeline.jobs.test?.matrix).toEqual({ NODE: ["22", "24"] });
    expect(pipeline.jobs.test?.env).toEqual({ V: "{{ matrix.NODE }}" });
  });

  it("expands merge keys before reading", async () => {
    const pipeline = await importText(
      `${WORKFLOW}.defaults: &defaults\n  tags: [linux]\n  script: [echo]\nbuild:\n  <<: *defaults\n`,
    ).catch((error: unknown) => error);

    // A hidden job is a template the model does not resolve, so the file is rejected by name.
    expect(pipeline).toBeInstanceOf(UnsupportedNativeError);
  });

  it("names the provider and pointer of what it rejects", async () => {
    const error = await rejection(`${WORKFLOW}build:\n  script:\n    - echo\n`);

    expect(error.pointer).toBe("/build/tags");
    expect(error.provider).toBe("gitlab-ci");
  });
});
