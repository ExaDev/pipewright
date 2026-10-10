import { describe, expect, it } from "vitest";

import { commentPath, readYaml, renderYaml } from "../src/index.ts";

const HEADER = ["Generated from x.", "Regenerate it."];

describe("readYaml", () => {
  it("returns the plain value", () => {
    expect(readYaml("a: 1\nb:\n  - x\n  - y\n").value).toEqual({ a: 1, b: ["x", "y"] });
  });

  it("expands a merge key, as GitLab files use to share job settings", () => {
    const text = "base: &base\n  tags: [a]\njob:\n  <<: *base\n  script: [x]\n";

    expect(readYaml(text).value).toMatchObject({ job: { tags: ["a"], script: ["x"] } });
  });

  it("throws on a syntax error", () => {
    expect(() => readYaml("a: [1, 2\n")).toThrow();
  });

  it("reads back every comment renderYaml wrote, whichever node it precedes", () => {
    const comments = new Map([
      ["name", "The pipeline."],
      ["on/push", "First key of a nested mapping."],
      ["on/workflow_dispatch", "A later key."],
      ["jobs/lint", "First job."],
      ["jobs/lint/steps/0", "First step."],
      ["jobs/lint/steps/1", "Second step."],
      ["jobs/test", "Two\nlines."],
    ]);
    const text = renderYaml(
      {
        name: "CI",
        on: { push: { branches: ["main"] }, workflow_dispatch: {} },
        jobs: { lint: { steps: [{ run: "a" }, { run: "b" }] }, test: { name: "T" } },
      },
      comments,
      HEADER,
    );

    expect(readYaml(text).comments).toEqual(comments);
  });

  it("keeps every paragraph of a comment on a key after the first", () => {
    const comments = new Map([
      ["first", "One."],
      ["second", "Para one.\n\nPara two."],
    ]);
    const text = renderYaml({ first: 1, second: 2 }, comments, HEADER);

    expect(readYaml(text).comments).toEqual(comments);
  });

  it("does not read the generated header as a comment on the first key", () => {
    const text = renderYaml({ name: "CI", jobs: {} }, new Map(), HEADER);

    expect(readYaml(text).comments.size).toBe(0);
  });

  it("keeps a key that contains a slash as one path segment", () => {
    const comments = new Map([[commentPath("branches", "feature/foo"), "A branch."]]);
    const text = renderYaml({ branches: { "feature/foo": {} } }, comments, HEADER);

    expect(readYaml(text).comments).toEqual(comments);
  });
});
