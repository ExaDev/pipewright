import { describe, expect, it } from "vitest";

import { JOB_ID_PATTERN, uniqueJobIds } from "../src/index.ts";

describe("uniqueJobIds", () => {
  it("slugs each name and suffixes a repeat", () => {
    expect(uniqueJobIds(["Lint", "Test (22)", "Test (22)", "lint"])).toEqual([
      "lint",
      "test-22",
      "test-22-2",
      "lint-2",
    ]);
  });

  it("starts every id with a letter and never leaves one empty", () => {
    const ids = uniqueJobIds(["22 tests", "---", "###"]);

    expect(ids).toEqual(["job-22-tests", "job", "job-2"]);
    for (const id of ids) expect(id).toMatch(JOB_ID_PATTERN);
  });
});
