import { describe, expect, it } from "vitest";

import { createGitHubActionsCompiler } from "@pipewright/pipeline-github-actions";
import { createGitHubController, createGitHubReader } from "@pipewright/platform-github";
import type { Run } from "@pipewright/platform-contract";

import pipeline from "../../../ci/e2e.pipeline.ts";

/** Seconds between polls of the dispatched run, and how many polls are allowed before the wait gives up. */
const POLL_INTERVAL_MS = 10_000;
const MAX_POLLS = 54;
/** How many recent runs to look through for the one this test dispatched. */
const RECENT_RUNS = 20;

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is required: GH_TOKEN, REPOSITORY (owner/repo) and E2E_REF`);
  }

  return value;
}

async function sleep(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

describe("an emitted GitHub workflow executed on GitHub", () => {
  it("runs to success and is reported under the check names the compiler derived", async () => {
    const [owner, repo] = required("REPOSITORY").split("/");
    if (owner === undefined || repo === undefined) throw new Error("REPOSITORY must be owner/repo");
    const ref = required("E2E_REF");
    const options = {
      owner,
      repo,
      fetch,
      token: async () => Promise.resolve(required("GH_TOKEN")),
    };
    const reader = createGitHubReader(options);
    const controller = createGitHubController(options);

    const compiler = createGitHubActionsCompiler();
    const [file] = await compiler.compile(pipeline, {
      source: "ci/e2e.pipeline.ts",
      toolCommand: "node packages/cli/src/bin.ts",
    });
    if (file === undefined) throw new Error("no workflow emitted");
    const workflowFile = file.path.split("/").at(-1);
    if (workflowFile === undefined) throw new Error("emitted path has no file name");

    const startedAt = new Date();
    await controller.dispatch({ workflow: workflowFile, ref });

    const findDispatched = async (): Promise<Run | undefined> => {
      const runs = await reader.listRuns({ ref, event: "manual", limit: RECENT_RUNS });

      return runs.find((run) => run.name === pipeline.name && new Date(run.createdAt) >= startedAt);
    };
    const settle = async (remaining: number): Promise<Run> => {
      if (remaining === 0) throw new Error("the dispatched run did not finish in time");
      await sleep(POLL_INTERVAL_MS);
      const run = await findDispatched();
      if (run?.status === "completed") return run;

      return settle(remaining - 1);
    };

    const finished = await settle(MAX_POLLS);
    expect(finished.status).toBe("completed");
    expect(finished.status === "completed" ? finished.conclusion : undefined).toBe("success");

    const reported = (await reader.listChecks(finished.sha)).map((check) => check.name);
    const derived = [...compiler.checkNames(pipeline).values()].flat();
    expect(derived.length).toBeGreaterThan(0);
    for (const name of derived) expect(reported).toContain(name);
  });
});
