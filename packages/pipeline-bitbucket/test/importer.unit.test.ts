import { describe, expect, it } from "vitest";

import {
  UnsupportedNativeError,
  describeImporterConformance,
  type Pipeline,
} from "@pipewright/pipeline-contract";

import {
  createBitbucketPipelinesCompiler,
  createBitbucketPipelinesImporter,
} from "../src/index.ts";

const FILE = "bitbucket-pipelines.yml";

async function importText(text: string): Promise<Pipeline> {
  return createBitbucketPipelinesImporter().import({ path: FILE, content: text });
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

const STEP = "      - step:\n          name: A\n          script:\n            - echo\n";

const REJECTS = [
  {
    name: "a setting the model has no place for",
    text: `image: node:22\npipelines:\n  default:\n${STEP}`,
  },
  {
    name: "a pipeline for a tag",
    text: `pipelines:\n  tags:\n    "v*":\n${STEP}`,
  },
  {
    name: "a custom pipeline that is not the manual one",
    text: `pipelines:\n  custom:\n    deploy:\n${STEP}`,
  },
  {
    name: "triggers that run different steps",
    text: `pipelines:\n  default:\n${STEP}  branches:\n    main:\n      - step:\n          name: B\n          script:\n            - echo\n`,
  },
  {
    name: "a stage",
    text: "pipelines:\n  default:\n    - stage:\n        name: S\n        steps:\n          - step:\n              script:\n                - echo\n",
  },
];

describeImporterConformance(
  { describe, it },
  createBitbucketPipelinesCompiler,
  createBitbucketPipelinesImporter,
  {
    features: { environment: false, concurrency: false, timeouts: true, manualTrigger: true },
    rejects: REJECTS.map(({ name, text }) => ({ name, file: { path: FILE, content: text } })),
    wrapperForm: true,
    distinguishesGate: false,
    recoversMatrix: false,
  },
);

describe("Bitbucket Pipelines import", () => {
  it("reads steps and parallel groups as a graph where each group waits for the one before", async () => {
    const pipeline = await importText(
      "pipelines:\n  default:\n    - step:\n        name: Build\n        script: [make]\n    - parallel:\n        - step:\n            name: Unit\n            script: [a]\n        - step:\n            name: Lint\n            script: [b]\n    - step:\n        name: Ship\n        script: [c]\n",
    );

    expect(Object.keys(pipeline.jobs)).toEqual(["build", "unit", "lint", "ship"]);
    expect(pipeline.jobs.unit?.needs).toEqual(["build"]);
    expect(pipeline.jobs.lint?.needs).toEqual(["build"]);
    expect(pipeline.jobs.ship?.needs).toEqual(["unit", "lint"]);
  });

  it("reads a final step as a job that runs whatever happened", async () => {
    const pipeline = await importText(
      "pipelines:\n  default:\n    - step:\n        name: Build\n        script: [make]\n    - final:\n        name: Clean\n        script: [rm]\n",
    );

    expect(pipeline.jobs.clean?.needsPolicy).toBe("always");
  });

  it("rejects a final step that is not last", async () => {
    const error = await rejection(
      "pipelines:\n  default:\n    - final:\n        script: [rm]\n    - step:\n        script: [make]\n",
    );

    expect(error.pointer).toBe("/pipelines/default/0/final");
  });

  it("reads clone depth as the checkout and keeps other clone settings as Bitbucket's", async () => {
    const depth = await importText(
      "pipelines:\n  default:\n    - step:\n        clone:\n          depth: 5\n        script: [make]\n",
    );
    const other = await importText(
      "pipelines:\n  default:\n    - step:\n        clone:\n          enabled: false\n        script: [make]\n",
    );

    expect(Object.values(depth.jobs)[0]?.steps[0]).toEqual({ kind: "checkout", fetchDepth: 5 });
    expect(Object.values(other.jobs)[0]?.steps).toEqual([
      { kind: "provider", provider: "bitbucket-pipelines", native: { script: ["make"] } },
    ]);
    expect(Object.values(other.jobs)[0]?.native).toEqual({
      "bitbucket-pipelines": { clone: { enabled: false } },
    });
  });

  it("reads a pipe as a provider step and keeps other step keys", async () => {
    const pipeline = await importText(
      "pipelines:\n  default:\n    - step:\n        image: node:22\n        script:\n          - pipe: atlassian/aws-s3-deploy:1.0.0\n            variables:\n              A: b\n",
    );
    const [job] = Object.values(pipeline.jobs);

    expect(job?.steps[1]).toEqual({
      kind: "provider",
      provider: "bitbucket-pipelines",
      native: { pipe: "atlassian/aws-s3-deploy:1.0.0", variables: { A: "b" } },
    });
    expect(job?.native).toEqual({ "bitbucket-pipelines": { image: "node:22" } });
  });

  it("reads self-hosted runner labels and keeps labels that name no self-hosted runner", async () => {
    const hosted = await importText(
      "pipelines:\n  default:\n    - step:\n        runs-on: [self.hosted, linux]\n        script: [make]\n",
    );
    const other = await importText(
      "pipelines:\n  default:\n    - step:\n        runs-on: [linux]\n        script: [make]\n",
    );

    expect(Object.values(hosted.jobs)[0]?.runsOn).toEqual(["self.hosted", "linux"]);
    expect(Object.values(other.jobs)[0]?.runsOn).toEqual([]);
    expect(Object.values(other.jobs)[0]?.native).toEqual({
      "bitbucket-pipelines": { "runs-on": ["linux"] },
    });
  });

  it("reads branch names, pull requests and the manual pipeline as triggers", async () => {
    const pipeline = await importText(
      `pipelines:\n  branches:\n    main:\n${STEP}    release/1:\n${STEP}  pull-requests:\n    "**":\n${STEP}  custom:\n    manual:\n${STEP}`,
    );

    expect(pipeline.triggers).toEqual([
      { kind: "push", branches: ["main", "release/1"] },
      { kind: "pullRequest" },
      { kind: "manual" },
    ]);
  });

  it("names an unnamed step for its position and the pipeline for its file", async () => {
    const pipeline = await importText(
      "pipelines:\n  default:\n    - step:\n        script: [make]\n",
    );

    expect(pipeline.name).toBe("bitbucket-pipelines");
    expect(Object.values(pipeline.jobs)[0]?.name).toBe("Step 1");
  });

  it("names the pointer and provider of what it rejects", async () => {
    const error = await rejection("pipelines:\n  default:\n    - step:\n        name: A\n");

    expect(error.pointer).toBe("/pipelines/default/0/step/script");
    expect(error.provider).toBe("bitbucket-pipelines");
  });

  it("reads the command lines of a step as one step, since they share a shell", async () => {
    const pipeline = await importText(
      "pipelines:\n  default:\n    - step:\n        script:\n          - cd web\n          - npm test\n          - pipe: atlassian/slack-notify:2\n          - echo done\n",
    );
    const [job] = Object.values(pipeline.jobs);

    expect(job?.steps.map((step) => step.kind)).toEqual(["checkout", "run", "provider", "run"]);
    expect(job?.steps[1]).toEqual({ kind: "run", run: "cd web\nnpm test" });
  });

  it("carries a script that reads a Bitbucket variable as a provider step", async () => {
    const pipeline = await importText(
      "pipelines:\n  default:\n    - step:\n        script:\n          - echo $BITBUCKET_COMMIT\n",
    );

    expect(Object.values(pipeline.jobs)[0]?.steps[1]).toEqual({
      kind: "provider",
      provider: "bitbucket-pipelines",
      native: { script: ["echo $BITBUCKET_COMMIT"] },
    });
  });

  it("rejects a branch pattern, which the model's branch names are not", async () => {
    const error = await rejection(`pipelines:\n  branches:\n    "feature/*":\n${STEP}`);

    expect(error.pointer).toBe("/pipelines/branches/feature~1*");
  });

  it("keeps a step that waits for a person or has a condition as Bitbucket's whole", async () => {
    const manual = await importText(
      "pipelines:\n  default:\n    - step:\n        name: Deploy\n        trigger: manual\n        script: [deploy]\n",
    );
    const conditional = await importText(
      "pipelines:\n  default:\n    - step:\n        condition:\n          changesets:\n            includePaths: [src/**]\n        script: [build]\n",
    );

    for (const pipeline of [manual, conditional]) {
      expect(Object.values(pipeline.jobs)[0]?.steps[1]).toMatchObject({ kind: "provider" });
    }
    expect(Object.values(manual.jobs)[0]?.native).toEqual({
      "bitbucket-pipelines": { trigger: "manual" },
    });
  });

  it("carries a script containing a GitHub expression as a provider step", async () => {
    const pipeline = await importText(
      "pipelines:\n  default:\n    - step:\n        script:\n          - echo '${{ github.token }}'\n",
    );

    expect(Object.values(pipeline.jobs)[0]?.steps[1]).toMatchObject({ kind: "provider" });
  });

  it("keeps a step with Bitbucket's own settings, such as an image or an after-script, as Bitbucket's whole", async () => {
    const pipeline = await importText(
      "pipelines:\n  default:\n    - step:\n        image: node:22\n        after-script: [cleanup]\n        script: [./deploy]\n",
    );

    expect(Object.values(pipeline.jobs)[0]?.steps[1]).toEqual({
      kind: "provider",
      provider: "bitbucket-pipelines",
      native: { script: ["./deploy"] },
    });
  });
});
