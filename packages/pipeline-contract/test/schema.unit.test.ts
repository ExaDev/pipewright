import { describe, expect, it } from "vitest";

import { pipelineSchema } from "../src/index.ts";

const pipeline = (runsOn: readonly string[]): unknown => ({
  name: "CI",
  triggers: [{ kind: "push" }],
  jobs: { a: { name: "A", runsOn, steps: [{ kind: "run", run: "true" }] } },
});

describe("pipelineSchema", () => {
  it("accepts a job that names no runner label, meaning the provider's own runner", () => {
    expect(pipelineSchema.safeParse(pipeline([])).success).toBe(true);
  });

  it("rejects a runner label that is empty text", () => {
    expect(pipelineSchema.safeParse(pipeline([""])).success).toBe(false);
  });
});
