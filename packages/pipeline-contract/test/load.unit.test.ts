import { describe, expect, it } from "vitest";

import { PipelineLoadError, loadPipeline, type FileReader } from "../src/index.ts";

const SCHEMA = "../schemas/pipeline.schema.json";
const INHERITED_TIMEOUT = 5;
const SUPPLIED_MINUTES = 7;

function memory(files: Record<string, unknown>): FileReader {
  return {
    async read(path) {
      const content = files[path];
      if (content === undefined) return Promise.reject(new Error(`no such file ${path}`));

      return Promise.resolve(typeof content === "string" ? content : JSON.stringify(content));
    },
  };
}

const lintJob = {
  name: "Lint",
  runsOn: ["ubuntu-latest"],
  steps: [{ kind: "run", run: "lint" }],
};

async function failure(promise: Readonly<Promise<unknown>>): Promise<PipelineLoadError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof PipelineLoadError) return error;
    throw error;
  }
  throw new Error("the load succeeded");
}

describe("loadPipeline composition", () => {
  const base = {
    $schema: SCHEMA,
    name: "CI",
    triggers: [{ kind: "push" }],
    env: { A: "base", B: "base" },
    jobs: { lint: lintJob },
  };

  it("deep-merges objects with the extending file winning", async () => {
    const { pipeline } = await loadPipeline(
      "ci/main.pipeline.json",
      memory({
        "ci/main.pipeline.json": {
          $schema: SCHEMA,
          extends: "./base.pipeline.json",
          env: { B: "child", C: "child" },
          jobs: { lint: { timeoutMinutes: INHERITED_TIMEOUT } },
        },
        "ci/base.pipeline.json": base,
      }),
    );
    expect(pipeline.env).toEqual({ A: "base", B: "child", C: "child" });
    expect(pipeline.jobs.lint?.timeoutMinutes).toBe(INHERITED_TIMEOUT);
    expect(pipeline.jobs.lint?.name).toBe("Lint");
  });

  it("concatenates steps and replaces other arrays", async () => {
    const { pipeline } = await loadPipeline(
      "ci/main.pipeline.json",
      memory({
        "ci/main.pipeline.json": {
          $schema: SCHEMA,
          extends: "./base.pipeline.json",
          triggers: [{ kind: "manual" }],
          jobs: { lint: { steps: [{ kind: "run", run: "extra" }] } },
        },
        "ci/base.pipeline.json": base,
      }),
    );
    expect(pipeline.triggers).toEqual([{ kind: "manual" }]);
    expect(
      pipeline.jobs.lint?.steps.map((step) => (step.kind === "run" ? step.run : step.kind)),
    ).toEqual(["lint", "extra"]);
  });

  it("replaces an inherited value outright with a $replace wrapper", async () => {
    const { pipeline } = await loadPipeline(
      "ci/main.pipeline.json",
      memory({
        "ci/main.pipeline.json": {
          $schema: SCHEMA,
          extends: "./base.pipeline.json",
          jobs: { lint: { steps: { $replace: [{ kind: "run", run: "only" }] } } },
        },
        "ci/base.pipeline.json": base,
      }),
    );
    expect(pipeline.jobs.lint?.steps).toEqual([{ kind: "run", run: "only" }]);
  });

  it("substitutes typed parameters supplied by the extending file, else defaults", async () => {
    const fragment = {
      $schema: SCHEMA,
      parameters: {
        runner: { type: "string", default: "ubuntu-latest" },
        minutes: { type: "number" },
      },
      jobs: {
        lint: {
          ...lintJob,
          runsOn: [{ $param: "runner" }],
          timeoutMinutes: { $param: "minutes" },
        },
      },
    };
    const { pipeline } = await loadPipeline(
      "ci/main.pipeline.json",
      memory({
        "ci/main.pipeline.json": {
          $schema: SCHEMA,
          name: "CI",
          triggers: [{ kind: "push" }],
          extends: { path: "./fragment.pipeline.json", with: { minutes: SUPPLIED_MINUTES } },
        },
        "ci/fragment.pipeline.json": fragment,
      }),
    );
    expect(pipeline.jobs.lint?.runsOn).toEqual(["ubuntu-latest"]);
    expect(pipeline.jobs.lint?.timeoutMinutes).toBe(SUPPLIED_MINUTES);
  });

  it("reports a parameter with no value at the declaring file", async () => {
    const error = await failure(
      loadPipeline(
        "ci/main.pipeline.json",
        memory({
          "ci/main.pipeline.json": {
            $schema: SCHEMA,
            extends: "./fragment.pipeline.json",
          },
          "ci/fragment.pipeline.json": {
            $schema: SCHEMA,
            parameters: { minutes: { type: "number" } },
          },
        }),
      ),
    );
    expect(error.issues[0]).toMatchObject({
      file: "ci/fragment.pipeline.json",
      pointer: "/parameters/minutes",
    });
  });

  it("rejects a parameter of the wrong type", async () => {
    const error = await failure(
      loadPipeline(
        "ci/main.pipeline.json",
        memory({
          "ci/main.pipeline.json": {
            $schema: SCHEMA,
            extends: { path: "./fragment.pipeline.json", with: { minutes: "seven" } },
          },
          "ci/fragment.pipeline.json": {
            $schema: SCHEMA,
            parameters: { minutes: { type: "number" } },
          },
        }),
      ),
    );
    expect(error.message).toContain("must be a number");
  });
});

describe("loadPipeline errors", () => {
  it("names the fragment file and pointer for a violation that came through extends", async () => {
    const error = await failure(
      loadPipeline(
        "ci/main.pipeline.json",
        memory({
          "ci/main.pipeline.json": {
            $schema: SCHEMA,
            extends: "./base.pipeline.json",
            name: "CI",
          },
          "ci/base.pipeline.json": {
            $schema: SCHEMA,
            triggers: [{ kind: "push" }],
            jobs: { lint: { ...lintJob, timeoutMinutes: -1 } },
          },
        }),
      ),
    );
    expect(error.issues[0]).toMatchObject({
      file: "ci/base.pipeline.json",
      pointer: "/jobs/lint/timeoutMinutes",
    });
  });

  it("locates an unknown key at the key itself", async () => {
    const error = await failure(
      loadPipeline(
        "ci/main.pipeline.json",
        memory({
          "ci/main.pipeline.json": {
            $schema: SCHEMA,
            name: "CI",
            triggers: [{ kind: "push" }],
            jobs: { lint: { ...lintJob, timeout: 5 } },
          },
        }),
      ),
    );
    expect(error.issues[0]).toMatchObject({
      file: "ci/main.pipeline.json",
      pointer: "/jobs/lint/timeout",
    });
  });

  it("reports an extends cycle with the chain", async () => {
    const error = await failure(
      loadPipeline(
        "a.pipeline.json",
        memory({
          "a.pipeline.json": { $schema: SCHEMA, extends: "./b.pipeline.json" },
          "b.pipeline.json": { $schema: SCHEMA, extends: "./a.pipeline.json" },
        }),
      ),
    );
    expect(error.message).toContain("a.pipeline.json -> b.pipeline.json -> a.pipeline.json");
  });

  it("reports an unreadable extends target from the extending file", async () => {
    const error = await failure(
      loadPipeline(
        "main.pipeline.json",
        memory({ "main.pipeline.json": { $schema: SCHEMA, extends: "./missing.pipeline.json" } }),
      ),
    );
    expect(error.issues[0]).toMatchObject({ file: "main.pipeline.json", pointer: "/extends" });
  });

  it("requires every document to declare $schema", async () => {
    const error = await failure(
      loadPipeline("main.pipeline.json", memory({ "main.pipeline.json": { name: "CI" } })),
    );
    expect(error.issues[0]).toMatchObject({ pointer: "/$schema" });
  });

  it("reports malformed JSON with the file", async () => {
    const error = await failure(
      loadPipeline("main.pipeline.json", memory({ "main.pipeline.json": "{ not json" })),
    );
    expect(error.issues[0]?.file).toBe("main.pipeline.json");
    expect(error.issues[0]?.message).toContain("invalid JSON");
  });

  it("rejects a job that needs one that does not exist, at the needs entry", async () => {
    const error = await failure(
      loadPipeline(
        "main.pipeline.json",
        memory({
          "main.pipeline.json": {
            $schema: SCHEMA,
            name: "CI",
            triggers: [{ kind: "push" }],
            jobs: { lint: { ...lintJob, needs: ["ghost"] } },
          },
        }),
      ),
    );
    expect(error.issues[0]).toMatchObject({ pointer: "/jobs/lint/needs/0" });
  });

  it("rejects a needs cycle", async () => {
    const error = await failure(
      loadPipeline(
        "main.pipeline.json",
        memory({
          "main.pipeline.json": {
            $schema: SCHEMA,
            name: "CI",
            triggers: [{ kind: "push" }],
            jobs: {
              a: { ...lintJob, needs: ["b"] },
              b: { ...lintJob, needs: ["a"] },
            },
          },
        }),
      ),
    );
    expect(error.message).toContain("needs form a cycle");
  });

  it("rejects a condition that references a matrix axis the job lacks", async () => {
    const error = await failure(
      loadPipeline(
        "main.pipeline.json",
        memory({
          "main.pipeline.json": {
            $schema: SCHEMA,
            name: "CI",
            triggers: [{ kind: "push" }],
            jobs: {
              lint: {
                ...lintJob,
                when: {
                  kind: "textCompare",
                  op: "equals",
                  left: { kind: "reference", key: "matrix.node" },
                  right: { kind: "textLiteral", value: "22" },
                },
              },
            },
          },
        }),
      ),
    );
    expect(error.issues[0]).toMatchObject({ pointer: "/jobs/lint/when" });
  });

  it("rejects a template token outside the vocabulary", async () => {
    const error = await failure(
      loadPipeline(
        "main.pipeline.json",
        memory({
          "main.pipeline.json": {
            $schema: SCHEMA,
            name: "CI",
            triggers: [{ kind: "push" }],
            env: { X: "{{ hostname }}" },
            jobs: { lint: lintJob },
          },
        }),
      ),
    );
    expect(error.issues[0]).toMatchObject({ pointer: "/env/X" });
  });

  it("expects job ids to be human-assigned lower-case identifiers", async () => {
    const error = await failure(
      loadPipeline(
        "main.pipeline.json",
        memory({
          "main.pipeline.json": {
            $schema: SCHEMA,
            name: "CI",
            triggers: [{ kind: "push" }],
            jobs: { "Not A Valid Id": lintJob },
          },
        }),
      ),
    );
    expect(error.issues.length).toBeGreaterThan(0);
  });
});
