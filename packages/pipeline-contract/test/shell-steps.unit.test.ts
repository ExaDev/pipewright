import { describe, expect, it } from "vitest";

import { joinShellSteps, splitShellEntry } from "../src/shell-steps.ts";

describe("shell steps", () => {
  it("leaves a single one-line step as it is", () => {
    expect(joinShellSteps(["npm test"])).toBe("npm test");
    expect(splitShellEntry("npm test")).toEqual(["npm test"]);
  });

  it("joins several steps with a status check between them and reads them back", () => {
    const steps = ["cd web", "false && true", "npm publish"];
    const entry = joinShellSteps(steps);

    expect(entry.startsWith("set -e\n")).toBe(true);
    expect(
      entry.split("\n").filter((line) => line.startsWith("__pipewright_status=")),
    ).toHaveLength(2);
    expect(splitShellEntry(entry)).toEqual(steps);
  });

  it("states the rule for one step of several lines, which reads back unchanged", () => {
    const step = "cd web\nnpm test";

    expect(joinShellSteps([step])).toBe(`set -e\n${step}`);
    expect(splitShellEntry(joinShellSteps([step]))).toEqual([step]);
  });

  it("treats an entry written elsewhere as one step", () => {
    expect(splitShellEntry("cd web\nnpm test")).toEqual(["cd web\nnpm test"]);
  });

  it("makes a failed step end the entry with its status before the next step runs", async () => {
    const { spawnSync } = await import("node:child_process");
    const entry = joinShellSteps(["false && true", "echo deployed"]);
    const result = spawnSync("sh", ["-e", "-c", entry], { encoding: "utf8" });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
  });
});
