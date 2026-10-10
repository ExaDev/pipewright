import type { FakeState } from "@ci-adapters/platform-contract";

import { runCodec, checkCodec } from "../src/wire.ts";

export interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}

/**
 * Serves the slice of the GitHub REST API the adapter uses, from contract-level state. Responses are produced by the codecs' encode direction, so the adapter is read against the same wire definition it decodes with.
 */
export function createGitHubServer(state: FakeState): {
  fetch: typeof fetch;
  requests: RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];
  const json = (value: unknown): Response =>
    new Response(JSON.stringify(value), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  const handler = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const path = url.pathname.replace(/^\/repos\/[^/]+\/[^/]+/, "");
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    requests.push({
      method: init?.method ?? "GET",
      path: `${path}${url.search}`,
      headers,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });

    const runs = path.match(/^\/actions\/runs\/(\d+)$/);
    if (path === "/actions/runs") {
      const branch = url.searchParams.get("branch");
      const sha = url.searchParams.get("head_sha");
      const event = url.searchParams.get("event");
      const wire = state.runs
        .map((run) => runCodec.encode(run))
        .filter(
          (run) =>
            (branch === null || run.head_branch === branch) &&
            (sha === null || run.head_sha === sha) &&
            (event === null || run.event === event),
        );
      return Promise.resolve(json({ workflow_runs: wire }));
    }
    if (runs?.[1] !== undefined) {
      const run = state.runs.find((candidate) => candidate.id === runs[1]);
      return Promise.resolve(
        run === undefined
          ? new Response("{}", { status: 404 })
          : json(runCodec.encode(run)),
      );
    }
    const checks = path.match(/^\/commits\/([^/]+)\/check-runs$/);
    if (checks?.[1] !== undefined) {
      const listed = state.checks.get(decodeURIComponent(checks[1])) ?? [];
      return Promise.resolve(
        json({ check_runs: listed.map((check) => checkCodec.encode(check)) }),
      );
    }
    const jobs = path.match(/^\/actions\/runs\/(\d+)\/jobs$/);
    if (jobs?.[1] !== undefined) {
      return Promise.resolve(json({ jobs: [{ id: Number(jobs[1]), name: "build" }] }));
    }
    const logs = path.match(/^\/actions\/jobs\/(\d+)\/logs$/);
    if (logs?.[1] !== undefined) {
      return Promise.resolve(new Response(state.logs.get(logs[1]) ?? "", { status: 200 }));
    }
    const rules = path.match(/^\/rules\/branches\/([^/]+)$/);
    if (rules?.[1] !== undefined) {
      const required = state.required.get(decodeURIComponent(rules[1])) ?? [];
      return Promise.resolve(
        json([
          {
            type: "required_status_checks",
            parameters: { required_status_checks: required.map((context) => ({ context })) },
          },
          { type: "deletion" },
        ]),
      );
    }
    if (init?.method === "POST") {
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    return Promise.resolve(new Response("{}", { status: 404 }));
  };

  return { fetch: handler as typeof fetch, requests };
}
