import { describe, expect, it } from "vitest";

import {
  UnsupportedNativeError,
  context,
  pipelineSchema,
  describeImporterConformance,
  when,
  type Pipeline,
} from "@pipewright/pipeline-contract";

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
  recoversMatrix: true,
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

  it("expands merge keys before reading, carrying the hidden template at pipeline level", async () => {
    const pipeline = await importText(
      `${WORKFLOW}.defaults: &defaults\n  tags: [linux]\n  script: [echo]\nbuild:\n  <<: *defaults\n`,
    );

    expect(pipeline.native).toEqual({
      "gitlab-ci": { ".defaults": { tags: ["linux"], script: ["echo"] } },
    });
    expect(pipeline.jobs.build?.runsOn).toEqual(["linux"]);
    expect(pipeline.jobs.build?.steps[1]).toMatchObject({ kind: "run", run: "echo" });
  });

  it("carries an include at pipeline level and re-emits it unchanged", async () => {
    const text = `${WORKFLOW}include:\n  - local: templates/jobs.yml\nbuild:\n  script: [echo]\n`;
    const pipeline = await importText(text);
    const [emitted] = await createGitLabCiCompiler().compile(pipeline, { source: "s" });

    expect(pipeline.native).toEqual({
      "gitlab-ci": { include: [{ local: "templates/jobs.yml" }] },
    });
    expect(emitted?.content).toContain("include:");
    expect(emitted?.content).toContain("local: templates/jobs.yml");
  });

  it("reads a job with no tags as one with no runner label", async () => {
    const pipeline = await importText(`${WORKFLOW}build:\n  script:\n    - echo\n`);

    expect(pipeline.jobs.build?.runsOn).toEqual([]);
  });

  it("names the provider and pointer of what it rejects", async () => {
    const error = await rejection(`${WORKFLOW}build:\n  script:\n    - echo\n  tags: linux\n`);

    expect(error.pointer).toBe("/build/tags");
    expect(error.provider).toBe("gitlab-ci");
  });

  it("makes a job with no needs wait for every job in every earlier stage", async () => {
    const pipeline = await importText(
      `${WORKFLOW}stages: [build, test, deploy]\nbuild-a:\n  stage: build\n${JOB}build-b:\n  stage: build\n${JOB}test-x:\n  stage: test\n  needs: [build-a]\n${JOB}deploy:\n  stage: deploy\n${JOB}`,
    );

    expect(pipeline.jobs.deploy?.needs).toEqual(["build-a", "build-b", "test-x"]);
  });

  it("rejects a stage order over a job that may not run", async () => {
    const error = await rejection(
      `${WORKFLOW}stages: [build, test]\nbuild-a:\n  stage: build\n${JOB}  rules:\n    - if: $CI_COMMIT_TAG\ncheck:\n  stage: test\n${JOB}`,
    );

    expect(error.pointer).toBe("/check");
  });

  it("reads the lines of a script as one step, since they share a shell", async () => {
    const pipeline = await importText(
      `${WORKFLOW}build:\n  tags: [linux]\n  script:\n    - cd web\n    - npm test\n`,
    );

    expect(pipeline.jobs.build?.steps[1]).toEqual({ kind: "run", run: "cd web\nnpm test" });
  });

  it("carries a script that reads a GitLab variable or a matrix axis as a provider step", async () => {
    const pipeline = await importText(
      `${WORKFLOW}test:\n  tags: [linux]\n  parallel:\n    matrix:\n      - NODE: ["20", "22"]\n  script:\n    - nvm use $NODE\n`,
    );
    const other = await importText(
      `${WORKFLOW}build:\n  tags: [linux]\n  script:\n    - echo $CI_COMMIT_SHA\n`,
    );

    expect(pipeline.jobs.test?.steps[1]).toMatchObject({
      kind: "provider",
      native: { script: ["nvm use $NODE"] },
    });
    expect(other.jobs.build?.steps[1]).toMatchObject({ kind: "provider" });
  });

  it("reads a pipeline-level GIT_DEPTH and GIT_STRATEGY into each job's checkout", async () => {
    const depth = await importText(`${WORKFLOW}variables:\n  GIT_DEPTH: "0"\nbuild:\n${JOB}`);
    const none = await importText(`${WORKFLOW}variables:\n  GIT_STRATEGY: none\nbuild:\n${JOB}`);

    expect(depth.jobs.build?.steps[0]).toEqual({ kind: "checkout", fetchDepth: "full" });
    expect(none.jobs.build?.steps[0]).toMatchObject({ kind: "run" });
  });

  it("keeps an environment name with a variable in it as GitLab's", async () => {
    const pipeline = await importText(
      `${WORKFLOW}deploy:\n${JOB}  environment: review/$CI_COMMIT_REF_SLUG\n`,
    );

    expect(pipeline.jobs.deploy?.environment).toBeUndefined();
    expect(pipeline.jobs.deploy?.native).toEqual({
      "gitlab-ci": { environment: "review/$CI_COMMIT_REF_SLUG" },
    });
  });

  it("keeps the stage barrier for a job with no needs after a job that has none either", async () => {
    const pipeline = await importText(
      `${WORKFLOW}stages: [build, test, deploy]\nbuild-a:\n  stage: build\n${JOB}check:\n  stage: test\n  needs: []\n${JOB}deploy:\n  stage: deploy\n${JOB}`,
    );

    expect(pipeline.jobs.check?.needs).toEqual([]);
    expect(pipeline.jobs.deploy?.needs).toEqual(["build-a", "check"]);
  });

  it("keeps a job that waits for a person, or that rules cannot be read for, as GitLab's whole", async () => {
    const manual = await importText(`${WORKFLOW}deploy:\n${JOB}  when: manual\n`);
    const never = await importText(`${WORKFLOW}deploy:\n${JOB}  rules:\n    - when: never\n`);

    for (const pipeline of [manual, never]) {
      expect(pipeline.jobs.deploy?.steps[1]).toMatchObject({ kind: "provider" });
    }
    expect(manual.jobs.deploy?.native).toEqual({ "gitlab-ci": { when: "manual" } });
  });

  it("writes a dollar sign from another provider as $$ and reads $$ back as one", async () => {
    const [file] = await createGitLabCiCompiler().compile(
      pipelineSchema.parse({
        name: "CI",
        triggers: [{ kind: "push" }],
        jobs: {
          a: {
            name: "A",
            runsOn: [],
            env: { PAYLOAD: "$CI_JOB_TOKEN" },
            steps: [{ kind: "run", run: "true" }],
          },
        },
      }),
      { source: "s" },
    );

    expect(file?.content).toContain("PAYLOAD: $$CI_JOB_TOKEN");
    const back = await createGitLabCiImporter().import(file ?? { path: "", content: "" });
    expect(back.jobs.a?.env).toEqual({ PAYLOAD: "$CI_JOB_TOKEN" });
  });

  it("carries a script containing a GitHub expression as a provider step", async () => {
    const pipeline = await importText(
      `${WORKFLOW}build:\n  tags: [linux]\n  script:\n    - echo '\${{ github.token }}'\n`,
    );

    expect(pipeline.jobs.build?.steps[1]).toMatchObject({ kind: "provider" });
  });

  it("keeps a job with a before_script or an image as GitLab's whole", async () => {
    const pipeline = await importText(
      `${WORKFLOW}deploy:\n  tags: [linux]\n  image: node:22\n  before_script:\n    - exit 1\n  script:\n    - ./deploy\n`,
    );

    expect(pipeline.jobs.deploy?.steps[1]).toMatchObject({ kind: "provider" });
  });

  it("does not read a case-sensitive comparison of two texts as the model's equality", async () => {
    const pipeline = await importText(
      `${WORKFLOW}deploy:\n${JOB}  rules:\n    - if: '"PROD" == "prod"'\n`,
    );

    expect(pipeline.jobs.deploy?.when).toBeUndefined();
    expect(pipeline.jobs.deploy?.steps[1]).toMatchObject({ kind: "provider" });
  });

  it("round-trips a job with several run steps, which share one shell and are written as one", async () => {
    const compiler = createGitLabCiCompiler();
    const pipeline = pipelineSchema.parse({
      name: "CI",
      triggers: [{ kind: "push" }],
      jobs: {
        build: {
          name: "Build",
          runsOn: [],
          steps: [
            { kind: "run", run: "cd web", description: "Enter the package." },
            { kind: "run", run: "npm test" },
          ],
        },
      },
    });
    const [first] = await compiler.compile(pipeline, { source: "s" });
    if (first === undefined) throw new Error("no file emitted");
    const imported = await createGitLabCiImporter().import(first);
    const [second] = await compiler.compile(imported, { source: "s" });

    expect(Object.values(imported.jobs)[0]?.steps).toEqual([
      { kind: "checkout" },
      { kind: "run", run: "cd web", description: "Enter the package." },
      { kind: "run", run: "npm test" },
    ]);
    expect(second?.content).toBe(first.content);
    expect(first.content).toMatch(/set -e\n\s+cd web\n\s+__pipewright_status=\$\?;/);
  });

  it("reads a file with no workflow section as the provider's default sources, which is no triggers", async () => {
    const pipeline = await importText(`build:\n${JOB}`);

    expect(pipeline.triggers).toEqual([]);
    expect(pipeline.name).toBe("gitlab-ci");
  });

  it("writes no workflow rules for a pipeline with no triggers", async () => {
    const pipeline = await importText(`build:\n${JOB}`);
    const [file] = await createGitLabCiCompiler().compile(pipeline, { source: "s" });

    expect(file?.content).not.toContain("rules:\n    - if: $CI_PIPELINE_SOURCE");
    expect(file?.content).toContain("workflow:");
  });

  it("carries a top-level image and before_script on each job that does not set them", async () => {
    const pipeline = await importText(
      `${WORKFLOW}image: node:22\nbefore_script:\n  - npm ci\na:\n${JOB}b:\n${JOB}  image: python:3\n`,
    );

    expect(pipeline.jobs.a?.native).toEqual({
      "gitlab-ci": { image: "node:22", before_script: ["npm ci"] },
    });
    expect(pipeline.jobs.b?.native).toEqual({
      "gitlab-ci": { image: "python:3", before_script: ["npm ci"] },
    });
    expect(pipeline.jobs.a?.steps[1]).toMatchObject({ kind: "provider" });
  });

  it("reads default as the same defaults, and honours inherit:default:false", async () => {
    const pipeline = await importText(
      `${WORKFLOW}default:\n  image: node:22\n  tags: [linux]\na:\n  script: [x]\nb:\n  script: [y]\n  inherit:\n    default: false\n`,
    );

    expect(pipeline.jobs.a?.runsOn).toEqual(["linux"]);
    expect(pipeline.jobs.a?.native).toEqual({ "gitlab-ci": { image: "node:22" } });
    expect(pipeline.jobs.b?.native).toEqual({ "gitlab-ci": { inherit: { default: false } } });
    expect(pipeline.jobs.b?.runsOn).toEqual([]);
  });

  it("gives a job the default tags only when its inherit.default allows tags", async () => {
    const pipeline = await importText(
      `${WORKFLOW}default:\n  tags: [privileged]\na:\n  script: [x]\n  inherit:\n    default: [image]\nb:\n  script: [y]\n  inherit:\n    default: [tags]\n`,
    );

    expect(pipeline.jobs.a?.runsOn).toEqual([]);
    expect(pipeline.jobs.b?.runsOn).toEqual(["privileged"]);
  });
});
