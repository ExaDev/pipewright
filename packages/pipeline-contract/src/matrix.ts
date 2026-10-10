import type { Job } from "./schema.ts";

export type MatrixCombination = Readonly<Record<string, string | number | boolean>>;

/**
 * Every combination of a job's matrix axes, first axis varying slowest. A job without a matrix has exactly one empty combination, so callers can treat "no matrix" and "a matrix" uniformly.
 */
export function expandMatrix(matrix: Job["matrix"]): MatrixCombination[] {
  let combinations: MatrixCombination[] = [{}];
  for (const [axis, values] of Object.entries(matrix ?? {})) {
    combinations = combinations.flatMap((partial) =>
      values.map((value) => ({ ...partial, [axis]: value })),
    );
  }
  return combinations;
}
