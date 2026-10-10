import { describe, expect, it } from "vitest";

import {
  UnsupportedNativeError,
  context,
  describeImporterConformance,
  pipelineSchema,
  when,
  type Pipeline,
} from "@pipewright/pipeline-contract";

import { readYaml } from "@pipewright/yaml-emit";

import { createGitHubActionsCompiler, createGitHubActionsImporter } from "../src/index.ts";

const FILE = ".github/workflows/ci.yml";

function workflow(text: string): { path: string; content: string } {
  return { path: FILE, content: text };
}

async function importText(text: string): Promise<Pipeline> {
  return createGitHubActionsImporter().import(workflow(text));
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

const REJECTS = [
  {
    name: "a job that calls a reusable workflow",
    text: "on: push\njobs:\n  call:\n    uses: org/repo/.github/workflows/x.yml@v1\n",
  },
  {
    name: "a trigger filter the model has no place for",
    text: "on:\n  push:\n    tags: ['v*']\njobs:\n  a:\n    runs-on: x\n    steps:\n      - run: a\n",
  },
  {
    name: "a trigger the model has no place for",
    text: "on: release\njobs:\n  a:\n    runs-on: x\n    steps:\n      - run: a\n",
  },
  {
    name: "a workflow-level default",
    text: "on: push\ndefaults:\n  run:\n    shell: bash\njobs:\n  a:\n    runs-on: x\n    steps:\n      - run: a\n",
  },
];

describeImporterConformance(
  { describe, it },
  createGitHubActionsCompiler,
  createGitHubActionsImporter,
  {
    rejects: REJECTS.map(({ name, text }) => ({ name, file: workflow(text) })),
    wrapperForm: true,
    distinguishesGate: true,
    recoversMatrix: true,
  },
);

describe("GitHub Actions import", () => {
  it("reads a workflow written by hand", async () => {
    const pipeline = await importText(`
name: Build
on: [push, pull_request]
jobs:
  build:
    runs-on: ubuntu-latest
    continue-on-error: true
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - run: pnpm test
`);

    expect(pipeline.triggers).toEqual([{ kind: "push" }, { kind: "pullRequest" }]);
    expect(pipeline.jobs.build?.name).toBe("build");
    expect(pipeline.jobs.build?.native).toEqual({
      "github-actions": { "continue-on-error": true },
    });
    expect(pipeline.jobs.build?.steps[0]).toEqual({
      kind: "provider",
      provider: "github-actions",
      native: { uses: "actions/checkout@v4", with: { "fetch-depth": 0 } },
    });
  });

  it("keeps a job environment with an expression the model has no token for, whole, for GitHub", async () => {
    const pipeline = await importText(
      "on: push\njobs:\n  a:\n    runs-on: x\n    env:\n      TOKEN: ${{ secrets.GITHUB_TOKEN }}\n      REF: ${{ github.ref_name }}\n    steps:\n      - run: a\n",
    );

    expect(pipeline.jobs.a?.env).toBeUndefined();
    expect(pipeline.jobs.a?.native).toEqual({
      "github-actions": {
        env: { TOKEN: "${{ secrets.GITHUB_TOKEN }}", REF: "${{ github.ref_name }}" },
      },
    });
  });

  it("reads a context expression in an environment as the neutral reference", async () => {
    const pipeline = await importText(
      "on: push\njobs:\n  a:\n    runs-on: x\n    env:\n      REF: ${{ github.ref_name }}\n    steps:\n      - run: a\n",
    );

    expect(pipeline.jobs.a?.env).toEqual({ REF: "{{ refName }}" });
  });

  it("keeps a matrix with an include, and what references it, as GitHub's", async () => {
    const pipeline = await importText(
      "on: push\njobs:\n  a:\n    runs-on: x\n    strategy:\n      fail-fast: false\n      matrix:\n        os: [a, b]\n    steps:\n      - run: a\n        env:\n          OS: ${{ matrix.os }}\n",
    );

    expect(pipeline.jobs.a?.matrix).toBeUndefined();
    expect(pipeline.jobs.a?.native).toEqual({
      "github-actions": { strategy: { "fail-fast": false, matrix: { os: ["a", "b"] } } },
    });
    expect(pipeline.jobs.a?.steps[0]).toMatchObject({ kind: "provider" });
  });

  it("carries a command that GitHub evaluates expressions in as a provider step", async () => {
    const pipeline = await importText(
      "on: push\njobs:\n  a:\n    runs-on: x\n    steps:\n      - run: echo ${{ github.sha }}\n",
    );

    expect(pipeline.jobs.a?.steps[0]).toEqual({
      kind: "provider",
      provider: "github-actions",
      native: { run: "echo ${{ github.sha }}" },
    });
  });

  it("names a workflow with no name for its file", async () => {
    const pipeline = await importText(
      "on: push\njobs:\n  a:\n    runs-on: x\n    steps:\n      - run: a\n",
    );

    expect(pipeline.name).toBe("ci");
  });

  it("reads conditions over the event, the ref and a matrix axis into the model's predicates", async () => {
    const pipeline = await importText(`
on: push
jobs:
  a:
    runs-on: x
    if: github.event_name == 'pull_request' && github.ref_name != 'main'
    strategy:
      matrix:
        node: ['22', '24']
    steps:
      - run: a
        if: matrix.node == '22' || github.event_name == 'push'
`);

    expect(pipeline.jobs.a?.when).toEqual({
      kind: "allOf",
      operands: [
        when.equals(context.event, "pullRequest"),
        { ...when.equals(context.refName, "main"), op: "notEquals" },
      ],
    });
    const [step] = pipeline.jobs.a?.steps ?? [];
    expect(step).toMatchObject({
      when: {
        kind: "anyOf",
        operands: [
          { kind: "textCompare", left: { key: "matrix.node" } },
          when.equals(context.event, "push"),
        ],
      },
    });
  });

  it("keeps a job condition with no neutral form as written, for GitHub to read", async () => {
    const pipeline = await importText(
      "on: push\njobs:\n  a:\n    runs-on: x\n    if: github.ref == 'refs/heads/main'\n    steps:\n      - run: a\n",
    );

    expect(pipeline.jobs.a?.when).toBeUndefined();
    expect(pipeline.jobs.a?.native).toEqual({
      "github-actions": { if: "github.ref == 'refs/heads/main'" },
    });
  });

  it("carries a step whose condition has no neutral form as a provider step", async () => {
    const pipeline = await importText(
      "on: push\njobs:\n  a:\n    runs-on: x\n    steps:\n      - run: a\n        if: failure()\n",
    );

    expect(pipeline.jobs.a?.steps[0]).toEqual({
      kind: "provider",
      provider: "github-actions",
      native: { if: "failure()", run: "a" },
    });
  });

  it("reads always as a policy, with or without a condition after it", async () => {
    const pipeline = await importText(
      "on: push\njobs:\n  a:\n    runs-on: x\n    steps:\n      - run: a\n  b:\n    runs-on: x\n    needs: a\n    if: always() && github.event_name == 'push'\n    steps:\n      - run: b\n",
    );

    expect(pipeline.jobs.b?.needsPolicy).toBe("always");
    expect(pipeline.jobs.b?.when).toEqual(when.equals(context.event, "push"));
    expect(pipeline.jobs.b?.needs).toEqual(["a"]);
  });

  it("carries a run step with a setting the model has no field for as a provider step", async () => {
    const pipeline = await importText(
      "on: push\njobs:\n  a:\n    runs-on: x\n    steps:\n      - run: a\n        shell: bash\n",
    );

    expect(pipeline.jobs.a?.steps[0]).toMatchObject({
      kind: "provider",
      native: { run: "a", shell: "bash" },
    });
  });

  it("names the pointer and provider of the node it rejects", async () => {
    const error = await rejection(
      "on: push\ndefaults:\n  run:\n    shell: bash\njobs:\n  a:\n    runs-on: x\n    steps:\n      - run: a\n",
    );

    expect(error.pointer).toBe("/defaults");
    expect(error.provider).toBe("github-actions");
  });

  it("rejects a runner label computed by an expression", async () => {
    const error = await rejection(
      "on: push\njobs:\n  a:\n    runs-on: ${{ matrix.os }}\n    steps:\n      - run: a\n",
    );

    expect(error.pointer).toBe("/jobs/a/runs-on");
  });

  it("rejects a call to this tool's runner, which stands for steps held elsewhere", async () => {
    const error = await rejection(
      "on: push\njobs:\n  a:\n    runs-on: x\n    steps:\n      - run: node bin.ts run --pipeline ci/p.ts --job a --steps 0-1\n",
    );

    expect(error.pointer).toBe("/jobs/a/steps/0/run");
  });

  it("round-trips this repository's own pipeline, written in the native form", async () => {
    const { default: repository } = await import("../../../ci/ci.pipeline.ts");
    const native = pipelineSchema.parse({
      ...repository,
      form: "native",
      jobs: Object.fromEntries(
        Object.entries(repository.jobs).map(([id, job]) => [id, { ...job, form: "native" }]),
      ),
    });
    const compiler = createGitHubActionsCompiler();
    const [first] = await compiler.compile(native, { source: "ci/ci.pipeline.ts" });
    if (first === undefined) throw new Error("no file emitted");
    const imported = await createGitHubActionsImporter().import(first);
    const [second] = await compiler.compile(imported, { source: "ci/ci.pipeline.ts" });

    // The file is equal as a document. Text can differ in key order, because the repository's pipeline writes some job environments through `native`, which the compiler places after the steps and the importer reads into the model's own `env` field.
    expect(readYaml(second?.content ?? "").value).toEqual(readYaml(first.content).value);
  });

  it("keeps an expression with a brace inside a quoted string as GitHub's, not as neutral text", async () => {
    const pipeline = await importText(
      "on: push\njobs:\n  a:\n    runs-on: x\n    env:\n      TAG: \"${{ format('v{0}', github.run_number) }}\"\n    steps:\n      - run: a\n",
    );

    expect(pipeline.jobs.a?.env).toBeUndefined();
    expect(pipeline.jobs.a?.native).toEqual({
      "github-actions": { env: { TAG: "${{ format('v{0}', github.run_number) }}" } },
    });
  });

  it("rejects a branch pattern, which the model's branch names are not", async () => {
    const error = await rejection(
      "on:\n  push:\n    branches: [main, 'release/**']\njobs:\n  a:\n    runs-on: x\n    steps:\n      - run: a\n",
    );

    expect(error.pointer).toBe("/on/push/branches/1");
  });

  it("keeps a matrix whose axis name the model cannot take as GitHub's", async () => {
    const pipeline = await importText(
      "on: push\njobs:\n  a:\n    runs-on: x\n    strategy:\n      matrix:\n        node-version: ['20', '22']\n    steps:\n      - run: a\n",
    );

    expect(pipeline.jobs.a?.matrix).toBeUndefined();
    expect(pipeline.jobs.a?.native).toEqual({
      "github-actions": { strategy: { matrix: { "node-version": ["20", "22"] } } },
    });
  });

  it("rejects a job id the model cannot take, naming the id", async () => {
    const error = await rejection(
      "on: push\njobs:\n  build_and_test:\n    runs-on: x\n    steps:\n      - run: a\n",
    );

    expect(error.pointer).toBe("/jobs/build_and_test");
  });

  it("carries a command that reads a runner variable as a provider step", async () => {
    const pipeline = await importText(
      'on: push\njobs:\n  a:\n    runs-on: x\n    steps:\n      - run: echo "X=1" >> "$GITHUB_ENV"\n',
    );

    expect(pipeline.jobs.a?.steps[0]).toMatchObject({ kind: "provider" });
  });

  it("keeps a deployment environment computed by an expression as GitHub's", async () => {
    const pipeline = await importText(
      "on: push\njobs:\n  a:\n    runs-on: x\n    environment: ${{ inputs.target }}\n    steps:\n      - run: a\n",
    );

    expect(pipeline.jobs.a?.environment).toBeUndefined();
    expect(pipeline.jobs.a?.native).toEqual({
      "github-actions": { environment: "${{ inputs.target }}" },
    });
  });

  it("writes a literal expression from another provider so GitHub does not evaluate it", async () => {
    const [file] = await createGitHubActionsCompiler().compile(
      pipelineSchema.parse({
        name: "CI",
        triggers: [{ kind: "push" }],
        jobs: {
          a: {
            name: "A",
            runsOn: ["x"],
            env: { PAYLOAD: "${{secrets['TOKEN']}}", REF: "{{ refName }}" },
            steps: [{ kind: "run", run: "true" }],
          },
        },
      }),
      { source: "s" },
    );

    expect(file?.content).toContain("PAYLOAD: ${{ '${{' }}secrets['TOKEN']}}");
    expect(file?.content).toContain("REF: ${{ github.ref_name }}");

    const back = await createGitHubActionsImporter().import(file ?? { path: "", content: "" });
    expect(back.jobs.a?.env).toEqual({ PAYLOAD: "${{secrets['TOKEN']}}", REF: "{{ refName }}" });
  });

  it("keeps a job with GitHub's own settings, such as continue-on-error or a container, as GitHub's whole", async () => {
    const pipeline = await importText(
      "on: push\njobs:\n  a:\n    runs-on: x\n    continue-on-error: true\n    container: node:22\n    steps:\n      - run: ./deploy\n",
    );

    expect(pipeline.jobs.a?.steps[0]).toEqual({
      kind: "provider",
      provider: "github-actions",
      native: { run: "./deploy" },
    });
  });
});
