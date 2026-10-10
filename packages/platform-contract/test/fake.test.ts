import { describe, expect, it } from "vitest";

import {
  WaitExhaustedError,
  createFakePlatform,
  createFakeState,
  describeReaderConformance,
  waitForChecks,
  type Clock,
} from "../src/index.ts";

describeReaderConformance({ describe, it }, (state) => createFakePlatform(state).reader);

function clock(onSleep: () => void): Clock {
  return {
    sleep() {
      onSleep();
      return Promise.resolve();
    },
  };
}

describe("waitForChecks", () => {
  it("returns once every required check has completed", async () => {
    const state = createFakeState();
    state.checks.set("sha", [{ name: "Lint", status: "running", url: "" }]);
    const { reader } = createFakePlatform(state);
    let sleeps = 0;
    const result = await waitForChecks(
      reader,
      clock(() => {
        sleeps += 1;
        state.checks.set("sha", [
          { name: "Lint", status: "completed", conclusion: "success", url: "" },
        ]);
      }),
      { sha: "sha", required: ["Lint"], pollIntervalMs: 1, maxPolls: 3 },
    );
    expect(sleeps).toBe(1);
    expect(result[0]?.status).toBe("completed");
  });

  it("treats a required check that is not yet reported as pending", async () => {
    const { reader } = createFakePlatform(createFakeState());
    await expect(
      waitForChecks(reader, clock(() => undefined), {
        sha: "sha",
        required: ["Lint"],
        pollIntervalMs: 1,
        maxPolls: 2,
      }),
    ).rejects.toBeInstanceOf(WaitExhaustedError);
  });

  it("does not return on an empty listing when nothing is named", async () => {
    const { reader } = createFakePlatform(createFakeState());
    await expect(
      waitForChecks(reader, clock(() => undefined), {
        sha: "sha",
        pollIntervalMs: 1,
        maxPolls: 2,
      }),
    ).rejects.toBeInstanceOf(WaitExhaustedError);
  });
});
