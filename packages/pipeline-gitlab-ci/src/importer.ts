import {
  UnsupportedNativeError,
  findTemplateTokens,
  jsonPointerOf,
  uniqueJobIds,
  validateImported,
  type EmittedFile,
  type Pipeline,
  type PipelineImporter,
  type PredicateNode,
  splitShellEntry,
} from "@pipewright/pipeline-contract";
import { commentPath, readYaml } from "@pipewright/yaml-emit";

import { ExpressionError, parseRuleIf } from "./expression.ts";
import {
  CONTEXT_OF_VARIABLE,
  EVENT_OF_SOURCE,
  PROVIDER,
  RESERVED_NAMES,
  literalOfRegex,
} from "./vocabulary.ts";

type Pointer = readonly (string | number)[];

function fail(pointer: Pointer, construct: string): never {
  throw new UnsupportedNativeError(PROVIDER, jsonPointerOf(pointer), construct);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isScalar(value: unknown): value is string | number | boolean {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function recordAt(value: unknown, pointer: Pointer, what: string): Record<string, unknown> {
  if (!isRecord(value)) return fail(pointer, `${what} that is not a mapping`);

  return value;
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter((item): item is string => typeof item === "string");

  return strings.length === value.length ? strings : undefined;
}

/**
 * A call of this tool's runner, which is what a wrapper-form file contains where steps were. It carries none of the steps, so there is nothing to import from it.
 */
const WRAPPER_CALL = /\srun --pipeline \S+ --job \S+ --steps \d+-\d+/;

/** Private-use characters that stand for an escaped dollar sign while a value's references are read. */
const DOLLAR_OPEN = "\uE000";
const DOLLAR_CLOSE = "\uE001";
const VARIABLE_REFERENCE = /\$(\{[^}]*\}|[A-Za-z0-9_]+|\$)/g;
const AXIS = /^[A-Za-z][A-Za-z0-9_]*$/;

/**
 * A variable value with each reference to a neutral context variable, or to an axis of the job's matrix, replaced by its token, or `undefined` when it has no neutral form: another variable, a value that is not text, or literal text that already looks like a token.
 */
function neutralText(value: unknown, axes: ReadonlySet<string>): string | undefined {
  if (!isScalar(value)) return undefined;
  const text = String(value);
  if (findTemplateTokens(text).length > 0) return undefined;
  let foreign = 0;
  const neutral = text.replace(VARIABLE_REFERENCE, (whole, name: string) => {
    // `$$` is how GitLab writes a literal dollar sign.
    if (name === "$") return `${DOLLAR_OPEN}${DOLLAR_CLOSE}`;
    const bare = name.startsWith("{") ? name.slice(1, -1) : name;
    const key = CONTEXT_OF_VARIABLE.get(`$${bare}`);
    if (key !== undefined) return `{{ ${key} }}`;
    if (axes.has(bare) && AXIS.test(bare)) return `{{ matrix.${bare} }}`;
    foreign += 1;

    return whole;
  });

  if (foreign !== 0) return undefined;

  return neutral.replaceAll(`${DOLLAR_OPEN}${DOLLAR_CLOSE}`, "$");
}

function neutralVariables(
  value: unknown,
  axes: ReadonlySet<string>,
): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const neutral: [string, string][] = [];
  for (const [key, entry] of Object.entries(value)) {
    const text = neutralText(entry, axes);
    if (text === undefined) return undefined;
    neutral.push([key, text]);
  }

  return Object.fromEntries(neutral);
}

/**
 * The literal alternatives of a branch pattern `(a|b)` the compiler writes, or `undefined` for any other regular expression.
 */
function branchesOf(pattern: string): string[] | undefined {
  const flat = /^\/\^\((.*)\)\$\/i$/.exec(pattern);
  const body = flat?.[1];
  if (body === undefined) return undefined;
  const alternatives: string[] = [];
  let current = "";
  for (let index = 0; index < body.length; index += 1) {
    const char = body.charAt(index);
    if (char === "\\") {
      current += body.slice(index, index + 2);
      index += 1;
    } else if (char === "|") {
      alternatives.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  alternatives.push(current);
  const literals = alternatives.map(literalOfRegex);

  return literals.every((literal): literal is string => literal !== undefined)
    ? literals
    : undefined;
}

const WORKFLOW_RULE = /^\$CI_PIPELINE_SOURCE == "([a-z_]+)"(?: && (\$[A-Z_]+) =~ (\/.*\/i))?$/;

function triggerAt(rule: unknown, pointer: Pointer): Record<string, unknown> {
  const settings = recordAt(rule, pointer, "a workflow rule");
  const keys = Object.keys(settings);
  if (keys.length !== 1 || keys[0] !== "if" || typeof settings.if !== "string") {
    return fail(pointer, "a workflow rule other than a single if");
  }
  const match = WORKFLOW_RULE.exec(settings.if);
  const kind = match?.[1] === undefined ? undefined : EVENT_OF_SOURCE.get(match[1]);
  if (match === null || kind === undefined || kind === "schedule") {
    return fail(
      [...pointer, "if"],
      "a workflow rule that is not a pipeline source and branch filter",
    );
  }
  const variable = match[2];
  const pattern = match[3];
  if (variable === undefined || pattern === undefined) {
    return kind === "push" || kind === "pullRequest" ? { kind } : { kind: "manual" };
  }
  const expected = kind === "push" ? "$CI_COMMIT_BRANCH" : "$CI_MERGE_REQUEST_TARGET_BRANCH_NAME";
  const branches = branchesOf(pattern);
  if (
    (kind !== "push" && kind !== "pullRequest") ||
    variable !== expected ||
    branches === undefined
  ) {
    return fail([...pointer, "if"], "a branch filter the model has no form for");
  }

  return { kind, branches };
}

interface RulesResult {
  readonly always: boolean;
  readonly when: PredicateNode | undefined;
  /** True when the rules have no neutral form and the node carries them as written. */
  readonly carried: boolean;
}

function rulesAt(value: unknown): RulesResult {
  const none: RulesResult = { always: false, when: undefined, carried: false };
  if (value === undefined) return none;
  const carried: RulesResult = { always: false, when: undefined, carried: true };
  if (!Array.isArray(value) || value.length !== 1) return carried;
  const rule: unknown = value[0];
  if (!isRecord(rule)) return carried;
  const keys = Object.keys(rule);
  const always = rule.when === "always";
  const known = keys.every((key) => key === "if" || (key === "when" && always));
  if (!known || keys.length === 0) return carried;
  if (rule.if === undefined) return { always, when: undefined, carried: false };
  if (typeof rule.if !== "string") return carried;
  try {
    return { always, when: parseRuleIf(rule.if), carried: false };
  } catch (error) {
    if (error instanceof ExpressionError) return carried;
    throw error;
  }
}

const MINUTES = /^(\d+) minutes$/;
const JOB_KEYS = new Set([
  "stage",
  "tags",
  "needs",
  "timeout",
  "environment",
  "parallel",
  "variables",
  "rules",
  "script",
]);

function matrixOf(parallel: unknown): Record<string, unknown> | undefined {
  if (!isRecord(parallel) || Object.keys(parallel).length !== 1) return undefined;
  const { matrix } = parallel;
  if (!Array.isArray(matrix) || matrix.length !== 1) return undefined;
  const axes: unknown = matrix[0];
  if (!isRecord(axes) || Object.keys(axes).length === 0) return undefined;
  const expressible = Object.entries(axes).every(
    ([axis, values]) =>
      AXIS.test(axis) && Array.isArray(values) && values.length > 0 && values.every(isScalar),
  );

  return expressible ? axes : undefined;
}

interface JobContext {
  readonly comments: ReadonlyMap<string, string>;
  readonly idOf: ReadonlyMap<string, string>;
  readonly implicitNeeds: ReadonlyMap<string, readonly string[]>;
  /** The pipeline-level variables, which a job inherits and may override. */
  readonly globals: Readonly<Record<string, string>>;
  /** What GitLab applies to a job that does not set it, which each inheriting job carries. */
  readonly defaults: Readonly<Record<string, unknown>>;
}

/** A shell reference to a variable GitLab defines or exports, which another provider's runner does not. */
const RUNTIME_VARIABLE = /\$\{?(?:CI|GITLAB)(?:_[A-Z0-9_]+)?\b/;

function readsRuntimeVariable(line: string, axes: ReadonlySet<string>): boolean {
  // GitHub evaluates `${{ }}` in a command before the shell, so a command carrying one must not reach a GitHub workflow as portable text.
  if (RUNTIME_VARIABLE.test(line) || line.includes("${{")) return true;

  return [...axes].some((axis) => new RegExp(`\\$\\{?${axis}\\b`).test(line));
}

function jobAt(name: string, value: unknown, context: JobContext): Record<string, unknown> {
  const pointer: Pointer = [name];
  const job = recordAt(value, pointer, "a job");
  if ("extends" in job) return fail([...pointer, "extends"], "a job that extends another");
  if ("trigger" in job)
    return fail([...pointer, "trigger"], "a job that triggers another pipeline");
  // A job with no tags runs on any runner, which the model states as no runner label.
  const tagged = inheritsDefault("tags", job) ? context.defaults.tags : job.tags;
  const tags = tagged === undefined ? [] : stringList(tagged);
  if (tags === undefined) return fail([...pointer, "tags"], "tags that are not a list of strings");
  const script = typeof job.script === "string" ? [job.script] : job.script;
  const lines = stringList(script);
  if (lines === undefined || lines.length === 0) {
    return fail([...pointer, "script"], "a job whose script is not a non-empty list of strings");
  }
  const wrapped = lines.findIndex((line) => WRAPPER_CALL.test(line));
  if (wrapped !== -1) {
    return fail(
      [...pointer, "script", wrapped],
      "a call to this tool's runner, which stands for steps held in the pipeline file it names; import that file",
    );
  }

  const native: Record<string, unknown> = {};
  const matrix = job.parallel === undefined ? undefined : matrixOf(job.parallel);
  if (job.parallel !== undefined && matrix === undefined) native.parallel = job.parallel;
  const axes = new Set(Object.keys(matrix ?? {}));

  const variables = job.variables === undefined ? undefined : neutralVariables(job.variables, axes);
  if (job.variables !== undefined && variables === undefined) native.variables = job.variables;
  const depth = variables?.GIT_DEPTH ?? context.globals.GIT_DEPTH;
  const checksOut = (variables?.GIT_STRATEGY ?? context.globals.GIT_STRATEGY) !== "none";
  const fetchDepth =
    depth === undefined || !checksOut
      ? undefined
      : depth === "0"
        ? "full"
        : /^[1-9][0-9]*$/.test(depth)
          ? Number(depth)
          : undefined;
  const env =
    variables === undefined
      ? undefined
      : Object.fromEntries(
          Object.entries(variables).filter(
            ([key]) => key !== "GIT_DEPTH" || fetchDepth === undefined,
          ),
        );

  const rules = rulesAt(job.rules);
  if (rules.carried) native.rules = job.rules;

  const timeout = typeof job.timeout === "string" ? MINUTES.exec(job.timeout)?.[1] : undefined;
  if (job.timeout !== undefined && timeout === undefined) native.timeout = job.timeout;
  // An environment name with a variable in it is expanded by GitLab, which another provider would take literally.
  const environmentPortable = typeof job.environment === "string" && !job.environment.includes("$");
  if (job.environment !== undefined && !environmentPortable) native.environment = job.environment;

  const needs = job.needs === undefined ? context.implicitNeeds.get(name) : stringList(job.needs);
  if (job.needs !== undefined && needs === undefined) {
    return fail([...pointer, "needs"], "a needs entry with options, or one that is not a job name");
  }
  const needIds = (needs ?? []).map((needed, index) => {
    const id = context.idOf.get(needed);
    if (id === undefined) {
      return fail(
        [...pointer, "needs", index],
        `a needs entry ${JSON.stringify(needed)} that is not a job in this file`,
      );
    }

    return id;
  });

  for (const [key, entry] of Object.entries(job)) {
    if (!JOB_KEYS.has(key)) native[key] = entry;
  }
  for (const [key, entry] of Object.entries(inheritedDefaults(context.defaults, job))) {
    native[key] = entry;
  }

  const description = context.comments.get(commentPath(name));
  // The lines of a script run in one shell, so they are one step, whose commands share its working directory and variables.
  const labels = lines.flatMap((_line, index) => {
    const label = context.comments.get(commentPath(name, "script", String(index)));

    return label === undefined ? [] : [label];
  });
  const described = labels.length === 0 ? {} : { description: labels.join("\n") };
  // A job that carries settings of GitLab's own (an image, services, a before_script, an unreadable `rules`, a start condition) is GitLab's as a whole, because another provider would run its script without them. The concurrency keys are read back at the pipeline level and are not among these.
  const gated = Object.keys(native).some(
    (key) => key !== "interruptible" && key !== "resource_group",
  );
  const portable = !gated && !lines.some((line) => readsRuntimeVariable(line, axes));
  const steps = [
    ...(checksOut
      ? [{ kind: "checkout", ...(fetchDepth === undefined ? {} : { fetchDepth }) }]
      : []),
    ...(portable
      ? splitShellEntry(lines.join("\n")).map((run, at) => ({
          kind: "run",
          run,
          ...(at === 0 ? described : {}),
        }))
      : [{ kind: "provider", provider: PROVIDER, native: { script: lines }, ...described }]),
  ];

  return {
    name,
    ...(description === undefined ? {} : { description }),
    runsOn: tags,
    ...(job.needs === undefined && needIds.length === 0 ? {} : { needs: needIds }),
    ...(rules.always ? { needsPolicy: "always" } : {}),
    ...(rules.when === undefined ? {} : { when: rules.when }),
    ...(timeout === undefined ? {} : { timeoutMinutes: Number(timeout) }),
    ...(environmentPortable && typeof job.environment === "string"
      ? { environment: job.environment }
      : {}),
    ...(env === undefined || Object.keys(env).length === 0 ? {} : { env }),
    ...(matrix === undefined ? {} : { matrix }),
    steps,
    ...(Object.keys(native).length === 0 ? {} : { native: { [PROVIDER]: native } }),
  };
}

const DEFAULT_STAGES = ["build", "test", "deploy"];
const DEFAULT_JOB_STAGE = "test";
const FIRST_STAGE = ".pre";
const LAST_STAGE = ".post";
const WORKFLOW_KEYS = new Set(["name", "rules", "auto_cancel"]);

/**
 * The jobs a job with no `needs` waits for. GitLab holds a job until every job in every earlier stage has finished, including jobs that themselves start early through `needs`, so the job depends on all of them.
 */
function implicitNeedsOf(
  jobs: ReadonlyMap<string, Record<string, unknown>>,
  stages: readonly string[],
): ReadonlyMap<string, readonly string[]> {
  const order = [FIRST_STAGE, ...stages, LAST_STAGE];
  const stageOf = (job: Record<string, unknown>): string =>
    typeof job.stage === "string" ? job.stage : DEFAULT_JOB_STAGE;
  const byStage = new Map<string, string[]>();
  for (const [name, job] of jobs) {
    byStage.set(stageOf(job), [...(byStage.get(stageOf(job)) ?? []), name]);
  }
  const needs = new Map<string, readonly string[]>();
  for (const [name, job] of jobs) {
    const position = order.indexOf(stageOf(job));
    if (position === -1) {
      return fail(
        [name, "stage"],
        `the stage ${JSON.stringify(stageOf(job))}, which is not declared`,
      );
    }
    const earlier = order.slice(0, position).flatMap((stage) => byStage.get(stage) ?? []);
    const optional = earlier.find((other) => {
      const candidate = jobs.get(other);

      return candidate !== undefined && ("rules" in candidate || "when" in candidate);
    });
    if (optional !== undefined) {
      return fail(
        [name],
        `a job with no needs that waits on ${JSON.stringify(optional)}, which has rules or a when and so may not run, because the model's needs would wait on a job GitLab skips`,
      );
    }
    needs.set(name, earlier);
  }

  return needs;
}

/**
 * The settings GitLab applies to every job that does not set them itself, which a file writes either at the top level or under `default`. They have no place in the model as pipeline settings, so each job that inherits one carries it, which keeps its meaning.
 */
const DEFAULT_KEYS: ReadonlySet<string> = new Set([
  "image",
  "services",
  "before_script",
  "after_script",
  "cache",
  "artifacts",
  "retry",
]);

function defaultsOf(document: Record<string, unknown>): Record<string, unknown> {
  const under = isRecord(document.default) ? document.default : {};
  for (const key of Object.keys(under)) {
    // `tags` is the model's runner label, which a job without its own takes from here.
    if (!DEFAULT_KEYS.has(key) && key !== "tags") {
      fail(
        ["default", key],
        `the default setting ${JSON.stringify(key)}, which has no place in the model`,
      );
    }
  }
  const collected: Record<string, unknown> = {};
  if (under.tags !== undefined) collected.tags = under.tags;
  for (const key of DEFAULT_KEYS) {
    const value = key in under ? under[key] : document[key];
    if (value !== undefined) collected[key] = value;
  }

  return collected;
}

/**
 * Whether a job takes the pipeline default for a key: not when it sets the key itself, nor when its `inherit.default` is `false` or a list that omits the key.
 */
function inheritsDefault(key: string, job: Record<string, unknown>): boolean {
  if (key in job) return false;
  const inherit = isRecord(job.inherit) ? job.inherit.default : undefined;
  if (Array.isArray(inherit)) return inherit.includes(key);

  return inherit !== false;
}

/**
 * The defaults a job carries as native settings. Runner tags are not among them: they become the job's runner labels.
 */
function inheritedDefaults(
  defaults: Readonly<Record<string, unknown>>,
  job: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(defaults).filter(([key]) => key !== "tags" && inheritsDefault(key, job)),
  );
}

const DEFAULT_GROUP = "{{ workflow }}-{{ refName }}";

function importConfiguration(file: EmittedFile): Pipeline {
  const { value, comments } = readYaml(file.content);
  const document = recordAt(value, [], "the configuration");
  // A file with no `workflow` section has GitLab's default pipeline sources, which the model states as no triggers.
  const workflow =
    document.workflow === undefined
      ? {}
      : recordAt(document.workflow, ["workflow"], "the workflow");
  for (const key of Object.keys(workflow)) {
    if (!WORKFLOW_KEYS.has(key)) fail(["workflow", key], `a workflow key ${JSON.stringify(key)}`);
  }
  const rules = Array.isArray(workflow.rules) ? workflow.rules : [];
  if (workflow.rules !== undefined && rules.length === 0) {
    return fail(["workflow", "rules"], "workflow rules that are not a non-empty list");
  }

  const stages = document.stages === undefined ? DEFAULT_STAGES : stringList(document.stages);
  if (stages === undefined) return fail(["stages"], "stages that are not a list of names");

  const jobs = new Map<string, Record<string, unknown>>();
  const carried: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(document)) {
    if (key === "workflow" || key === "stages" || key === "variables") continue;
    if (DEFAULT_KEYS.has(key) || key === "default") continue;
    // Top-level GitLab settings and hidden-job templates change what the whole file does, so they are carried at pipeline level and another provider rejects the pipeline rather than run the jobs without them.
    if (RESERVED_NAMES.has(key) || key.startsWith(".")) {
      carried[key] = entry;
      continue;
    }
    jobs.set(key, recordAt(entry, [key], "a job"));
  }
  if (jobs.size === 0) return fail([], "a configuration with no jobs");

  const names = [...jobs.keys()];
  const generated = uniqueJobIds(names);
  const idOf = new Map(names.map((name, index) => [name, generated[index] ?? name]));
  const globals =
    document.variables === undefined ? {} : (neutralVariables(document.variables, new Set()) ?? {});
  const context: JobContext = {
    comments,
    idOf,
    implicitNeeds: implicitNeedsOf(jobs, stages),
    globals,
    defaults: defaultsOf(document),
  };
  const jobEntries = names.map((name) => [name, jobAt(name, jobs.get(name), context)] as const);

  // Concurrency is written onto every job, so it is read back only when every job agrees.
  const everyJob = [...jobs.values()];
  const autoCancel =
    isRecord(workflow.auto_cancel) && workflow.auto_cancel.on_new_commit === "interruptible";
  const allInterruptible = everyJob.every((job) => job.interruptible === true);
  const groups = new Set(everyJob.map((job) => job.resource_group));
  const [group] = [...groups];
  let concurrency: Record<string, unknown> | undefined;
  let consumed: string | undefined;
  if (autoCancel && allInterruptible) {
    concurrency = { group: DEFAULT_GROUP, cancelInProgress: true };
    consumed = "interruptible";
  } else if (groups.size === 1 && typeof group === "string") {
    const text = neutralText(group, new Set());
    if (text !== undefined) {
      concurrency = { group: text, cancelInProgress: false };
      consumed = "resource_group";
    }
  }
  if (concurrency === undefined && workflow.auto_cancel !== undefined) {
    return fail(
      ["workflow", "auto_cancel"],
      "an auto-cancel setting that no job's interruptible matches",
    );
  }
  const description = comments.get("workflow");
  const env =
    document.variables === undefined ? undefined : neutralVariables(document.variables, new Set());
  if (document.variables !== undefined && env === undefined) {
    return fail(["variables"], "variables that reference something outside the neutral vocabulary");
  }

  return validateImported(PROVIDER, {
    name: typeof workflow.name === "string" ? workflow.name : "gitlab-ci",
    ...(description === undefined ? {} : { description }),
    triggers: rules.map((rule, index) => triggerAt(rule, ["workflow", "rules", index])),
    ...(concurrency === undefined ? {} : { concurrency }),
    ...(env === undefined ? {} : { env }),
    ...(Object.keys(carried).length === 0 ? {} : { native: { [PROVIDER]: carried } }),
    jobs: Object.fromEntries(
      jobEntries.map(([name, job]) => {
        const id = idOf.get(name) ?? name;
        const { native, ...rest } = job;
        const gitlab = isRecord(native) ? native[PROVIDER] : undefined;
        const kept = isRecord(gitlab)
          ? Object.fromEntries(Object.entries(gitlab).filter(([key]) => key !== consumed))
          : {};

        return [
          id,
          Object.keys(kept).length === 0 ? rest : { ...rest, native: { [PROVIDER]: kept } },
        ];
      }),
    ),
  });
}

/**
 * Reads a `.gitlab-ci.yml` into the neutral model: the inverse of `createGitLabCiCompiler`.
 *
 * Read: workflow rules that select a pipeline source with an optional branch filter, stages and `needs` (a job with no `needs` waits for the whole stage before it, as GitLab runs it), tags, matrix, timeout, environment, variables, `rules` that are one `if` over the neutral variables as anchored case-insensitive matches (and `when: always`), concurrency written as `interruptible` or a shared `resource_group`, and the script, one `run` step per line, after a `checkout` that carries `GIT_DEPTH`. What GitLab owns and the model carries verbatim is kept: any other job key, and a setting with no neutral form, go into the job's `native` mapping. Top-level settings and hidden-job templates are carried at pipeline level. What has nowhere to be carried is rejected with its JSON pointer: a file with no workflow rules, an `extends`, a downstream trigger, top-level `default` a job does not inherit, a `needs` entry with options, and a call to this tool's runner. A gate and an ordinary dependent job are written the same, so a gate reads back as an ordinary job.
 */
export function createGitLabCiImporter(): PipelineImporter {
  return {
    provider: PROVIDER,
    async import(file, options): Promise<Pipeline> {
      options?.signal?.throwIfAborted();

      return Promise.resolve(importConfiguration(file));
    },
  };
}
