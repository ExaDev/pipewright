import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

import {
  pipelineAuthoringJsonSchema,
  pipelineJsonSchema,
  pipelineSchema,
  samplePipeline,
} from "../src/index.ts";

function validator(schema: object): (value: unknown) => boolean {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  const validate = ajv.compile(schema);

  return (value) => validate(value);
}

type Document = Record<string, unknown>;

function sample(): Document {
  return structuredClone(samplePipeline());
}

function jobsOf(document: Document): Record<string, Document> {
  const jobs = document.jobs;
  if (typeof jobs !== "object" || jobs === null) throw new Error("the sample has no jobs");

  return Object.fromEntries(Object.entries(jobs));
}

function withJobs(document: Document, jobs: Record<string, unknown>): Document {
  return { ...document, jobs };
}

describe("derived JSON Schema agrees with the Zod schema", () => {
  const resolved = validator(pipelineJsonSchema());

  const structuralCases: [string, (document: Document) => Document, boolean][] = [
    ["the sample pipeline", (document) => document, true],
    ["an unknown top-level key", (document) => ({ ...document, extra: 1 }), false],
    ["no triggers", (document) => ({ ...document, triggers: [] }), false],
    [
      "a missing name",
      (document) => Object.fromEntries(Object.entries(document).filter(([key]) => key !== "name")),
      false,
    ],
    [
      "a trigger of an unknown kind",
      (document) => ({ ...document, triggers: [{ kind: "tag" }] }),
      false,
    ],
    [
      "a job id that is not lower-case",
      (document) => withJobs(document, { Bad: jobsOf(document).lint }),
      false,
    ],
    [
      "a step of an unknown kind",
      (document) =>
        withJobs(document, {
          ...jobsOf(document),
          lint: { ...jobsOf(document).lint, steps: [{ kind: "teleport" }] },
        }),
      false,
    ],
  ];

  for (const [label, mutate, valid] of structuralCases) {
    it(`agrees for ${label}`, () => {
      const value = mutate(sample());
      expect(pipelineSchema.safeParse(value).success).toBe(valid);
      expect(resolved(value)).toBe(valid);
    });
  }

  it("is looser than Zod only for the cross-field rules a JSON Schema cannot state", () => {
    const document = sample();
    const value = withJobs(document, {
      ...jobsOf(document),
      test: { ...jobsOf(document).test, needs: ["ghost"] },
    });
    expect(pipelineSchema.safeParse(value).success).toBe(false);
    expect(resolved(value)).toBe(true);
  });
});

describe("authoring JSON Schema", () => {
  const authoring = validator(pipelineAuthoringJsonSchema());

  it("accepts a fragment with no required fields", () => {
    expect(
      authoring({
        $schema: "https://unpkg.com/@pipewright/pipeline-contract/dist/pipeline.schema.json",
        env: { A: "b" },
      }),
    ).toBe(true);
  });

  it("accepts extends, parameters and a parameter reference in a scalar position", () => {
    expect(
      authoring({
        $schema: "x",
        extends: [{ path: "./base.pipeline.json", with: { runner: "ubuntu-latest" } }],
        parameters: { runner: { type: "string", default: "ubuntu-latest" } },
        jobs: { lint: { runsOn: [{ $param: "runner" }], timeoutMinutes: { $param: "minutes" } } },
      }),
    ).toBe(true);
  });

  it("still rejects an unknown key and a wrongly typed value", () => {
    expect(authoring({ $schema: "x", extra: 1 })).toBe(false);
    expect(authoring({ $schema: "x", jobs: { lint: { timeoutMinutes: "ten" } } })).toBe(false);
  });
});
