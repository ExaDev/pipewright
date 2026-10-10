import { buildDag, findCycles, type Dag } from "@exadev/process-graph-dag";

import { DependencyGraphError } from "./errors.ts";
import type { Pipeline } from "./schema.ts";

/**
 * The dependency graph of a pipeline's jobs, with `needs` as edges, ready for the analyses of `@exadev/process-graph-dag` (layers, ancestors, critical path).
 *
 * A `needs` target that is not a job and a cycle are both errors here, never absorbed: the analyses would otherwise treat the first as no edge and leave cyclic jobs without a level.
 * @throws DependencyGraphError listing every unknown target and every cycle.
 */
export function jobGraphOf(jobs: Pipeline["jobs"]): Dag<string> {
  const dag = buildDag(Object.keys(jobs), (id) => jobs[id]?.needs ?? []);
  const cycles = findCycles(dag);
  if (dag.unknownReferences.length > 0 || cycles.length > 0) {
    throw new DependencyGraphError(
      dag.unknownReferences.map(({ from, missing }) => ({ job: from, missing })),
      cycles,
    );
  }

  return dag;
}
