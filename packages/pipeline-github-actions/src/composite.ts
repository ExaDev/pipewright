import { jsonPointerOf, type Step } from "@pipewright/pipeline-contract";
import { readYaml } from "@pipewright/yaml-emit";

import {
  NODE_USINGS,
  compositeActionSchema,
  nodeActionSchema,
  parseActionReference,
  parseCompositeStep,
  type ActionInput,
  type ActionReference,
  type CompositeAction,
  type CompositeStep,
  type MetadataIssue,
} from "./action.ts";
import { evaluateCondition, evaluateTemplate, type EvaluationContext } from "./evaluation.ts";
import { nodeExpansionOf, type NodeRunner } from "./node.ts";
import { PROVIDER } from "./vocabulary.ts";

/**
 * The deepest stack of composite actions one step may expand. GitHub's own runner prepares actions recursively and throws once the nesting depth passes nine, counted from zero at the workflow's own steps, which allows ten nested actions; this expansion counts the action the step names as the first of those ten and rejects an eleventh, so a workflow GitHub runs expands here too.
 * @see https://github.com/actions/runner/blob/main/src/Runner.Common/Constants.cs, the constant CompositeActionsMaxDepth
 */
export const COMPOSITE_ACTION_MAX_DEPTH = 10;

/** Where a failure is, when it is at a node of a metadata file. */
interface Location {
  readonly file: string;

  readonly pointer: string | undefined;
}

/** Reports a construct that cannot be expanded, where it is when it is in a metadata file. */
type Fail = (construct: string, at?: Location) => never;

/**
 * Raised when an action cannot be expanded: a reference that is not one of the forms a `uses` value can take, metadata that matches no form of action this package interprets, a construct the neutral model has no step form for, a cycle, or nesting past the bound. The chain names every reference from the step's own `uses` to the action the failure is in, so a failure deep inside a fetched action can still be located.
 */
export class ActionExpansionError extends Error {
  /** Every reference the expansion followed, by resolved location, ending with the one the failure is in; a cycle ends by repeating where it closed. Empty when the `uses` value itself could not be read. */
  readonly chain: readonly string[];

  /** The metadata file the failure is in, when it is in one. */
  readonly file: string | undefined;

  /** A JSON pointer into the metadata file, when the failure is at a node of one. */
  readonly pointer: string | undefined;

  constructor(chain: readonly string[], construct: string, at?: Location) {
    const where =
      at === undefined ? "" : ` at ${at.file}${at.pointer === undefined ? "" : ` ${at.pointer}`}`;
    const through = chain.length < 2 ? "" : `, through ${chain.join(" -> ")}`;

    super(`cannot expand the action: ${construct}${where}${through}`);
    this.name = "ActionExpansionError";
    this.chain = chain;
    this.file = at?.file;
    this.pointer = at?.pointer;
  }
}

/**
 * The steps one `uses` step becomes: the steps that run where the step stood, and the pre and post steps the caller places around the job's own steps. The placement rule mirrors the runner's own phases: the caller puts `pre` before the job's steps, in the order the actions were expanded, and it concatenates each action's `post` in that same order, reverses the whole sequence, and puts it after the job's steps, so cleanup unwinds in the opposite order the actions ran. An enclosing composite action applies the same rule to the actions nested in it, so a pre or post declared at any depth reaches the job's phases rather than the middle of a step list.
 * @see https://github.com/actions/runner/blob/main/src/Runner.Worker/JobExtension.cs, where the pre steps join the job before its own steps
 * @see https://github.com/actions/runner/blob/main/src/Runner.Worker/StepsRunner.cs, where the post steps pop off a stack after them
 */
export interface ActionExpansion {
  /** The steps that run where the `uses` step stood, in the order the action declared them. */
  readonly steps: readonly Step[];

  /** The `runs.pre` steps this action or one nested in it declared, in expansion order, which the caller places before the job's own steps. */
  readonly pre: readonly Step[];

  /** The `runs.post` steps this action or one nested in it declared, in expansion order, whose whole collected sequence the caller reverses and places after the job's own steps. */
  readonly post: readonly Step[];
}

/**
 * One action's files, fetched at the reference the host resolved them from. A tree is data: reading it decides what runs, and nothing in it executes because it was fetched.
 */
export interface ActionTree {
  /** The directory the host materialised the action at, which is `github.action_path` for the action's steps and the base of relative paths in its commands. */
  readonly path: string;

  /** Reads a file of the tree relative to the action's own directory, or undefined when the tree holds no file of that name. */
  readonly read: (path: string) => Promise<string | undefined>;

  /** Resolves a local `./` reference, which GitHub reads relative to the action's own directory, to the tree of the action it names. */
  readonly local: (path: string) => Promise<ActionTree>;
}

/**
 * The host's resolution port: from a reference to the action's files. The library makes no request of its own; a CLI host resolves a local reference against the workspace and a remote one at its ref, serving a reference to the repository being run from the checkout rather than the network, and tests serve in-memory trees.
 */
export type ActionResolver = (
  reference: ActionReference,
  signal?: AbortSignal,
) => Promise<ActionTree>;

export interface ExpandOptions {
  /** The host's resolution port. */
  readonly resolve: ActionResolver;

  /** The host's node port, asked when the expansion reaches a node action. */
  readonly node: NodeRunner;

  /**
   * The context the expressions of the action's steps are evaluated against, with `inputs` replaced by the action's mapped inputs for those steps. A condition that reads the outcome of a step the expansion itself produces reads this caller's view, because outcomes are known at run time only.
   */
  readonly context: EvaluationContext;

  readonly signal?: AbortSignal;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isScalar(value: unknown): value is string | number | boolean {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function scalarText(value: string | number | boolean): string {
  return typeof value === "string" ? value : String(value);
}

/** The repository half of a remote reference's identity, as written. */
function repoOf(reference: Extract<ActionReference, { kind: "remote" }>): string {
  const base = `${reference.owner}/${reference.repo}`;

  return reference.ref === undefined ? base : `${base}@${reference.ref}`;
}

/**
 * The canonical location of an action: how a chain names it and how a cycle is recognised. A local reference resolved into the workspace is named by its path from there, and a remote one by its repository at its ref plus its directory inside it, so the same action reached twice is the same string and two actions that differ only by ref are not.
 */
function identityOf(repo: string, at: string): string {
  if (repo === "") return `./${at}`;

  return at === "" ? repo : `${repo}/${at}`;
}

/**
 * Resolves a local reference's path against the location it appears at, rejecting one that climbs above the tree that location is in, because a local action cannot name an action outside the repository or workspace its own action was resolved from.
 */
function resolveAt(base: string, path: string, fail: (construct: string) => never): string {
  const resolved: string[] = [];
  const segments = [...(base === "" ? [] : base.split("/")), ...path.split("/")];
  for (const segment of segments) {
    if (segment === "..") {
      if (resolved.pop() === undefined) {
        fail("a local reference that climbs above the tree it was resolved from");
      }
      continue;
    }
    resolved.push(segment);
  }

  return resolved.join("/");
}

/**
 * The shells whose text the host's executor runs as written. The neutral `run` step has no shell field and every host of this tool executes a step's command through one POSIX shell of its own, so `bash` and `sh` need no interpretation while `pwsh`, `powershell`, `cmd` and `python` name interpreters the model cannot ask for and are rejected rather than mis-run.
 */
const POSIX_SHELLS = new Set(["bash", "sh"]);

/** What a metadata file said, split on the one key that decides how its action runs. */
interface Metadata {
  readonly using: string;

  readonly document: Record<string, unknown>;

  readonly file: string;
}

/**
 * Reads a metadata file. GitHub reads the file under either of two names and prefers `action.yml`, so the second is a documented alternative read only when the first is absent, not an invented fallback.
 */
async function readMetadata(tree: ActionTree, identity: string, fail: Fail): Promise<Metadata> {
  const yml = await tree.read("action.yml");
  const yaml = yml === undefined ? await tree.read("action.yaml") : undefined;
  const text = yml ?? yaml;
  if (text === undefined) {
    return fail(`a tree with no action.yml or action.yaml, at ${identity}`);
  }
  const file = `${identity}/${yml === undefined ? "action.yaml" : "action.yml"}`;
  let value: unknown;
  try {
    value = readYaml(text).value;
  } catch (error) {
    fail(
      `a metadata file that is not valid YAML: ${error instanceof Error ? error.message : String(error)}`,
      { file, pointer: undefined },
    );
  }
  if (!isRecord(value)) fail("a metadata file that is not a mapping", { file, pointer: undefined });
  const runs = value.runs;
  if (!isRecord(runs)) fail("metadata with no runs mapping", { file, pointer: "/runs" });
  if (typeof runs.using !== "string") {
    fail("a runs.using that is not text", { file, pointer: "/runs/using" });
  }

  return { using: runs.using, document: value, file };
}

/**
 * Validates a metadata document as a composite action. Each step is validated through its own branch, so a wrong key is named where it is; the document is then validated as a whole for everything around the steps.
 */
function compositeOf(metadata: Metadata, fail: Fail): CompositeAction {
  const { document, file } = metadata;
  const runs = document.runs;
  const steps = isRecord(runs) && Array.isArray(runs.steps) ? runs.steps : [];
  for (const [index, raw] of steps.entries()) {
    const parsed = parseCompositeStep(raw);
    if (parsed.success) continue;
    const prefix = `/runs/steps/${String(index)}`;
    const issues = parsed.issues.map((issue) => ({
      pointer: `${prefix}${issue.pointer}`,
      message: issue.message,
    }));

    fail(described("a composite action", issues), { file, pointer: issues[0]?.pointer ?? prefix });
  }
  const parsed = compositeActionSchema.safeParse(document);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => ({
      pointer: jsonPointerOf(
        issue.path.filter((segment): segment is string | number => typeof segment !== "symbol"),
      ),
      message: issue.message,
    }));

    fail(described("a composite action", issues), { file, pointer: issues[0]?.pointer });
  }

  return parsed.data;
}

/** The failure text for a metadata document: every issue as a pointer and a message, named by the form of action it failed to match. */
function described(form: string, issues: readonly MetadataIssue[]): string {
  return `metadata that does not match ${form}: ${issues
    .map((issue) => `${issue.pointer} ${issue.message}`)
    .join("; ")}`;
}

/**
 * Maps the `with` values a caller supplied onto the inputs the action declares, whichever form of action declared them. GitHub matches input names without regard to case and supplies an empty string for an optional input that arrived unset, which the runner itself writes in as the implicit default, so both are done here. Two things GitHub tolerates are errors instead, because each one means the workflow and the action disagree: an input the action does not declare (GitHub logs a warning and drops it), and a required input with no supplied value and no default (GitHub passes the empty string the runner substituted). Defaults are evaluated against the calling context rather than the action's own inputs, because that is the view the runner evaluates them with, before the child's inputs context exists.
 * @see https://github.com/actions/runner/blob/main/src/Runner.Worker/ActionRunner.cs, where the step's inputs are evaluated and the defaults merged
 */
function mapInputs(
  declared: Readonly<Record<string, ActionInput>>,
  supplied: Readonly<Record<string, string>>,
  ambient: EvaluationContext,
  fail: (construct: string) => never,
): Record<string, string> {
  const mapped: Record<string, string> = {};
  const matched = new Set<string>();
  for (const [name, input] of Object.entries(declared)) {
    const sought = name.toLowerCase();
    let value: string | undefined;
    for (const [key, entry] of Object.entries(supplied)) {
      if (key.toLowerCase() !== sought) continue;
      matched.add(key);
      // The first matching key in document order wins when two differ only by case, which is the closest a mapping without duplicate keys can come to the runner's dictionary.
      value ??= entry;
    }
    // A `default` written with no value reads as null and means no default, so it is absent rather than the text "null".
    if (value === undefined && input.default !== undefined && input.default !== null) {
      value = evaluateTemplate(scalarText(input.default), ambient);
    }
    if (value === undefined && input.required === true) {
      fail(`the required input "${name}", which no with supplied and which declares no default`);
    }
    mapped[name] = value ?? "";
  }
  for (const key of Object.keys(supplied)) {
    if (!matched.has(key)) fail(`the input "${key}", which the action does not declare`);
  }

  return mapped;
}

/** One nesting level to expand: where the action is, everything its step carried, and the chain walked so far. */
interface Frame {
  /** The action's file space: a remote repository at the ref it was read at, or empty for the workspace a local reference resolved into. */
  readonly repo: string;

  /** The action's directory within its file space, normalised, empty at the root. */
  readonly at: string;

  /** The `uses` text as written, which a provider step carries verbatim when the action turns out not to be composite. */
  readonly uses: string;

  /** The `with` mapping as written, whose values a provider step carries verbatim. */
  readonly with: Readonly<Record<string, string | number | boolean>>;

  /** The step's name, evaluated where the step appears, which a provider step carries. */
  readonly name: string | undefined;

  readonly ambient: EvaluationContext;

  readonly chain: readonly string[];

  readonly depth: number;

  readonly treeOf: (signal: AbortSignal | undefined) => Promise<ActionTree>;
}

/** The step a nested `uses` becomes when the action it names is not one this host interprets: the text as written, which is how the importer carries a workflow's own `uses` steps. */
function providerStepOf(
  uses: string,
  withMapping: Readonly<Record<string, string | number | boolean>>,
  name: string | undefined,
): Step {
  return {
    kind: "provider",
    provider: PROVIDER,
    native: {
      uses,
      ...(Object.keys(withMapping).length === 0 ? {} : { with: withMapping }),
    },
    ...(name === undefined ? {} : { name }),
  };
}

async function expandFrame(frame: Frame, options: ExpandOptions): Promise<ActionExpansion> {
  const { ambient, chain, depth } = frame;
  options.signal?.throwIfAborted();
  const identity = identityOf(frame.repo, frame.at);
  const through = [...chain, identity];
  const fail: Fail = (construct, at) => {
    throw new ActionExpansionError(through, construct, at);
  };
  if (chain.includes(identity)) {
    return fail(`the reference ${identity}, which is already being expanded`);
  }
  if (depth > COMPOSITE_ACTION_MAX_DEPTH) {
    return fail(
      `nesting ${String(depth)} composite actions deep, where the bound is ${String(COMPOSITE_ACTION_MAX_DEPTH)}`,
    );
  }

  const tree = await frame.treeOf(options.signal);
  const metadata = await readMetadata(tree, identity, fail);
  if (metadata.using === "docker") {
    return fail(
      'runs.using "docker", which needs a container runtime; container actions are out of scope on the host',
      { file: metadata.file, pointer: "/runs/using" },
    );
  }
  if (metadata.using !== "composite" && !NODE_USINGS.has(metadata.using)) {
    return fail(
      `runs.using "${metadata.using}", which names neither a composite action nor a node runtime`,
      { file: metadata.file, pointer: "/runs/using" },
    );
  }

  // A `with` value is evaluated where its step appears, before the action's own inputs exist, and every mapped value is a string because the runner builds the child's inputs context from strings however the caller wrote the value.
  const supplied: Record<string, string> = {};
  for (const [key, value] of Object.entries(frame.with)) {
    supplied[key] = evaluateTemplate(scalarText(value), ambient);
  }

  if (metadata.using !== "composite") {
    const parsed = nodeActionSchema.safeParse(metadata.document);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((issue) => ({
        pointer: jsonPointerOf(
          issue.path.filter((segment): segment is string | number => typeof segment !== "symbol"),
        ),
        message: issue.message,
      }));

      return fail(described("a node action", issues), {
        file: metadata.file,
        pointer: issues[0]?.pointer,
      });
    }
    const action = parsed.data;
    if (action.runs.pre !== undefined && frame.repo === "") {
      return fail("runs.pre, which GitHub documents as not supported for a local action", {
        file: metadata.file,
        pointer: "/runs/pre",
      });
    }

    return nodeExpansionOf({
      action,
      path: tree.path,
      inputs: mapInputs(action.inputs ?? {}, supplied, ambient, fail),
      name: frame.name,
      uses: frame.uses,
      ambient,
      invocation: await options.node(options.signal),
    });
  }
  const action = compositeOf(metadata, fail);
  const inputs = mapInputs(action.inputs ?? {}, supplied, ambient, fail);
  const ofAction: EvaluationContext = {
    ...ambient,
    github: { ...ambient.github, action_path: tree.path },
    inputs,
  };

  // The steps expand in the order the action declared them, each through the context the ones before it leave behind, so the awaits chain rather than run side by side. A nested action's pre and post steps join this action's own, because the runner runs a pre or post declared at any depth in the job's own phases rather than between a composite's steps.
  const nothingExpanded: ActionExpansion = { steps: [], pre: [], post: [] };

  return action.runs.steps.reduce<Promise<ActionExpansion>>(async (previous, step, index) => {
    const expansion = await previous;
    options.signal?.throwIfAborted();
    const stepAt = (key: string): string => `/runs/steps/${String(index)}/${key}`;
    const stepEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(step.env ?? {})) {
      stepEnv[key] = evaluateTemplate(scalarText(value), ofAction);
    }
    // The step's own environment is visible to its other expressions, so those evaluate against the merged view.
    const stepContext: EvaluationContext =
      Object.keys(stepEnv).length === 0
        ? ofAction
        : { ...ofAction, env: { ...ofAction.env, ...stepEnv } };
    const name = step.name === undefined ? undefined : evaluateTemplate(step.name, stepContext);
    if (step.if !== undefined && !evaluateCondition(step.if, stepContext)) return expansion;
    const continueOnError = step["continue-on-error"];
    if (continueOnError !== undefined) {
      const setting =
        typeof continueOnError === "string"
          ? evaluateTemplate(continueOnError, stepContext)
          : String(continueOnError);
      if (setting !== "false") {
        return fail("a step with continue-on-error, which the model has no step form for", {
          file: metadata.file,
          pointer: stepAt("continue-on-error"),
        });
      }
    }
    if ("run" in step) {
      const shell = evaluateTemplate(step.shell, stepContext);
      if (!POSIX_SHELLS.has(shell)) {
        return fail(
          `the shell "${shell}", which names an interpreter the host's own shell would not run as written`,
          { file: metadata.file, pointer: stepAt("shell") },
        );
      }
      const run = evaluateTemplate(step.run, stepContext);
      if (run === "") {
        return fail("a command that evaluated to the empty string", {
          file: metadata.file,
          pointer: stepAt("run"),
        });
      }

      return {
        ...expansion,
        steps: [
          ...expansion.steps,
          {
            kind: "run",
            ...(name === undefined ? {} : { name }),
            run,
            // The runner sets GITHUB_ACTION_PATH while an action's commands execute, so it is injected over any value the step itself wrote for it.
            env: { ...stepEnv, GITHUB_ACTION_PATH: tree.path },
            ...(step["working-directory"] === undefined
              ? {}
              : { workingDirectory: evaluateTemplate(step["working-directory"], stepContext) }),
          } satisfies Step,
        ],
      };
    }

    const nested = await expandNestedUses(step, {
      ofAction: stepContext,
      name,
      through,
      depth,
      frame,
      tree,
      metadata,
      index,
      options,
    });

    return {
      steps: [...expansion.steps, ...nested.steps],
      pre: [...expansion.pre, ...nested.pre],
      post: [...expansion.post, ...nested.post],
    };
  }, Promise.resolve(nothingExpanded));
}

/** What a nested `uses` step needs from the loop that read it. */
interface NestedCall {
  /** The context of the enclosing action's step, with the step's own environment merged in. */
  readonly ofAction: EvaluationContext;

  readonly name: string | undefined;

  /** The chain ending at the enclosing action, which the child's own frame extends. */
  readonly through: readonly string[];

  /** The enclosing action's nesting level; the child is one deeper. */
  readonly depth: number;

  readonly frame: Frame;

  readonly tree: ActionTree;

  readonly metadata: Metadata;

  readonly index: number;

  readonly options: ExpandOptions;
}

/**
 * Expands one `uses` step of a composite action. A nested action is expanded exactly as a workflow's own step is, whichever form of action it names, so a node action runs under the host's node from inside a composite too. A `docker://` reference is the one thing carried rather than expanded: no tree exists to read, so its step stays a provider step carrying the `uses` and `with` text as written, which is the host's business.
 */
async function expandNestedUses(
  step: Extract<CompositeStep, { uses: string }>,
  call: NestedCall,
): Promise<ActionExpansion> {
  const { ofAction, through, depth, frame, tree, metadata, index, options } = call;
  const fail: Fail = (construct, at) => {
    throw new ActionExpansionError(through, construct, at);
  };
  if (step.uses.startsWith("docker://")) {
    return {
      steps: [providerStepOf(step.uses, step.with ?? {}, call.name)],
      pre: [],
      post: [],
    };
  }
  let reference: ActionReference;
  try {
    reference = parseActionReference(step.uses);
  } catch (error) {
    if (!(error instanceof Error)) throw error;

    return fail(error.message, {
      file: metadata.file,
      pointer: `/runs/steps/${String(index)}/uses`,
    });
  }
  const remote =
    reference.kind === "remote"
      ? { repo: repoOf(reference), at: reference.subpath ?? "" }
      : {
          repo: frame.repo,
          at: resolveAt(frame.at, reference.path, fail),
        };

  return expandFrame(
    {
      ...remote,
      uses: step.uses,
      with: step.with ?? {},
      name: call.name,
      ambient: ofAction,
      chain: through,
      depth: depth + 1,
      treeOf:
        reference.kind === "local"
          ? async (): Promise<ActionTree> => tree.local(reference.path)
          : async (signal: AbortSignal | undefined): Promise<ActionTree> =>
              options.resolve(reference, signal),
    },
    options,
  );
}

/**
 * Reads the `with` mapping a provider step's `native` carries, which the importer wrote verbatim from the workflow.
 */
function withOf(
  native: Readonly<Record<string, unknown>>,
  fail: (construct: string) => never,
): Record<string, string | number | boolean> {
  const supplied: Record<string, string | number | boolean> = {};
  if (!("with" in native)) return supplied;
  const mapping = native.with;
  if (!isRecord(mapping)) return fail("a with that is not a mapping");
  for (const [key, value] of Object.entries(mapping)) {
    if (!isScalar(value)) return fail(`the input "${key}" with a value that is not a scalar`);
    supplied[key] = value;
  }

  return supplied;
}

/**
 * Expands the action a `provider` step names into the steps the model runs. The step's `uses` and `with` are read from its `native` mapping; a composite action's steps are expanded in the order it declared them, with every declared input mapped from the supplied `with` or its default and the `${{ }}` expressions evaluated through the evaluator of `evaluation.ts`, against a context whose `inputs` holds the mapped values and whose `github.action_path` is the directory the host resolved the action to; a node action's `main` entry becomes one neutral run step under the host's node invocation, its `with` mapped the same way and carried as `INPUT_*` environment, with its `pre` and `post` entries returned as steps the caller places around the job's own steps per the rule on `ActionExpansion`. A nested `uses` recurses, bounded by `COMPOSITE_ACTION_MAX_DEPTH` and rejecting a cycle by naming the whole reference chain; a nested `docker://` reference stays a provider step carrying the text as written, while metadata whose `runs.using` names neither a composite action nor a node runtime, docker included, is rejected with the file and pointer.
 *
 * Pre: `step` is a `provider` step of this provider whose `native` carries a `uses` string, and `options.context` has passed `evaluationContextSchema`. Post: the returned `steps` are in the order the action declared them, a step whose `if` evaluated false is left out, each composite `run` step carries its own evaluated environment plus `GITHUB_ACTION_PATH`, and each node step carries its inputs as `INPUT_*` plus `GITHUB_ACTION_PATH`. Errors: throws `ActionExpansionError` for anything that cannot be expanded, and lets `EvaluationError` through as the evaluator raised it. The step's own `when` is the caller's to honour: this function expands an action that will run, not one that may not.
 */
export async function expandAction(step: Step, options: ExpandOptions): Promise<ActionExpansion> {
  const fail = (construct: string): never => {
    throw new ActionExpansionError([], construct);
  };
  if (step.kind !== "provider") return fail("a step that is not a provider step");
  if (step.provider !== PROVIDER) {
    return fail(`a provider step of ${step.provider}, not of ${PROVIDER}`);
  }
  if (typeof step.native.uses !== "string") return fail("a provider step whose native has no uses");
  let reference: ActionReference;
  try {
    reference = parseActionReference(step.native.uses);
  } catch (error) {
    if (!(error instanceof Error)) throw error;

    return fail(error.message);
  }
  const where =
    reference.kind === "remote"
      ? { repo: repoOf(reference), at: reference.subpath ?? "" }
      : { repo: "", at: resolveAt("", reference.path, fail) };

  // The workflow's own step may carry an environment for the action, which its expressions read and its commands run with; it is merged into the caller's view here and so reaches every expanded step, while the job-level environment stays the runner's to compose.
  let ambient: EvaluationContext = options.context;
  if ("env" in step.native) {
    const declared = step.native.env;
    if (!isRecord(declared)) return fail("a step environment that is not a mapping");
    const merged: Record<string, string> = { ...ambient.env };
    for (const [key, value] of Object.entries(declared)) {
      if (!isScalar(value)) {
        return fail(`the step environment "${key}" with a value that is not a scalar`);
      }
      merged[key] = evaluateTemplate(scalarText(value), ambient);
    }
    ambient = { ...ambient, env: merged };
  }

  return expandFrame(
    {
      ...where,
      uses: step.native.uses,
      with: withOf(step.native, fail),
      name: step.name,
      ambient,
      chain: [],
      depth: 1,
      treeOf: async (signal: AbortSignal | undefined): Promise<ActionTree> =>
        options.resolve(reference, signal),
    },
    options,
  );
}
