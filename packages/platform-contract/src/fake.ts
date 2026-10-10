import type { CiPlatformController, CiPlatformReader } from "./contract.ts";
import { PlatformRequestError } from "./errors.ts";
import type { Check, DispatchRequest, Run } from "./schema.ts";

const HTTP_NOT_FOUND = 404;

export interface FakeState {
  runs: Run[];
  checks: Map<string, Check[]>;
  logs: Map<string, string>;
  required: Map<string, string[]>;
  dispatched: DispatchRequest[];
  rerun: string[];
  cancelled: string[];
}

export function createFakeState(): FakeState {
  return {
    runs: [],
    checks: new Map(),
    logs: new Map(),
    required: new Map(),
    dispatched: [],
    rerun: [],
    cancelled: [],
  };
}

/**
 * A reference platform with real behaviour over in-memory state, so consumers of the contract are built and tested before any provider is involved, and so adapters can be compared with it.
 */
export function createFakePlatform(state: FakeState): {
  reader: CiPlatformReader;
  controller: CiPlatformController;
} {
  const find = (id: string): Run => {
    const run = state.runs.find((candidate) => candidate.id === id);
    if (run === undefined) throw new PlatformRequestError(HTTP_NOT_FOUND, `fake://runs/${id}`);

    return run;
  };

  return {
    reader: {
      capabilities: { logs: true, requiredChecks: true },
      async listRuns(query) {
        const matching = state.runs.filter(
          (run) =>
            (query.ref === undefined || run.ref === query.ref) &&
            (query.sha === undefined || run.sha === query.sha) &&
            (query.event === undefined || run.event === query.event),
        );

        return Promise.resolve(matching.slice(0, query.limit));
      },
      getRun: async (id) => Promise.resolve(find(id)),
      listChecks: async (sha) => Promise.resolve(state.checks.get(sha) ?? []),
      async getLogs(runId) {
        find(runId);

        return Promise.resolve(state.logs.get(runId) ?? "");
      },
      requiredChecks: async (branch) => Promise.resolve(state.required.get(branch) ?? []),
    },
    controller: {
      capabilities: { rerun: true, cancel: true, dispatch: true },
      async rerun(runId) {
        find(runId);
        state.rerun.push(runId);

        return Promise.resolve();
      },
      async cancel(runId) {
        find(runId);
        state.cancelled.push(runId);

        return Promise.resolve();
      },
      async dispatch(request) {
        state.dispatched.push(request);

        return Promise.resolve();
      },
    },
  };
}
