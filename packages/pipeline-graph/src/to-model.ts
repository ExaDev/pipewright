import type { Pipeline } from "@ci-adapters/pipeline-contract";
import type {
  Element,
  Model,
  OpenIds,
  Participant,
  Transition,
} from "@exadev/process-graph-schema";

/** The element every job without `needs` follows. A job id never contains a colon, so none of the generated ids can collide with one. */
export const INITIAL_ID = "pipeline:initial";

/** The element every job that nothing needs precedes. */
export const FINAL_ID = "pipeline:final";

/** Id of the decision that guards a job with a `when` condition. */
export function decisionIdOf(jobId: string): string {
  return `${jobId}:when`;
}

/** Id of the fork that opens a matrix job's combinations. */
export function forkIdOf(jobId: string): string {
  return `${jobId}:fork`;
}

/** Id of the join that closes a matrix job's combinations. */
export function joinIdOf(jobId: string): string {
  return `${jobId}:join`;
}

/** Id of the system participant for a job's `runsOn` labels, which together name one runner. */
export function runnerIdOf(runsOn: readonly string[]): string {
  return `runner:${runsOn.join(",")}`;
}

/**
 * Maps a pipeline to the process model of `@exadev/process-graph-schema`, so the process-graph projections and domain queries apply to it.
 *
 * - Every job is an `activity` whose id is the job id and whose actor is the `system` participant of its `runsOn` labels. The labels of one job together name one runner, so a participant exists per distinct label list.
 * - Every `needs` entry is a transition from the needed job to the dependent job.
 * - A job with `when` is preceded by a `decision` (`<job>:when`) whose only outgoing transition carries the predicate as its `condition`. The predicate is already the trilean tree the model uses, so it is carried over unchanged. The transition into the decision is the job's `needs`, so a false predicate cuts the job and everything that depends only on it.
 * - A matrix job is one activity between a `fork` pseudo-state (`<job>:fork`) and a `join` pseudo-state (`<job>:join`). The model has no repetition by value, so the combinations are not expanded into one activity each: the pair states that the work fans out and must all complete before dependents continue, and every combination stays a single element, which is what a run state is keyed by.
 * - An `initial` pseudo-state precedes every job without `needs` and a `final` pseudo-state follows every job nothing needs.
 *
 * A job's `needs` enter its decision when it has one, else its fork when it is a matrix job, else the activity; dependents leave from the join when it is a matrix job, else the activity. `needsPolicy` and the steps are not part of the model: it describes ordering and ownership, not how a job reports.
 * @param pipeline - A pipeline whose jobs' `needs` all name jobs of the pipeline.
 */
export function toModel(pipeline: Pipeline): Model<OpenIds> {
  const jobs = Object.entries(pipeline.jobs);
  const needed = new Set(jobs.flatMap(([, job]) => job.needs ?? []));

  const participants = new Map<string, Participant<string>>();
  for (const [, job] of jobs) {
    const id = runnerIdOf(job.runsOn);
    if (!participants.has(id)) {
      participants.set(id, { id, label: job.runsOn.join(", "), kind: "system" });
    }
  }

  const entryOf = (id: string): string => {
    const job = pipeline.jobs[id];
    if (job?.when !== undefined) return decisionIdOf(id);

    return job?.matrix === undefined ? id : forkIdOf(id);
  };
  const exitOf = (id: string): string =>
    pipeline.jobs[id]?.matrix === undefined ? id : joinIdOf(id);

  const elements: Element<string, OpenIds>[] = [
    { kind: "pseudo", id: INITIAL_ID, role: "initial" },
    { kind: "pseudo", id: FINAL_ID, role: "final" },
  ];
  const transitions: Transition<string, OpenIds>[] = [];
  const connect = (source: string, target: string): Transition<string, OpenIds> => ({
    id: `${source}->${target}`,
    source,
    target,
  });

  for (const [id, job] of jobs) {
    if (job.when !== undefined) {
      elements.push({ kind: "decision", id: decisionIdOf(id), label: `${job.name}: when` });
    }
    if (job.matrix !== undefined) {
      elements.push({ kind: "pseudo", id: forkIdOf(id), role: "fork" });
    }
    elements.push({
      kind: "activity",
      id,
      label: job.name,
      actor: runnerIdOf(job.runsOn),
    });
    if (job.matrix !== undefined) {
      elements.push({ kind: "pseudo", id: joinIdOf(id), role: "join" });
    }

    const entry = entryOf(id);
    const needs = [...new Set(job.needs ?? [])];
    if (needs.length === 0) transitions.push(connect(INITIAL_ID, entry));
    for (const need of needs) transitions.push(connect(exitOf(need), entry));
    if (job.when !== undefined) {
      const target = job.matrix === undefined ? id : forkIdOf(id);
      transitions.push({
        ...connect(decisionIdOf(id), target),
        guard: "when",
        condition: job.when,
      });
    }
    if (job.matrix !== undefined) {
      transitions.push(connect(forkIdOf(id), id), connect(id, joinIdOf(id)));
    }
    if (!needed.has(id)) transitions.push(connect(exitOf(id), FINAL_ID));
  }

  return {
    participants: [...participants.values()],
    events: [],
    actions: [],
    artefacts: [],
    elements,
    transitions,
    fragments: [],
    projections: [
      { id: "flowchart", notation: "flowchart" },
      { id: "swimlane", notation: "swimlane" },
    ],
  };
}
