import type { CiPlatformReader } from "./contract.ts";
import type { FakeState } from "./fake.ts";

/**
 * The test-framework surface the kit needs.
 */
export interface TestApi {
  readonly describe: (name: string, body: () => void) => void;
  readonly it: (name: string, body: () => Promise<void>) => void;
}

/**
 * Builds a reader over the given seeded state. The reference fake reads it directly; a real adapter's test serves it through a recorded or simulated provider API, which is how one spec holds both.
 */
export type ReaderFactory = (state: FakeState) => CiPlatformReader;

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function seeded(): FakeState {
  return {
    runs: [
      {
        id: "11",
        name: "CI",
        status: "completed",
        conclusion: "success",
        ref: "main",
        sha: "aaa",
        event: "push",
        url: "https://example.com/runs/11",
        createdAt: "2026-01-01T00:00:00Z",
      },
      {
        id: "12",
        name: "CI",
        status: "running",
        ref: "feature",
        sha: "bbb",
        event: "pullRequest",
        url: "https://example.com/runs/12",
        createdAt: "2026-01-02T00:00:00Z",
      },
    ],
    checks: new Map([
      [
        "aaa",
        [
          {
            name: "Lint",
            status: "completed",
            conclusion: "failure",
            url: "https://example.com/checks/1",
          },
          { name: "Test", status: "running", url: "https://example.com/checks/2" },
        ],
      ],
    ]),
    logs: new Map([["11", "line one\nline two"]]),
    required: new Map([["main", ["Lint", "Test"]]]),
    dispatched: [],
    rerun: [],
    cancelled: [],
  };
}

/**
 * Registers the behavioural spec every `CiPlatformReader` must meet. Cases for an optional capability run only when the adapter declares it.
 */
export function describeReaderConformance(api: TestApi, makeReader: ReaderFactory): void {
  api.describe("CiPlatformReader conformance", () => {
    api.it("lists every run when unfiltered", async () => {
      const runs = await makeReader(seeded()).listRuns({});
      check(runs.length === 2, `listed ${runs.length} runs`);
    });

    api.it("filters runs by ref, sha and event", async () => {
      const reader = makeReader(seeded());
      const byRef = await reader.listRuns({ ref: "main" });
      check(byRef.length === 1 && byRef[0]?.id === "11", "ref filter failed");
      const bySha = await reader.listRuns({ sha: "bbb" });
      check(bySha.length === 1 && bySha[0]?.id === "12", "sha filter failed");
      const byEvent = await reader.listRuns({ event: "pullRequest" });
      check(byEvent.length === 1 && byEvent[0]?.id === "12", "event filter failed");
    });

    api.it("never reports a conclusion for an unfinished run", async () => {
      const run = await makeReader(seeded()).getRun("12");
      check(run.status === "running", `status was ${run.status}`);
      check(!("conclusion" in run), "an unfinished run carried a conclusion");
    });

    api.it("reports a finished run's conclusion", async () => {
      const run = await makeReader(seeded()).getRun("11");
      check(
        run.status === "completed" && run.conclusion === "success",
        "a finished run lost its conclusion",
      );
    });

    api.it("lists the checks of a commit", async () => {
      const checks = await makeReader(seeded()).listChecks("aaa");
      const names = checks.map((entry) => entry.name).sort();
      check(names.join(",") === "Lint,Test", `checks were ${names.join(",")}`);
    });

    api.it("returns logs when the capability is declared", async () => {
      const reader = makeReader(seeded());
      if (!reader.capabilities.logs) return;
      const logs = await reader.getLogs("11");
      check(logs.includes("line one") && logs.includes("line two"), "logs were incomplete");
    });

    api.it("returns required checks when the capability is declared", async () => {
      const reader = makeReader(seeded());
      if (!reader.capabilities.requiredChecks) return;
      const names = [...(await reader.requiredChecks("main"))].sort();
      check(names.join(",") === "Lint,Test", `required checks were ${names.join(",")}`);
    });
  });
}
