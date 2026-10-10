import { deriveStatuses, type Facts } from "@exadev/process-graph-domain";
import { describe, expect, it } from "vitest";

import { samplePipeline } from "@ci-adapters/pipeline-contract";
import type { Check } from "@ci-adapters/platform-contract";

import { overlayOf, toModel, type JobState } from "../src/index.ts";

const noFacts: Facts = () => ({ found: false });

function completed(
  name: string,
  conclusion: Extract<Check, { status: "completed" }>["conclusion"],
): JobState {
  return { kind: "reported", check: { status: "completed", conclusion, name } };
}

describe("overlayOf", () => {
  it.each([
    ["queued", { status: "queued", name: "Job" }, "open"],
    ["running", { status: "running", name: "Job" }, "open"],
    ["waiting", { status: "waiting", name: "Job" }, "open"],
    ["success", { status: "completed", conclusion: "success", name: "Job" }, "done"],
    ["neutral", { status: "completed", conclusion: "neutral", name: "Job" }, "done"],
    ["skipped", { status: "completed", conclusion: "skipped", name: "Job" }, "done"],
    ["failure", { status: "completed", conclusion: "failure", name: "Job" }, "open"],
    ["timedOut", { status: "completed", conclusion: "timedOut", name: "Job" }, "open"],
    ["cancelled", { status: "completed", conclusion: "cancelled", name: "Job" }, "open"],
    ["actionRequired", { status: "completed", conclusion: "actionRequired", name: "Job" }, "open"],
    ["stale", { status: "completed", conclusion: "stale", name: "Job" }, "unknown"],
  ] satisfies [string, Check, string][])("maps a %s check to %s", (_label, check, status) => {
    expect(overlayOf({ job: { kind: "reported", check } })).toEqual({ job: status });
  });

  it("maps an unresolved job to unknown and leaves a job without data out", () => {
    expect(overlayOf({ lint: { kind: "unresolved" } })).toEqual({ lint: "unknown" });
    expect(overlayOf({})).toEqual({});
  });

  it("finishes the model for a successful run", () => {
    const model = toModel(samplePipeline());
    const overlay = overlayOf({
      lint: completed("Lint", "success"),
      test: completed("Test", "success"),
      gate: completed("Required checks", "success"),
    });

    const statuses = deriveStatuses(model, overlay, noFacts);

    expect(Object.fromEntries(statuses)).toEqual({
      "pipeline:initial": "done",
      "pipeline:final": "done",
      lint: "done",
      "test:fork": "done",
      test: "done",
      "test:join": "done",
      gate: "done",
    });
  });

  it("leaves what needs a failed job blocked", () => {
    const model = toModel(samplePipeline());
    const overlay = overlayOf({
      lint: completed("Lint", "success"),
      test: completed("Test", "failure"),
      gate: { kind: "reported", check: { status: "queued", name: "Required checks" } },
    });

    const statuses = deriveStatuses(model, overlay, noFacts);

    expect(statuses.get("lint")).toBe("done");
    expect(statuses.get("test")).toBe("ready");
    expect(statuses.get("gate")).toBe("blocked");
  });
});
