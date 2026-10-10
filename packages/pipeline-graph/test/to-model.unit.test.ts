import {
  criticalPath as remainingPath,
  dag,
  deriveStatuses,
  toSwimlane,
  validate,
  type Facts,
} from "process-graph";
import { describe, expect, it } from "vitest";

import {
  context,
  jobGraphOf,
  pipelineSchema,
  samplePipeline,
  when,
  type Pipeline,
} from "@ci-adapters/pipeline-contract";

import {
  FINAL_ID,
  INITIAL_ID,
  decisionIdOf,
  forkIdOf,
  joinIdOf,
  runnerIdOf,
  toModel,
} from "../src/index.ts";
import { longestChains, repositoryPipeline } from "./support.ts";

const step = { kind: "run", run: "true" } as const;

const noFacts: Facts = () => ({ found: false });

/** Facts that answer only the context's event key. */
function eventIs(event: string): Facts {
  return (key) =>
    key === context.event.key
      ? { found: true, value: { kind: "text", value: event } }
      : { found: false };
}

function transitionIds(pipeline: Pipeline): string[] {
  return toModel(pipeline).transitions.map((transition) => transition.id);
}

describe("toModel", () => {
  it("produces a model that passes the schema's own validation", async () => {
    expect(validate(toModel(samplePipeline()))).toEqual([]);
    expect(validate(toModel(await repositoryPipeline()))).toEqual([]);
  });

  it("maps every job to an activity named by its job id and labelled by its name", () => {
    const activities = toModel(samplePipeline()).elements.filter(
      (element) => element.kind === "activity",
    );

    expect(activities.map((element) => [element.id, element.label])).toEqual([
      ["lint", "Lint"],
      ["test", "Test"],
      ["gate", "Required checks"],
    ]);
  });

  it("bounds the graph with an initial and a final pseudo-state", () => {
    const model = toModel(samplePipeline());

    expect(model.elements.filter((element) => element.kind === "pseudo")).toContainEqual({
      kind: "pseudo",
      id: INITIAL_ID,
      role: "initial",
    });
    expect(model.elements).toContainEqual({ kind: "pseudo", id: FINAL_ID, role: "final" });
    expect(model.transitions.filter((t) => t.source === INITIAL_ID).map((t) => t.target)).toEqual([
      "lint",
    ]);
    expect(model.transitions.filter((t) => t.target === FINAL_ID).map((t) => t.source)).toEqual([
      "gate",
    ]);
  });

  it("turns each needs entry into a transition and a matrix job into a fork and a join", () => {
    const model = toModel(samplePipeline());

    expect(transitionIds(samplePipeline())).toEqual([
      `${INITIAL_ID}->lint`,
      `lint->${forkIdOf("test")}`,
      `${forkIdOf("test")}->test`,
      `test->${joinIdOf("test")}`,
      "lint->gate",
      `${joinIdOf("test")}->gate`,
      `gate->${FINAL_ID}`,
    ]);
    expect(
      model.elements.filter((element) => element.kind === "pseudo").map((e) => [e.id, e.role]),
    ).toEqual([
      [INITIAL_ID, "initial"],
      [FINAL_ID, "final"],
      [forkIdOf("test"), "fork"],
      [joinIdOf("test"), "join"],
    ]);
  });

  it("gives each distinct runner label list a system participant and a lane", () => {
    const pipeline = pipelineSchema.parse({
      name: "CI",
      triggers: [{ kind: "push" }],
      jobs: {
        build: { name: "Build", runsOn: ["ubuntu-latest"], steps: [step] },
        lint: { name: "Lint", runsOn: ["ubuntu-latest"], steps: [step] },
        package: {
          name: "Package",
          runsOn: ["self-hosted", "macos"],
          needs: ["build"],
          steps: [step],
        },
      },
    });

    const lanes = toSwimlane(toModel(pipeline)).lanes;

    expect(toModel(pipeline).participants.map((p) => p.kind)).toEqual(["system", "system"]);
    expect(
      lanes.map((lane) => [
        lane.participant,
        lane.label,
        lane.nodes.filter((n) => n in pipeline.jobs),
      ]),
    ).toEqual([
      [runnerIdOf(["ubuntu-latest"]), "ubuntu-latest", ["build", "lint"]],
      [runnerIdOf(["self-hosted", "macos"]), "self-hosted, macos", ["package"]],
    ]);
  });

  it("places a decision carrying the when predicate before a conditional job", () => {
    const predicate = when.event("pullRequest");
    const pipeline = pipelineSchema.parse({
      name: "CI",
      triggers: [{ kind: "push" }, { kind: "pullRequest" }],
      jobs: {
        build: { name: "Build", runsOn: ["ubuntu-latest"], steps: [step] },
        preview: {
          name: "Preview",
          runsOn: ["ubuntu-latest"],
          needs: ["build"],
          when: predicate,
          steps: [step],
        },
        notify: { name: "Notify", runsOn: ["ubuntu-latest"], needs: ["preview"], steps: [step] },
      },
    });
    const model = toModel(pipeline);

    expect(model.elements.find((element) => element.id === decisionIdOf("preview"))?.kind).toBe(
      "decision",
    );
    expect(model.transitions.find((t) => t.source === decisionIdOf("preview"))).toEqual({
      id: "preview:when->preview",
      source: "preview:when",
      target: "preview",
      guard: "when",
      condition: predicate,
    });
    expect(model.transitions.filter((t) => t.target === decisionIdOf("preview"))).toHaveLength(1);

    const statuses = deriveStatuses(model, { build: "done" }, eventIs("push"));

    expect(statuses.get("preview")).toBe("skipped");
    expect(statuses.get("notify")).toBe("skipped");
    expect(statuses.get("build")).toBe("done");

    expect(deriveStatuses(model, { build: "done" }, eventIs("pullRequest")).get("preview")).toBe(
      "ready",
    );
  });

  it("is indeterminate, not skipped, when the predicate cannot be answered", () => {
    const pipeline = pipelineSchema.parse({
      name: "CI",
      triggers: [{ kind: "push" }],
      jobs: {
        deploy: {
          name: "Deploy",
          runsOn: ["ubuntu-latest"],
          when: when.event("push"),
          steps: [step],
        },
      },
    });

    expect(deriveStatuses(toModel(pipeline), {}, noFacts).get("deploy")).toBe("unknown");
  });

  it("has the critical path of the repository's own pipeline, equal to its longest needs chain", async () => {
    const pipeline = await repositoryPipeline();
    const chains = longestChains(pipeline.jobs);
    const longest = Math.max(...chains.values());

    const { path, weight } = dag.criticalPath(jobGraphOf(pipeline.jobs), () => 1);

    expect(weight).toBe(longest);
    expect(path).toHaveLength(longest);
    expect(chains.get(path.at(-1) ?? "")).toBe(longest);
    for (const [index, id] of path.entries()) {
      expect(pipeline.jobs[id]?.needs ?? []).toEqual(
        index === 0 ? [] : expect.arrayContaining([path[index - 1]]),
      );
    }

    const model = toModel(pipeline);
    const remaining = remainingPath(model, {}, noFacts, (id) => (id in pipeline.jobs ? 1 : 0));
    expect(remaining.weight).toBe(longest);
    expect(remaining.path.filter((id) => id in pipeline.jobs)).toEqual(path);
  });
});
