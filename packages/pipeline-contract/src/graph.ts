import { dag } from "process-graph";

import { DependencyGraphError } from "./errors.ts";
import type { Pipeline } from "./schema.ts";

/**
 * The dependency graph of a pipeline's jobs, with `needs` as edges, ready for the analyses of the `dag` namespace of `process-graph` (layers, ancestors, critical path).
 *
 * A `needs` target that is not a job and a cycle are both errors here, never absorbed: the analyses would otherwise treat the first as no edge and leave cyclic jobs without a level.
 * @throws DependencyGraphError listing every unknown target and every cycle.
 */
export function jobGraphOf(jobs: Pipeline["jobs"]): dag.Dag<string> {
  const graph = dag.buildDag(Object.keys(jobs), (id) => jobs[id]?.needs ?? []);
  const cycles = dag.findCycles(graph);
  if (graph.unknownReferences.length > 0 || cycles.length > 0) {
    throw new DependencyGraphError(
      graph.unknownReferences.map(({ from, missing }) => ({ job: from, missing })),
      cycles,
    );
  }

  return graph;
}
