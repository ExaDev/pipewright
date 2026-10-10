import {
  PlatformRequestError,
  checkSchema,
  type Check,
  type CiPlatformController,
  type CiPlatformReader,
  type DispatchRequest,
  type Run,
  type RunQuery,
} from "@pipewright/platform-contract";

import {
  GITHUB_MAX_PAGE_SIZE,
  checkCodec,
  checkListSchema,
  eventToWire,
  jobListSchema,
  ruleListSchema,
  runCodec,
  runListSchema,
} from "./wire.ts";

const DEFAULT_API_BASE = "https://api.github.com";
/** The REST API version this adapter's wire schemas were written against, sent so a server default change cannot alter responses. */
const API_VERSION = "2022-11-28";

export interface GitHubOptions {
  readonly owner: string;
  readonly repo: string;
  /** Any `fetch`-compatible function, injected so the adapter runs in every runtime and under test. */
  readonly fetch: typeof fetch;
  /** Supplies the bearer token on each request. The adapter never reads files or the environment for it. */
  readonly token: () => Promise<string>;
  readonly apiBase?: string;
}

class Client {
  readonly #options: GitHubOptions;

  constructor(options: GitHubOptions) {
    this.#options = options;
  }

  get #base(): string {
    const { owner, repo } = this.#options;

    return `${this.#options.apiBase ?? DEFAULT_API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  }

  async request(
    method: "GET" | "POST",
    path: string,
    signal: AbortSignal | undefined,
    body?: unknown,
  ): Promise<Response> {
    const url = `${this.#base}${path}`;
    const response = await this.#options.fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${await this.#options.token()}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": API_VERSION,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(signal === undefined ? {} : { signal }),
    });
    if (!response.ok) throw new PlatformRequestError(response.status, url);

    return response;
  }

  async json(path: string, signal: AbortSignal | undefined): Promise<unknown> {
    return (await this.request("GET", path, signal)).json();
  }
}

function pageSize(limit: number | undefined): number {
  const wanted = limit ?? GITHUB_MAX_PAGE_SIZE;
  if (wanted > GITHUB_MAX_PAGE_SIZE) {
    throw new RangeError(
      `limit ${String(wanted)} exceeds GitHub's page size of ${String(GITHUB_MAX_PAGE_SIZE)}`,
    );
  }

  return wanted;
}

function queryString(entries: Readonly<Record<string, string | undefined>>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(entries)) {
    if (value !== undefined) params.set(key, value);
  }
  const text = params.toString();

  return text === "" ? "" : `?${text}`;
}

/**
 * Reads runs, checks, logs and required checks from the GitHub REST API. Read-only: it holds no method that changes state.
 */
export function createGitHubReader(options: GitHubOptions): CiPlatformReader {
  const client = new Client(options);

  return {
    capabilities: { logs: true, requiredChecks: true },

    async listRuns(query: RunQuery, signal?: AbortSignal): Promise<readonly Run[]> {
      const path = `/actions/runs${queryString({
        branch: query.ref,
        head_sha: query.sha,
        event: query.event === undefined ? undefined : eventToWire(query.event),
        per_page: String(pageSize(query.limit)),
      })}`;
      const list = runListSchema.parse(await client.json(path, signal));

      return list.workflow_runs.map((wire) => runCodec.decode(wire));
    },

    async getRun(id: string, signal?: AbortSignal): Promise<Run> {
      const wire = runListSchema.shape.workflow_runs.element.parse(
        await client.json(`/actions/runs/${encodeURIComponent(id)}`, signal),
      );

      return runCodec.decode(wire);
    },

    async listChecks(sha: string, signal?: AbortSignal): Promise<readonly Check[]> {
      const path = `/commits/${encodeURIComponent(sha)}/check-runs?per_page=${String(GITHUB_MAX_PAGE_SIZE)}`;
      const list = checkListSchema.parse(await client.json(path, signal));

      return list.check_runs.map((wire) => checkSchema.parse(checkCodec.decode(wire)));
    },

    async getLogs(runId: string, signal?: AbortSignal): Promise<string> {
      const jobs = jobListSchema.parse(
        await client.json(
          `/actions/runs/${encodeURIComponent(runId)}/jobs?per_page=${String(GITHUB_MAX_PAGE_SIZE)}`,
          signal,
        ),
      );
      const sections = await Promise.all(
        jobs.jobs.map(async (job) => {
          const response = await client.request(
            "GET",
            `/actions/jobs/${String(job.id)}/logs`,
            signal,
          );

          return `### ${job.name}\n${await response.text()}`;
        }),
      );

      return sections.join("\n");
    },

    async requiredChecks(branch: string, signal?: AbortSignal): Promise<readonly string[]> {
      const rules = ruleListSchema.parse(
        await client.json(`/rules/branches/${encodeURIComponent(branch)}`, signal),
      );

      return rules.flatMap((rule) =>
        rule.type === "required_status_checks"
          ? (rule.parameters?.required_status_checks ?? []).map((entry) => entry.context)
          : [],
      );
    },
  };
}

/**
 * Re-runs, cancels and dispatches GitHub Actions runs. Held separately from the reader so a consumer that only observes cannot act.
 */
export function createGitHubController(options: GitHubOptions): CiPlatformController {
  const client = new Client(options);

  return {
    capabilities: { rerun: true, cancel: true, dispatch: true },

    async rerun(runId: string, signal?: AbortSignal): Promise<void> {
      await client.request("POST", `/actions/runs/${encodeURIComponent(runId)}/rerun`, signal);
    },

    async cancel(runId: string, signal?: AbortSignal): Promise<void> {
      await client.request("POST", `/actions/runs/${encodeURIComponent(runId)}/cancel`, signal);
    },

    async dispatch(request: DispatchRequest, signal?: AbortSignal): Promise<void> {
      await client.request(
        "POST",
        `/actions/workflows/${encodeURIComponent(request.workflow)}/dispatches`,
        signal,
        { ref: request.ref, inputs: request.inputs ?? {} },
      );
    },
  };
}
