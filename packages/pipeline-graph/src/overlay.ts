import { assertNever } from "@ci-adapters/pipeline-contract";
import type { Check } from "@ci-adapters/platform-contract";
import type { OpenIds, Overlay, OverlayStatus } from "@exadev/process-graph-schema";

/**
 * What a platform read produced for one job.
 *
 * `reported` carries the check the platform returned for the job. `unresolved` states that the platform could not say: the check was not readable, or the job's name matched no single check. Matching a check to a job id is the reader's work, since a check's name is provider-specific (`check-names` derives them); a matrix job is reported as one check, the aggregate of its combinations.
 */
export type JobState =
  { readonly kind: "reported"; readonly check: Check } | { readonly kind: "unresolved" };

/** Run state keyed by job id. A job with no entry has no data yet, which is distinct from `unresolved`. */
export type RunState = Readonly<Record<string, JobState>>;

/**
 * The overlay status of a job from the check reported for it.
 *
 * | Reported state                                        | Status    |
 * | ----------------------------------------------------- | --------- |
 * | `queued`, `running`, `waiting`                        | `open`    |
 * | `completed` with `success`, `neutral` or `skipped`    | `done`    |
 * | `completed` with `failure`, `timedOut`, `cancelled` or `actionRequired` | `open` |
 * | `completed` with `stale`                              | `unknown` |
 *
 * `neutral` and `skipped` count as done because they satisfy a required check on the platform and leave nothing to run. A failed, timed-out, cancelled or approval-blocked job is not finished, so it stays open and everything that needs it stays blocked. A `stale` conclusion describes an earlier commit, so it says nothing about this one.
 */
function statusOf(check: Check): OverlayStatus {
  if (check.status !== "completed") return "open";
  switch (check.conclusion) {
    case "success":
    case "neutral":
    case "skipped":
      return "done";
    case "failure":
    case "timedOut":
    case "cancelled":
    case "actionRequired":
      return "open";
    case "stale":
      return "unknown";
    default:
      return assertNever(check.conclusion);
  }
}

/**
 * Maps run state to the overlay of the model `toModel` builds, keyed by job id, which is the element id of the job's activity.
 *
 * | Run state for the job              | Overlay entry                               |
 * | ---------------------------------- | ------------------------------------------- |
 * | no entry                           | no entry, which the domain package reads as open |
 * | `unresolved`                       | `unknown`                                   |
 * | `reported` with a check            | the check's status, as `statusOf` tabulates |
 *
 * A job the run state does not mention is left out rather than written as `open`, because the schema distinguishes "no recorded state" from an explicit status, and `overlayOf` knows only the jobs it was given.
 *
 * The decision, fork, join, initial and final elements have no entry: they are control elements, and the domain package derives their state from the activities around them.
 * @param runState - The state read for each job of the run, by job id.
 */
export function overlayOf(runState: RunState): Overlay<OpenIds> {
  return Object.fromEntries(
    Object.entries(runState).map(([id, state]) => [
      id,
      state.kind === "unresolved" ? "unknown" : statusOf(state.check),
    ]),
  );
}
