import type { Check, DispatchRequest, Run, RunQuery } from "./schema.ts";

/**
 * Which read operations an adapter really performs. A method whose flag is false throws `UnsupportedOperationError`, and the conformance kit runs only the declared set, so a provider's missing capability is stated rather than faked.
 */
export interface ReadCapabilities {
  readonly logs: boolean;
  readonly requiredChecks: boolean;
}

export interface ControlCapabilities {
  readonly rerun: boolean;
  readonly cancel: boolean;
  readonly dispatch: boolean;
}

/**
 * Read-only operations against a CI platform. Usable on its own, with no pipeline model and no emitted configuration.
 */
export interface CiPlatformReader {
  readonly capabilities: ReadCapabilities;
  listRuns(query: RunQuery, signal?: AbortSignal): Promise<readonly Run[]>;
  getRun(id: string, signal?: AbortSignal): Promise<Run>;
  /** The checks reported for a commit, which are what a branch ruleset's required checks are matched against. */
  listChecks(sha: string, signal?: AbortSignal): Promise<readonly Check[]>;
  getLogs(runId: string, signal?: AbortSignal): Promise<string>;
  /** Names of the checks the platform requires before `branch` accepts a merge. */
  requiredChecks(branch: string, signal?: AbortSignal): Promise<readonly string[]>;
}

/**
 * Operations that change run state. Kept apart from the reader so a consumer that only observes never holds the ability to act.
 */
export interface CiPlatformController {
  readonly capabilities: ControlCapabilities;
  rerun(runId: string, signal?: AbortSignal): Promise<void>;
  cancel(runId: string, signal?: AbortSignal): Promise<void>;
  dispatch(request: DispatchRequest, signal?: AbortSignal): Promise<void>;
}
