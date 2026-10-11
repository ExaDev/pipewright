import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { CHECKOUT_ACTION, nodeActionSchema } from "@pipewright/pipeline-github-actions";
import { parse } from "yaml";

import { createActionHost } from "../src/actions.ts";

/**
 * Resolves the pinned checkout action the adapter's own pipelines use, over the network, through the same fetching resolver a `run` supplies: the reference is fetched as a tarball, extracted, and its metadata reads as the node action it is. The token goes along when the environment holds one, so a private clone of this repository resolves it too.
 */
describe("a fetched action over the network", () => {
  it("resolves the pinned checkout action and reads its metadata and entry", async () => {
    const host = createActionHost({
      cwd: await mkdtemp(join(tmpdir(), "pipewright-fetch-")),
      fetch,
      context: {},
      token: process.env.GH_TOKEN,
      secrets: {},
      skipProviderSteps: false,
    });
    try {
      const [locator, ref] = CHECKOUT_ACTION.split("@");
      const [owner, repo] = locator?.split("/") ?? [];
      if (owner === undefined || repo === undefined || ref === undefined) {
        throw new Error(`the pinned checkout action is not owner/repo@ref: ${CHECKOUT_ACTION}`);
      }
      const tree = await host.resolver({ kind: "remote", owner, repo, subpath: undefined, ref });
      const metadata = await tree.read("action.yml");
      if (metadata === undefined) throw new Error("the checkout action holds no action.yml");
      const action = nodeActionSchema.parse(parse(metadata));
      const entry = await tree.read(action.runs.main);
      expect(entry).toBeDefined();
    } finally {
      await host.dispose();
    }
  });
});
