import { describe, expect, it } from "vitest";

import { renderYaml } from "../src/index.ts";

describe("renderYaml", () => {
  it("keeps insertion order, never folds and puts the header first", () => {
    const text = renderYaml({ z: 1, a: { longer: "x".repeat(200) } }, new Map(), [
      "Generated.",
    ]);
    expect(text.startsWith("# Generated.\n")).toBe(true);
    expect(text.indexOf("z:")).toBeLessThan(text.indexOf("a:"));
    expect(text).toContain("x".repeat(200));
  });

  it("attaches a comment before a mapping key and before a sequence item", () => {
    const text = renderYaml(
      { jobs: { lint: { steps: [{ run: "a" }, { run: "b" }] } } },
      new Map([
        ["jobs/lint", "Why lint exists."],
        ["jobs/lint/steps/1", "The second step."],
      ]),
      ["h"],
    );
    expect(text).toContain("# Why lint exists.\n  lint:");
    expect(text).toContain("# The second step.\n      - run: b");
  });

  it("throws for a comment path that matches nothing", () => {
    expect(() => renderYaml({ a: 1 }, new Map([["b", "x"]]), ["h"])).toThrow(
      "no node at b",
    );
  });
});
