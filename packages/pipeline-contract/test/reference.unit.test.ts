import { describe, expect, expectTypeOf, it } from "vitest";

import {
  context,
  defineJob,
  definePipeline,
  jobsOf,
  matrixJob,
  t,
  when,
  type EventKind,
  type JobDefinition,
  type JobHandle,
  type MatrixAxes,
  type Ref,
} from "../src/index.ts";

const RUNS_ON = ["ubuntu-latest"];

describe("typed references", () => {
  it("serialise to the token the model stores", () => {
    const pipeline = definePipeline({
      name: "CI",
      triggers: [{ kind: "push" }],
      concurrency: {
        group: t`ci-${context.workflow}-${context.refName}`,
        cancelInProgress: true,
      },
      jobs: jobsOf(
        defineJob(
          "test",
          matrixJob({ node: ["22", "24"] }, (axes) => ({
            name: "Test",
            runsOn: RUNS_ON,
            env: { NODE_VERSION: axes.node, COMMIT: context.sha },
            steps: [{ kind: "run", run: "pnpm test" }],
          })),
        ),
      ),
    });

    expect(pipeline.concurrency?.group).toBe("ci-{{ workflow }}-{{ refName }}");
    expect(pipeline.jobs.test?.env).toEqual({
      NODE_VERSION: "{{ matrix.node }}",
      COMMIT: "{{ sha }}",
    });
    expect(pipeline.jobs.test?.matrix).toEqual({ node: ["22", "24"] });
  });

  it("expose only the names that exist", () => {
    // Type-level assertions: a misspelt name would be a compile error, so these hold only if it is.
    expectTypeOf<MatrixAxes<{ readonly node: readonly ["22"] }>>().toEqualTypeOf<{
      readonly node: Ref;
    }>();
    expectTypeOf(context).not.toHaveProperty("shaa");
    expectTypeOf(context).toHaveProperty("sha");
  });
});

describe("typed job handles", () => {
  const lint = defineJob("lint", {
    name: "Lint",
    runsOn: RUNS_ON,
    steps: [{ kind: "run", run: "pnpm run lint" }],
  });

  it("turn needs into the ids the model stores", () => {
    const test = defineJob("test", {
      name: "Test",
      runsOn: RUNS_ON,
      needs: [lint],
      steps: [{ kind: "run", run: "pnpm test" }],
    });
    const pipeline = definePipeline({
      name: "CI",
      triggers: [{ kind: "push" }],
      jobs: jobsOf(lint, test),
    });

    expect(pipeline.jobs.test?.needs).toEqual(["lint"]);
  });

  it("accept a need only as a job handle", () => {
    expectTypeOf<JobDefinition["needs"]>().toEqualTypeOf<readonly JobHandle[] | undefined>();
  });

  it("refuse two jobs with one id", () => {
    expect(() => jobsOf(lint, lint)).toThrow("job lint is defined twice");
  });
});

describe("condition builders", () => {
  it("produce the predicate tree the model validates", () => {
    const pipeline = definePipeline({
      name: "CI",
      triggers: [{ kind: "push" }],
      jobs: jobsOf(
        defineJob("release", {
          name: "Release",
          runsOn: RUNS_ON,
          when: when.allOf(when.event("push"), when.oneOf(context.refName, ["main", "release"])),
          steps: [{ kind: "run", run: "pnpm release" }],
        }),
      ),
    });

    expect(pipeline.jobs.release?.when).toMatchObject({ kind: "allOf" });
  });

  it("limit event names to the model's events", () => {
    expectTypeOf<Parameters<typeof when.event>>().toEqualTypeOf<[EventKind, ...EventKind[]]>();
  });
});
