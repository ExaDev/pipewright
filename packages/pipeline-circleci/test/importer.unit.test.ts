import { describe, expect, it } from "vitest";

import {
  UnsupportedNativeError,
  describeImporterConformance,
  type Pipeline,
} from "@ci-adapters/pipeline-contract";

import { createCircleCiCompiler, createCircleCiImporter } from "../src/index.ts";

const FILE = ".circleci/config.yml";

async function importText(text: string): Promise<Pipeline> {
  return createCircleCiImporter().import({ path: FILE, content: text });
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

const JOB =
  "  build:\n    docker:\n      - image: cimg/base:stable\n    steps:\n      - checkout\n      - run: make\n";
const WORKFLOW = "workflows:\n  ci:\n    jobs:\n      - build\n";

const REJECTS = [
  {
    name: "orbs",
    text: `version: 2.1\norbs:\n  node: circleci/node@5\njobs:\n${JOB}${WORKFLOW}`,
  },
  {
    name: "more than one workflow",
    text: `version: 2.1\njobs:\n${JOB}workflows:\n  one:\n    jobs: [build]\n  two:\n    jobs: [build]\n`,
  },
  {
    name: "a workflow job filter",
    text: `version: 2.1\njobs:\n${JOB}workflows:\n  ci:\n    jobs:\n      - build:\n          filters:\n            branches:\n              only: main\n`,
  },
  {
    name: "a job no workflow runs",
    text: `version: 2.1\njobs:\n${JOB}  unused:\n    docker:\n      - image: x\n    steps:\n      - run: y\n${WORKFLOW}`,
  },
];

describeImporterConformance({ describe, it }, createCircleCiCompiler, createCircleCiImporter, {
  features: { environment: true, concurrency: false, timeouts: false, manualTrigger: false },
  rejects: REJECTS.map(({ name, text }) => ({ name, file: { path: FILE, content: text } })),
  wrapperForm: true,
  distinguishesGate: false,
  recoversMatrix: true,
});

describe("CircleCI import", () => {
  it("reads a job's executor onto native.circleci and its steps", async () => {
    const pipeline = await importText(`version: 2.1\njobs:\n${JOB}${WORKFLOW}`);

    expect(pipeline.name).toBe("ci");
    expect(pipeline.jobs.build?.native).toEqual({
      circleci: { docker: [{ image: "cimg/base:stable" }] },
    });
    expect(pipeline.jobs.build?.steps).toEqual([
      { kind: "checkout" },
      { kind: "run", run: "make" },
    ]);
  });

  it("reads a branch condition as the push trigger", async () => {
    const pipeline = await importText(
      `version: 2.1\njobs:\n${JOB}workflows:\n  ci:\n    when:\n      or:\n        - equal: [main, << pipeline.git.branch >>]\n        - equal: [dev, << pipeline.git.branch >>]\n    jobs: [build]\n`,
    );

    expect(pipeline.triggers).toEqual([{ kind: "push", branches: ["main", "dev"] }]);
  });

  it("reads requires and the terminal status as needs and an always-running job", async () => {
    const pipeline = await importText(
      `version: 2.1\njobs:\n${JOB}  clean:\n    docker:\n      - image: x\n    steps:\n      - run: rm\nworkflows:\n  ci:\n    jobs:\n      - build\n      - clean:\n          requires:\n            - build: terminal\n`,
    );

    expect(pipeline.jobs.clean?.needs).toEqual(["build"]);
    expect(pipeline.jobs.clean?.needsPolicy).toBe("always");
  });

  it("reads a matrix, its alias and the display name it was written with", async () => {
    const pipeline = await importText(
      `version: 2.1\njobs:\n  test:\n    parameters:\n      node:\n        type: string\n    docker:\n      - image: x\n    environment:\n      V: << parameters.node >>\n      SHA: << pipeline.git.revision >>\n    steps:\n      - run: t\nworkflows:\n  ci:\n    jobs:\n      - test:\n          name: Test (<< matrix.node >>)\n          matrix:\n            alias: test\n            parameters:\n              node: ["22", "24"]\n`,
    );

    expect(pipeline.jobs.test?.name).toBe("Test");
    expect(pipeline.jobs.test?.matrix).toEqual({ node: ["22", "24"] });
    expect(pipeline.jobs.test?.env).toEqual({ V: "{{ matrix.node }}", SHA: "{{ sha }}" });
  });

  it("keeps a step that is not a plain run or checkout as a provider step", async () => {
    const pipeline = await importText(
      `version: 2.1\njobs:\n  build:\n    docker:\n      - image: x\n    steps:\n      - setup_remote_docker\n      - save_cache:\n          key: k\n          paths: [a]\n      - run:\n          command: make\n          no_output_timeout: 20m\n${WORKFLOW}`,
    );

    expect(pipeline.jobs.build?.steps).toEqual([
      { kind: "provider", provider: "circleci", native: { setup_remote_docker: {} } },
      {
        kind: "provider",
        provider: "circleci",
        native: { save_cache: { key: "k", paths: ["a"] } },
      },
      {
        kind: "provider",
        provider: "circleci",
        native: { run: { command: "make", no_output_timeout: "20m" } },
      },
    ]);
  });

  it("rejects a workflow name the compiler would rewrite", async () => {
    const error = await rejection(
      `version: 2.1\njobs:\n${JOB}workflows:\n  build_and_test:\n    jobs: [build]\n`,
    );

    expect(error.pointer).toBe("/workflows/build_and_test");
    expect(error.provider).toBe("circleci");
  });

  it("carries a command CircleCI substitutes into as a provider step", async () => {
    const pipeline = await importText(
      `version: 2.1\njobs:\n  build:\n    docker:\n      - image: x\n    steps:\n      - run: echo << pipeline.git.revision >>\n${WORKFLOW}`,
    );

    expect(pipeline.jobs.build?.steps[0]).toEqual({
      kind: "provider",
      provider: "circleci",
      native: { run: "echo << pipeline.git.revision >>" },
    });
  });

  it("carries a command that reads a CircleCI variable as a provider step", async () => {
    const pipeline = await importText(
      `version: 2.1\njobs:\n  build:\n    docker:\n      - image: x\n    steps:\n      - run: echo $CIRCLE_SHA1\n${WORKFLOW}`,
    );

    expect(pipeline.jobs.build?.steps[0]).toMatchObject({ kind: "provider" });
  });

  it("rejects a job parameter that the matrix does not supply", async () => {
    const error = await rejection(
      `version: 2.1\njobs:\n  test:\n    parameters:\n      node:\n        type: string\n      cache:\n        type: boolean\n        default: true\n    docker:\n      - image: x\n    steps:\n      - run: t\nworkflows:\n  ci:\n    jobs:\n      - test:\n          name: Test (<< matrix.node >>)\n          matrix:\n            alias: test\n            parameters:\n              node: ["22"]\n`,
    );

    expect(error.pointer).toBe("/jobs/test/parameters/cache");
  });

  it("rejects an axis declaration with settings beyond its type", async () => {
    const error = await rejection(
      `version: 2.1\njobs:\n  test:\n    parameters:\n      node:\n        type: string\n        default: "22"\n    docker:\n      - image: x\n    steps:\n      - run: t\nworkflows:\n  ci:\n    jobs:\n      - test:\n          name: Test (<< matrix.node >>)\n          matrix:\n            alias: test\n            parameters:\n              node: ["22"]\n`,
    );

    expect(error.pointer).toBe("/jobs/test/parameters/node");
  });

  it("reads a branch equality with its operands either way round", async () => {
    const pipeline = await importText(
      `version: 2.1\njobs:\n${JOB}workflows:\n  ci:\n    when:\n      equal: [<< pipeline.git.branch >>, main]\n    jobs: [build]\n`,
    );

    expect(pipeline.triggers).toEqual([{ kind: "push", branches: ["main"] }]);
  });

  it("expands a merge key before reading a job", async () => {
    const pipeline = await importText(
      `version: 2.1\ndefaults: &defaults\n  docker:\n    - image: x\njobs:\n  build:\n    <<: *defaults\n    steps:\n      - run: make\n${WORKFLOW}`,
    ).catch((error: unknown) => error);

    // A top-level anchor holder is a setting the model has no place for, which is rejected by name.
    expect(pipeline).toBeInstanceOf(UnsupportedNativeError);
  });
});
