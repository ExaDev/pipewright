import type { Step } from "@pipewright/pipeline-contract";

import {
  expandAction,
  type ActionExpansion,
  type ActionResolver,
  type ActionTree,
} from "../src/composite.ts";
import { evaluationContextSchema, type EvaluationContext } from "../src/evaluation.ts";
import type { NodeRunner } from "../src/node.ts";

/** The files of one repository or workspace, keyed from its root. */
export type Files = Readonly<Record<string, string>>;

/** Joins a location inside a tree with a path relative to it, the way a filesystem does. */
function joined(at: string, relative: string): string {
  const resolved = [...(at === "" ? [] : at.split("/"))];
  for (const segment of relative.split("/")) {
    if (segment === "..") resolved.pop();
    else resolved.push(segment);
  }

  return resolved.join("/");
}

/** An in-memory tree over one set of files, served the way a host that holds the whole repository on disk serves it. */
function treeOf(files: Files, at: string, path: string): ActionTree {
  return {
    path,
    read: async (relative) => Promise.resolve(files[joined(at, relative)]),
    local: async (relative) =>
      Promise.resolve(treeOf(files, joined(at, relative), `${path}/${relative}`)),
  };
}

/**
 * A host resolver over in-memory trees: local references against one workspace, remote ones against a file set per repository at a ref. A repository being run is served from the workspace's own files, which is what a host with a checkout does.
 */
export function resolverOf(
  workspace: Files,
  remotes: Readonly<Record<string, Files>> = {},
): ActionResolver {
  return async (reference) => {
    if (reference.kind === "local") {
      return Promise.resolve(treeOf(workspace, reference.path, `/workspace/${reference.path}`));
    }
    const key =
      reference.ref === undefined
        ? `${reference.owner}/${reference.repo}`
        : `${reference.owner}/${reference.repo}@${reference.ref}`;
    const files = remotes[key];
    if (files === undefined) return Promise.reject(new Error(`no fixture for ${key}`));

    return Promise.resolve(
      treeOf(
        files,
        reference.subpath ?? "",
        `/actions/${key}${reference.subpath === undefined ? "" : `/${reference.subpath}`}`,
      ),
    );
  };
}

/** A context with the github fields a composite action reads. */
export const CONTEXT: EvaluationContext = evaluationContextSchema.parse({
  github: {
    event_name: "push",
    ref_name: "main",
    base_ref: "",
    sha: "abc123def456",
    repository: "exadev/pipewright",
    workflow: "CI",
    run_id: "1536140711",
  },
  env: {},
  job: { status: "success" },
  steps: {},
  needs: {},
  matrix: {},
  secrets: {},
  inputs: {},
});

/** The node port a test host supplies: the `node` the shell finds, with no arguments of its own. */
export const NODE: NodeRunner = async () => Promise.resolve({ command: "node", args: [] });

/** The provider step the importer builds for a workflow step with a `uses`. */
export function usesStep(
  uses: string,
  supplied: Readonly<Record<string, string | number | boolean>> = {},
): Step {
  return {
    kind: "provider",
    provider: "github-actions",
    native: { uses, ...(Object.keys(supplied).length === 0 ? {} : { with: supplied }) },
  };
}

/** Expands a step against a resolver and the fixture context, and rejects anything that throws. */
export async function expanded(
  step: Step,
  resolve: ActionResolver,
  node: NodeRunner = NODE,
): Promise<ActionExpansion> {
  return expandAction(step, { resolve, node, context: CONTEXT });
}

/** The error a promise rejected with, so its message and fields can be asserted. */
export async function rejectionOf(promise: Readonly<Promise<unknown>>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (!(error instanceof Error)) throw error;

    return error;
  }

  throw new Error("expected the expansion to fail");
}
