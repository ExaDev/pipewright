import { dag } from "process-graph";
import { describe, expect, it } from "vitest";

import { DependencyGraphError, jobGraphOf, type Pipeline } from "../src/index.ts";

function jobsWithNeeds(needs: Record<string, string[]>): Pipeline["jobs"] {
  return Object.fromEntries(
    Object.entries(needs).map(([id, ids]) => [
      id,
      { name: id, runsOn: ["ubuntu-latest"], needs: ids, steps: [{ kind: "run", run: "true" }] },
    ]),
  );
}

function failureOf(jobs: Pipeline["jobs"]): DependencyGraphError {
  try {
    jobGraphOf(jobs);
  } catch (error) {
    if (error instanceof DependencyGraphError) return error;
    throw error;
  }
  throw new Error("the graph was accepted");
}

describe("jobGraphOf", () => {
  it("levels each job by the longest needs chain below it", () => {
    const { levels } = dag.topologicalLayers(
      jobGraphOf(
        jobsWithNeeds({
          build: [],
          lint: [],
          test: ["build"],
          package: ["test"],
          release: ["package", "lint"],
        }),
      ),
    );

    expect(Object.fromEntries(levels)).toEqual({
      build: 0,
      lint: 0,
      test: 1,
      package: 2,
      release: 3,
    });
  });

  it("reports a needs target that is not a job with the job that names it", () => {
    const error = failureOf(jobsWithNeeds({ build: [], test: ["build", "bild"] }));

    expect(error.unknownNeeds).toEqual([{ job: "test", missing: "bild" }]);
    expect(error.cycles).toEqual([]);
    expect(error.message).toBe('job "test" needs unknown job "bild"');
  });

  it("reports a cycle as a closed path", () => {
    const error = failureOf(jobsWithNeeds({ a: ["c"], b: ["a"], c: ["b"], d: [] }));

    expect(error.unknownNeeds).toEqual([]);
    expect(error.cycles).toEqual([["a", "c", "b", "a"]]);
    expect(error.message).toBe("needs form a cycle: a -> c -> b -> a");
  });

  it("reports a job that needs itself", () => {
    expect(failureOf(jobsWithNeeds({ a: ["a"] })).cycles).toEqual([["a", "a"]]);
  });

  it("reports unknown targets and cycles together", () => {
    const error = failureOf(jobsWithNeeds({ a: ["b", "ghost"], b: ["a"] }));

    expect(error.unknownNeeds).toEqual([{ job: "a", missing: "ghost" }]);
    expect(error.cycles).toEqual([["a", "b", "a"]]);
  });
});
