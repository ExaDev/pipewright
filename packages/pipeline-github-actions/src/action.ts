import { jsonPointerOf } from "@pipewright/pipeline-contract";
import { z } from "zod";

/**
 * The metadata file of an action (`action.yml`, or `action.yaml`), read as data. A fetched tree is never executed: these schemas describe what a composite or node action declares, and the interpretation in `composite.ts` and `node.ts` are the only places that turn one into steps.
 * @see https://docs.github.com/en/actions/sharing-automations/creating-actions/metadata-syntax-for-github-actions
 * @see https://web.archive.org/web/20250615225859/https://docs.github.com/en/actions/sharing-automations/creating-actions/metadata-syntax-for-github-actions
 */

/**
 * A value a workflow or a composite step can write where GitHub reads a string: a scalar, because the YAML forms of these keys are scalars and anything else (a mapping, a list, a null) is a malformed file, not a value to coerce.
 */
const scalarSchema = z.union([z.string(), z.number(), z.boolean()]);

const envSchema = z.record(z.string().min(1), scalarSchema);

/** An input id: GitHub requires a letter or underscore first, then letters, digits, hyphens and underscores. */
const INPUT_ID = /^[A-Za-z_][A-Za-z0-9_-]*$/;

/**
 * One declared input. GitHub documents no type for an action's inputs (unlike a reusable workflow's `workflow_call` inputs): every value an action receives is a string, and `default` is a string or a YAML scalar that reads as one. `required` is a request, not an enforcement: the runner supplies an empty string when a required input arrives unset, so enforcement is this package's decision, taken in `composite.ts`.
 */
const inputSchema = z.strictObject({
  description: z.string(),
  required: z.boolean().optional(),
  default: scalarSchema.optional(),
  deprecationMessage: z.string().optional(),
});
export type ActionInput = z.output<typeof inputSchema>;

/**
 * A `continue-on-error` value: a boolean, or the text of an expression that evaluates to one.
 */
const continueOnErrorSchema = z.union([z.boolean(), z.string()]);

/**
 * The keys every action declares around the way it runs, whichever runtime `runs.using` names. They are one mapping so the two forms of action cannot drift apart: an input, its default and its `required` request mean the same thing to a composite action's steps and to a node action's entry file.
 */
const actionKeys = {
  name: z.string().min(1),
  description: z.string(),
  inputs: z.record(z.string().regex(INPUT_ID), inputSchema).optional(),
  branding: z.strictObject({ icon: z.string(), color: z.string() }).optional(),
};

/**
 * A step that runs a command. `shell` is required whenever `run` is written, which is GitHub's own rule for composite steps and the reason it is not optional here.
 */
const runStepSchema = z.strictObject({
  name: z.string().optional(),
  id: z.string().optional(),
  if: z.string().optional(),
  run: z.string().min(1),
  shell: z.string().min(1),
  "working-directory": z.string().min(1).optional(),
  env: envSchema.optional(),
  "continue-on-error": continueOnErrorSchema.optional(),
});

/**
 * A step that calls another action. `working-directory` is not a key of this form: GitHub documents it for the command a `run` step executes.
 */
const usesStepSchema = z.strictObject({
  name: z.string().optional(),
  id: z.string().optional(),
  if: z.string().optional(),
  uses: z.string().min(1),
  with: z.record(z.string(), scalarSchema).optional(),
  env: envSchema.optional(),
  "continue-on-error": continueOnErrorSchema.optional(),
});

/**
 * A composite step: exactly one of `run` and `uses`. The two schemas share no field that the other forbids, so the union accepts a step when precisely one key is present and rejects it, on both branches, when both or neither is.
 */
export const compositeStepSchema = z.union([runStepSchema, usesStepSchema]);
export type CompositeStep = z.output<typeof compositeStepSchema>;

/**
 * The metadata of an action whose `runs.using` is `composite`. The keys GitHub documents and this package does not read (`branding`, the declared `inputs`' descriptions, `runs.outputs`) are carried as data, because they describe the action rather than change how its steps run. Keys GitHub does not document for a composite action (a step `timeout-minutes`, `runs.image`) are rejected by the strict objects, which is the same stance the importer takes with a workflow.
 */
export const compositeActionSchema = z.strictObject({
  ...actionKeys,
  runs: z.strictObject({
    using: z.literal("composite"),
    steps: z.array(compositeStepSchema).min(1),
    /**
     * The action's outputs, each a `${{ }}` expression over the steps that produced them. They are carried as data only: evaluating one needs the outputs those steps wrote at run time, which no expansion of the steps can know beforehand.
     */
    outputs: z
      .record(
        z.string().min(1),
        z.strictObject({ value: z.string(), description: z.string().optional() }),
      )
      .optional(),
  }),
});
export type CompositeAction = z.output<typeof compositeActionSchema>;

/**
 * The runtimes a node action's `runs.using` names. The metadata syntax documents `node20` and `node24`; `node16` and `node12` are gone from the documentation but remain runtimes the runner names, so an action pinned to them still expands. The declared runtime is a label the host's node port may read: the entry file runs under whichever node the host supplies, never a binary this package names.
 * @see https://github.com/actions/runner/blob/main/src/Runner.Worker/ActionManifestManager.cs, the node12/node16/node20/node24 branch of runs.using
 */
const NODE_RUNTIMES = ["node20", "node16", "node12", "node24"] as const;

/**
 * The metadata of an action whose `runs.using` names a node runtime: `main` is the entry file the runtime executes, and `pre` and `post` are entry files that run around the job's steps when `pre-if` and `post-if` allow, both conditions defaulting to `always()`. A `pre` a local action declares is rejected where the expansion places it, because GitHub documents `pre` as not supported for local actions. Keys the node form does not document (`runs.image`, `runs.steps`) are rejected by the strict object, which is the same stance the composite schema takes.
 * @see https://docs.github.com/en/actions/sharing-automations/creating-actions/metadata-syntax-for-github-actions
 * @see https://web.archive.org/web/20250615225859/https://docs.github.com/en/actions/sharing-automations/creating-actions/metadata-syntax-for-github-actions
 */
export const nodeActionSchema = z.strictObject({
  ...actionKeys,
  runs: z.strictObject({
    using: z.enum(NODE_RUNTIMES),
    main: z.string().min(1),
    pre: z.string().min(1).optional(),
    "pre-if": z.string().min(1).optional(),
    post: z.string().min(1).optional(),
    "post-if": z.string().min(1).optional(),
  }),
});
export type NodeAction = z.output<typeof nodeActionSchema>;

/** The `runs.using` values whose action this package executes itself, for dispatch before a document is validated as one form or the other. */
export const NODE_USINGS = new Set<string>(NODE_RUNTIMES);

/** Where a metadata file's node is wrong, and what is wrong with it. */
export interface MetadataIssue {
  readonly pointer: string;

  readonly message: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function issuesOf(error: z.ZodError): readonly MetadataIssue[] {
  return error.issues.map((issue) => ({
    pointer: jsonPointerOf(
      issue.path.filter((segment): segment is string | number => typeof segment !== "symbol"),
    ),
    message: issue.message,
  }));
}

/**
 * Validates one composite step, choosing its branch by the key that is present. Validating through the union instead would report a failure on both branches for any one wrong key, because each branch forbids the other's key, so this is how a step's own keys are checked and how the union is read back.
 */
export function parseCompositeStep(
  value: unknown,
):
  | { readonly success: true; readonly step: CompositeStep }
  | { readonly success: false; readonly issues: readonly MetadataIssue[] } {
  if (isRecord(value)) {
    if ("run" in value && "uses" in value) {
      return {
        success: false,
        issues: [{ pointer: "", message: "a step that has both run and uses" }],
      };
    }
    if ("run" in value) {
      const parsed = runStepSchema.safeParse(value);

      return parsed.success
        ? { success: true, step: parsed.data }
        : { success: false, issues: issuesOf(parsed.error) };
    }
    if ("uses" in value) {
      const parsed = usesStepSchema.safeParse(value);

      return parsed.success
        ? { success: true, step: parsed.data }
        : { success: false, issues: issuesOf(parsed.error) };
    }

    return {
      success: false,
      issues: [{ pointer: "", message: "a step with neither run nor uses" }],
    };
  }

  return { success: false, issues: [{ pointer: "", message: "a step that is not a mapping" }] };
}

/**
 * Raised when a `uses` value is not one of the forms a reference can take. The expansion path wraps this into `ActionExpansionError`; the message stands alone when the parser is used directly.
 */
export class ActionReferenceError extends Error {
  /** The `uses` value as written. */
  readonly uses: string;

  /** What the value is, phrased like the importer's own rejections. */
  readonly construct: string;

  constructor(uses: string, construct: string) {
    super(`cannot resolve the reference ${JSON.stringify(uses)}: ${construct}`);
    this.name = "ActionReferenceError";
    this.uses = uses;
    this.construct = construct;
  }
}

/**
 * A `uses` value. A local path is resolved against the directory it appears in, which for a workflow step is the repository the runner checked out and for a composite step is the action's own directory, so its `..` segments are kept for whoever knows that base to apply; a remote reference names a repository, optionally a directory inside it, and optionally the ref to read it at, exactly as written because a missing ref is the host resolver's to interpret, not this parser's.
 */
export type ActionReference =
  | { readonly kind: "local"; readonly path: string }
  | {
      readonly kind: "remote";
      readonly owner: string;
      readonly repo: string;
      readonly subpath: string | undefined;
      readonly ref: string | undefined;
    };

/**
 * Removes `.` and empty segments and keeps `..` as written, because a local reference's `..` is resolved against the directory the reference appears in, which the parser does not know: a workflow step's local reference is relative to the repository root and a composite step's to the action's own directory, and only the code that knows the base can tell a climb within the repository from one out of it.
 */
function normalisePath(segments: readonly string[], uses: string): string[] {
  if (segments.some((segment) => segment === "")) {
    throw new ActionReferenceError(uses, "a path with an empty segment");
  }

  return segments.filter((segment) => segment !== ".");
}

/** The characters a GitHub owner or repository name is built from, so a locator segment carrying anything else is named rather than fetched. */
const NAME = /^[A-Za-z0-9_.-]+$/;

/**
 * Reads a `uses` value into its forms: a local `./path`, an `owner/repo`, an `owner/repo@ref` and a subpath form `owner/repo/path@ref`. The first `@` separates the locator from the ref, because an owner, a repository and a path cannot contain one while a ref may (a branch or tag name can). Anything else, a `docker://` image and the gated same-repository `$/` alias among them, is rejected naming what the value is.
 * @see https://docs.github.com/en/actions/sharing-automations/creating-actions/metadata-syntax-for-github-actions
 */
export function parseActionReference(uses: string): ActionReference {
  if (uses.startsWith("./")) {
    const segments = normalisePath(uses.slice(2).split("/"), uses);
    if (segments.length === 0) {
      throw new ActionReferenceError(uses, "a local reference with no path after ./");
    }

    return { kind: "local", path: segments.join("/") };
  }
  if (uses.startsWith("docker://")) {
    throw new ActionReferenceError(
      uses,
      "a container image, which needs a container runtime; container actions are out of scope on the host",
    );
  }
  if (uses.startsWith("$/")) {
    throw new ActionReferenceError(
      uses,
      "the same-repository alias, which is a gated runner feature this package does not resolve; write the repository reference out",
    );
  }
  const at = uses.indexOf("@");
  const [locator, ref] = at === -1 ? [uses] : [uses.slice(0, at), uses.slice(at + 1)];
  if (ref !== undefined && ref === "") {
    throw new ActionReferenceError(uses, "a remote reference with no ref after @");
  }
  const [owner, repo, ...subpath] = locator.split("/");
  if (owner === undefined || repo === undefined || !NAME.test(owner) || !NAME.test(repo)) {
    throw new ActionReferenceError(
      uses,
      "a remote reference that is not owner/repo, optionally a directory inside it, optionally @ref",
    );
  }
  const directory = normalisePath(subpath, uses);
  let level = 0;
  for (const segment of directory) {
    level += segment === ".." ? -1 : 1;
    if (level < 0) {
      throw new ActionReferenceError(uses, "a path that climbs above the repository it names");
    }
  }

  return {
    kind: "remote",
    owner,
    repo,
    subpath: directory.length === 0 ? undefined : directory.join("/"),
    ref,
  };
}
