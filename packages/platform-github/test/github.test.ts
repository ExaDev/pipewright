import { describe, expect, it } from "vitest";

import {
  PlatformRequestError,
  createFakeState,
  describeReaderConformance,
  type FakeState,
} from "@ci-adapters/platform-contract";

import { createGitHubController, createGitHubReader, runCodec } from "../src/index.ts";
import { createGitHubServer } from "./server.ts";

const TOKEN_VALUE = "test-credential";

function options(state: FakeState): ReturnType<typeof createGitHubServer> & {
  readonly config: Parameters<typeof createGitHubReader>[0];
} {
  const server = createGitHubServer(state);
  return {
    ...server,
    config: {
      owner: "example",
      repo: "repo",
      fetch: server.fetch,
      token: () => Promise.resolve(TOKEN_VALUE),
    },
  };
}

describeReaderConformance({ describe, it }, (state) => {
  // Logs are served per job, keyed by the job id, which the test server derives from the run id.
  return createGitHubReader(options(state).config);
});

describe("GitHub reader", () => {
  it("sends the credential as a bearer token and pins the API version", async () => {
    const state = createFakeState();
    const server = options(state);
    await createGitHubReader(server.config).listRuns({});
    expect(server.requests[0]?.headers["authorization"]).toBe(`Bearer ${TOKEN_VALUE}`);
    expect(server.requests[0]?.headers["x-github-api-version"]).toBe("2022-11-28");
  });

  it("translates the neutral event name in the query", async () => {
    const server = options(createFakeState());
    await createGitHubReader(server.config).listRuns({ event: "pullRequest" });
    expect(server.requests[0]?.path).toContain("event=pull_request");
  });

  it("rejects a page size above the API maximum", async () => {
    const server = options(createFakeState());
    await expect(
      createGitHubReader(server.config).listRuns({ limit: 101 }),
    ).rejects.toBeInstanceOf(RangeError);
  });

  it("raises a request error with the status for a failing response", async () => {
    const server = options(createFakeState());
    await expect(createGitHubReader(server.config).getRun("999")).rejects.toMatchObject({
      status: 404,
    });
    await expect(createGitHubReader(server.config).getRun("999")).rejects.toBeInstanceOf(
      PlatformRequestError,
    );
  });
});

describe("run codec", () => {
  it("round-trips a completed run", () => {
    const run = {
      id: "7",
      name: "CI",
      status: "completed" as const,
      conclusion: "timedOut" as const,
      ref: "main",
      sha: "abc",
      event: "manual",
      url: "https://example.com",
      createdAt: "2026-01-01T00:00:00Z",
    };
    expect(runCodec.decode(runCodec.encode(run))).toEqual(run);
  });

  it("rejects a conclusion with no neutral meaning", () => {
    expect(() =>
      runCodec.decode({
        id: 1,
        name: "CI",
        status: "completed",
        conclusion: "stale",
        head_branch: "main",
        head_sha: "abc",
        event: "push",
        html_url: "https://example.com",
        created_at: "2026-01-01T00:00:00Z",
      }),
    ).toThrow("stale");
  });
});

describe("GitHub controller", () => {
  it("posts rerun, cancel and dispatch to the documented endpoints", async () => {
    const server = options(createFakeState());
    const controller = createGitHubController(server.config);
    await controller.rerun("5");
    await controller.cancel("5");
    await controller.dispatch({ workflow: "ci.yml", ref: "main", inputs: { a: "b" } });
    expect(server.requests.map((request) => `${request.method} ${request.path}`)).toEqual([
      "POST /actions/runs/5/rerun",
      "POST /actions/runs/5/cancel",
      "POST /actions/workflows/ci.yml/dispatches",
    ]);
    expect(server.requests[2]?.body).toEqual({ ref: "main", inputs: { a: "b" } });
  });
});
