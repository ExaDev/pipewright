/**
 * The line that starts a script entry written from several neutral run steps, or from one step of several lines. A neutral run step stops at its first failing command, as GitHub's `bash -e` does; a provider that runs the lines of an entry in one shell reports only the last status of an entry, so the entry states the rule itself.
 */
const FAIL_FAST = "set -e";

/**
 * Written between two steps that share an entry. A step's status is that of its last command, which errexit does not act on inside an AND-list or an OR-list, so the boundary checks it explicitly and a failed step ends the entry with its status before the next step runs.
 */
const BOUNDARY =
  '__pipewright_status=$?; [ "$__pipewright_status" -eq 0 ] || exit "$__pipewright_status"';

const BOUNDARY_SEPARATOR = `\n${BOUNDARY}\n`;
const FAIL_FAST_PREFIX = `${FAIL_FAST}\n`;

/**
 * The text of one script entry that runs the given neutral run steps in a shell they share, each stopping the entry when it fails. A single one-line step is its own text unchanged.
 */
export function joinShellSteps(steps: readonly string[]): string {
  const [only] = steps;
  if (steps.length === 1 && only !== undefined && !only.includes("\n")) return only;

  return `${FAIL_FAST_PREFIX}${steps.join(BOUNDARY_SEPARATOR)}`;
}

/**
 * The neutral run steps a script entry stands for: the inverse of {@link joinShellSteps}. An entry written by anything else has no boundaries and is one step, whose lines share a shell.
 */
export function splitShellEntry(entry: string): string[] {
  const body = entry.startsWith(FAIL_FAST_PREFIX) ? entry.slice(FAIL_FAST_PREFIX.length) : entry;

  return body.split(BOUNDARY_SEPARATOR);
}
