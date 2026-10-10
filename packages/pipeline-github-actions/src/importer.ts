import {
  JOB_ID_PATTERN,
  UnsupportedNativeError,
  findTemplateTokens,
  jsonPointerOf,
  validateImported,
  type EmittedFile,
  type Pipeline,
  type PipelineImporter,
  type PredicateNode,
} from "@ci-adapters/pipeline-contract";
import { commentPath, readYaml } from "@ci-adapters/yaml-emit";

import { ExpressionError, parseIf } from "./expression.ts";
import {
  CHECKOUT_ACTION,
  CONTEXT_OF_EXPRESSION,
  GATE_STEP,
  PROVIDER,
  SCOPE_OF_PERMISSION,
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

function onlyKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  pointer: Pointer,
  what: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail([...pointer, key], `${what} key ${JSON.stringify(key)}`);
  }
}

function stringsAt(value: unknown, pointer: Pointer, what: string): string[] {
  const list = typeof value === "string" ? [value] : value;
  if (!Array.isArray(list) || list.length === 0) {
    return fail(pointer, `${what} that is not a string or a non-empty list of strings`);
  }
  const strings = list.filter((item): item is string => typeof item === "string");
  if (strings.length !== list.length) {
    return fail(pointer, `${what} with an entry that is not text`);
  }

  return strings;
}

function scalarText(value: unknown, pointer: Pointer, what: string): string {
  return isScalar(value) ? String(value) : fail(pointer, `${what} that is not text`);
}

/** A `${{ }}` expression. A `}` inside a quoted string, as in `format('v{0}', x)`, does not end it. */
const EXPRESSION = /\$\{\{\s*((?:[^}']|'[^']*')*?)\s*\}\}/g;
const AXIS = /^[A-Za-z][A-Za-z0-9_]*$/;
const MATRIX_PREFIX = "matrix.";

/**
 * A string value with each `${{ }}` replaced by the neutral token it stands for, or `undefined` when the value has no neutral form: an expression outside the neutral context vocabulary (a secret, a step output, a function), a matrix reference where no matrix is modelled, a value that is not text, or literal text that already looks like a token, which the model would read as a reference. A value with no neutral form is carried by the node that owns it, never rewritten.
 */
function neutralText(value: unknown, allowMatrix: boolean): string | undefined {
  if (!isScalar(value)) return undefined;
  const text = String(value);
  if (findTemplateTokens(text.replace(EXPRESSION, "")).length > 0) return undefined;
  let foreign = 0;
  const neutral = text.replace(EXPRESSION, (whole, expression: string) => {
    const key = CONTEXT_OF_EXPRESSION.get(expression);
    if (key !== undefined) return `{{ ${key} }}`;
    if (
      allowMatrix &&
      expression.startsWith(MATRIX_PREFIX) &&
      AXIS.test(expression.slice(MATRIX_PREFIX.length))
    ) {
      return `{{ ${expression} }}`;
    }
    foreign += 1;

    return whole;
  });

  // Anything of an expression that the pattern did not consume is one it could not read, so it is not neutral.
  return foreign === 0 && !neutral.includes("${{") ? neutral : undefined;
}

/**
 * An environment mapping with every value in neutral form, or `undefined` when the value is not a mapping or any value has no neutral form.
 */
function neutralEnv(value: unknown, allowMatrix: boolean): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const neutral: [string, string][] = [];
  for (const [key, entry] of Object.entries(value)) {
    const text = neutralText(entry, allowMatrix);
    if (text === undefined) return undefined;
    neutral.push([key, text]);
  }

  return Object.fromEntries(neutral);
}

/**
 * A permissions mapping in the model's scopes and levels, or `undefined` when it uses a shorthand, a scope or a level the model does not have.
 */
function neutralPermissions(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const neutral: [string, string][] = [];
  for (const [key, level] of Object.entries(value)) {
    const scope = SCOPE_OF_PERMISSION.get(key);
    if (scope === undefined) return undefined;
    if (level !== "none" && level !== "read" && level !== "write") return undefined;
    neutral.push([scope, level]);
  }

  return Object.fromEntries(neutral);
}

interface Comments {
  readonly at: (...segments: readonly string[]) => string | undefined;
}

function triggersAt(on: unknown, comments: Comments): Record<string, unknown>[] {
  const pointer: Pointer = ["on"];
  const events: [string, unknown][] =
    typeof on === "string"
      ? [[on, null]]
      : Array.isArray(on)
        ? stringsAt(on, pointer, "the trigger list").map((name): [string, unknown] => [name, null])
        : Object.entries(recordAt(on, pointer, "the triggers"));

  return events.flatMap(([event, config]): Record<string, unknown>[] => {
    const at: Pointer = [...pointer, event];
    const description = comments.at("on", event);
    const described = description === undefined ? {} : { description };
    const settings = config === null || config === undefined ? {} : recordAt(config, at, event);
    switch (event) {
      case "push":
      case "pull_request": {
        onlyKeys(settings, new Set(["branches"]), at, `a ${event} filter`);
        const names =
          settings.branches === undefined
            ? undefined
            : stringsAt(settings.branches, [...at, "branches"], "branches");
        // GitHub reads a branch as a glob, which the model's branch names are not, so another provider would take it literally.
        const pattern = names?.findIndex((name) => /[*?+[\]!]/.test(name));
        if (pattern !== undefined && pattern !== -1) {
          fail([...at, "branches", pattern], "a branch pattern, which the model has no form for");
        }
        const branches = names === undefined ? {} : { branches: names };

        return [{ kind: event === "push" ? "push" : "pullRequest", ...branches, ...described }];
      }
      case "workflow_dispatch":
        onlyKeys(settings, new Set(), at, "a workflow_dispatch setting");

        return [{ kind: "manual", ...described }];
      case "schedule": {
        const entries = Array.isArray(config) ? config : fail(at, "a schedule that is not a list");

        return entries.map((entry, index): Record<string, unknown> => {
          const cron = recordAt(entry, [...at, index], "a schedule entry");
          onlyKeys(cron, new Set(["cron"]), [...at, index], "a schedule entry");
          if (typeof cron.cron !== "string") {
            return fail([...at, index, "cron"], "a cron that is not text");
          }

          return { kind: "schedule", cron: cron.cron };
        });
      }
      default:
        return fail(at, `the ${event} trigger`);
    }
  });
}

interface IfResult {
  readonly always: boolean;
  readonly when: PredicateNode | undefined;
  /** The expression kept as written when the model has no construct for it. */
  readonly raw: string | undefined;
}

/**
 * Reads an `if`. An expression the model cannot express is returned as written, for the node that owns it to carry.
 */
function ifAt(
  value: unknown,
  pointer: Pointer,
  options: Readonly<{ leadingAlways: boolean; allowMatrix: boolean }>,
): IfResult {
  if (value === undefined) return { always: false, when: undefined, raw: undefined };
  const text = scalarText(value, pointer, "a condition");
  try {
    const parsed = parseIf(text, options);

    return { always: parsed.always, when: parsed.condition, raw: undefined };
  } catch (error) {
    if (!(error instanceof ExpressionError)) throw error;

    return { always: false, when: undefined, raw: text };
  }
}

/**
 * A call of this tool's runner, which is what a wrapper-form file contains where steps were. It carries none of the steps, so there is nothing to import from it.
 */
const WRAPPER_CALL = /\srun --pipeline \S+ --job \S+ --steps \d+-\d+/;

/** A shell reference to a variable the runner defines, which another provider's runner does not. */
const RUNTIME_VARIABLE = /\$\{?(GITHUB|RUNNER|ACTIONS)_[A-Z_]+/;

const RUN_STEP_KEYS = new Set(["name", "if", "run", "env", "working-directory"]);

function checkoutDepthOf(
  step: Record<string, unknown>,
): { readonly fetchDepth?: "full" | number } | undefined {
  const keys = Object.keys(step).filter((key) => key !== "name" && key !== "if" && key !== "uses");
  if (keys.length === 0) return {};
  if (keys.length !== 1 || keys[0] !== "with") return undefined;
  const { with: settings } = step;
  if (!isRecord(settings)) return undefined;
  const entries = Object.entries(settings);
  if (entries.length !== 1 || entries[0]?.[0] !== "fetch-depth") return undefined;
  const depth = entries[0][1];
  if (depth === 0) return { fetchDepth: "full" };

  return typeof depth === "number" && Number.isInteger(depth) && depth > 0
    ? { fetchDepth: depth }
    : undefined;
}

/**
 * A step. A `run` with only the keys, values and condition the model has, and no `${{ }}` or runner variable in its command, becomes a `run` step and the pinned checkout becomes a `checkout`; every other step is GitHub's and is carried whole as a `provider` step, so nothing in it is dropped or reinterpreted.
 */
function stepAt(
  value: unknown,
  pointer: Pointer,
  description: string | undefined,
  allowMatrix: boolean,
): Record<string, unknown> {
  const step = recordAt(value, pointer, "a step");
  const named =
    step.name === undefined
      ? {}
      : { name: scalarText(step.name, [...pointer, "name"], "a step name") };
  const described = description === undefined ? {} : { description };
  const condition = ifAt(step.if, [...pointer, "if"], { leadingAlways: false, allowMatrix });
  const when = condition.when === undefined ? {} : { when: condition.when };
  const hasRun = "run" in step;
  if (hasRun === "uses" in step) {
    return fail(pointer, "a step that has both or neither of run and uses");
  }

  if (hasRun && typeof step.run === "string" && WRAPPER_CALL.test(step.run)) {
    return fail(
      [...pointer, "run"],
      "a call to this tool's runner, which stands for steps held in the pipeline file it names; import that file",
    );
  }

  const env = step.env === undefined ? undefined : neutralEnv(step.env, allowMatrix);
  const directory = step["working-directory"];
  // GitHub evaluates `${{ }}` in a command before the shell sees it, which a command the model carries verbatim cannot say.
  const evaluated = (text: unknown): boolean =>
    typeof text === "string" && (text.includes("${{") || RUNTIME_VARIABLE.test(text));
  const portable =
    hasRun &&
    typeof step.run === "string" &&
    !evaluated(step.run) &&
    !evaluated(directory) &&
    Object.keys(step).every((key) => RUN_STEP_KEYS.has(key)) &&
    condition.raw === undefined &&
    (step.env === undefined || env !== undefined) &&
    (directory === undefined || typeof directory === "string");
  if (portable) {
    return {
      kind: "run",
      ...named,
      run: step.run,
      ...(env === undefined ? {} : { env }),
      ...(typeof directory === "string" ? { workingDirectory: directory } : {}),
      ...when,
      ...described,
    };
  }

  const checkout = step.uses === CHECKOUT_ACTION ? checkoutDepthOf(step) : undefined;
  if (checkout !== undefined && condition.raw === undefined) {
    return { kind: "checkout", ...named, ...checkout, ...when, ...described };
  }
  const native = Object.fromEntries(
    Object.entries(step).filter(([key]) => key !== "name" && key !== "if"),
  );

  return {
    kind: "provider",
    provider: PROVIDER,
    native: condition.raw === undefined ? native : { if: condition.raw, ...native },
    ...named,
    ...when,
    ...described,
  };
}

const JOB_KEYS = new Set([
  "name",
  "runs-on",
  "needs",
  "if",
  "timeout-minutes",
  "permissions",
  "environment",
  "env",
  "strategy",
  "steps",
]);

/**
 * The matrix axes of a `strategy` that is only a matrix of lists of scalars, or `undefined` when it has an `include`, an `exclude`, a computed axis or any other setting.
 */
function neutralMatrix(strategy: unknown): Record<string, unknown> | undefined {
  if (!isRecord(strategy)) return undefined;
  const keys = Object.keys(strategy);
  if (keys.length !== 1 || keys[0] !== "matrix" || !isRecord(strategy.matrix)) return undefined;
  const axes = Object.entries(strategy.matrix);
  const expressible = axes.every(
    ([axis, values]) =>
      AXIS.test(axis) &&
      axis !== "include" &&
      axis !== "exclude" &&
      Array.isArray(values) &&
      values.length > 0 &&
      values.every(isScalar),
  );

  return expressible ? Object.fromEntries(axes) : undefined;
}

function jobAt(id: string, value: unknown, comments: Comments): Record<string, unknown> {
  const pointer: Pointer = ["jobs", id];
  if (!JOB_ID_PATTERN.test(id)) {
    return fail(
      pointer,
      "a job id outside lower-case letters, digits and hyphens starting with a letter, which other jobs and expressions refer to by name",
    );
  }
  const job = recordAt(value, pointer, "a job");
  if ("uses" in job) return fail([...pointer, "uses"], "a job that calls a reusable workflow");
  if (job["runs-on"] === undefined) return fail(pointer, "a job with no runs-on");
  const labels = stringsAt(job["runs-on"], [...pointer, "runs-on"], "runs-on");
  if (labels.some((label) => label.includes("${{"))) {
    return fail([...pointer, "runs-on"], "a runner label computed by an expression");
  }
  if (!Array.isArray(job.steps) || job.steps.length === 0) {
    return fail([...pointer, "steps"], "a job with no steps");
  }

  const matrix = neutralMatrix(job.strategy);
  const allowMatrix = matrix !== undefined;
  const docSteps: unknown[] = job.steps;
  const condition = ifAt(job.if, [...pointer, "if"], { leadingAlways: true, allowMatrix: false });
  const gated =
    condition.always &&
    docSteps.length > 1 &&
    JSON.stringify(docSteps[0]) === JSON.stringify(GATE_STEP);
  const offset = gated ? 1 : 0;
  const steps = docSteps
    .slice(offset)
    .map((step, index) =>
      stepAt(
        step,
        [...pointer, "steps", index + offset],
        comments.at("jobs", id, "steps", String(index + offset)),
        allowMatrix,
      ),
    );

  // GitHub's own settings that the model has no form for stay on the job's `native` mapping, which the compiler writes back over the keys it generates.
  const native: Record<string, unknown> = {};
  if (condition.raw !== undefined) native.if = condition.raw;
  const timeout = job["timeout-minutes"];
  const timeoutPortable =
    timeout === undefined || (typeof timeout === "number" && Number.isInteger(timeout));
  if (!timeoutPortable) native["timeout-minutes"] = timeout;
  const permissions =
    job.permissions === undefined ? undefined : neutralPermissions(job.permissions);
  if (job.permissions !== undefined && permissions === undefined) {
    native.permissions = job.permissions;
  }
  const environmentPortable =
    typeof job.environment === "string" && !job.environment.includes("${{");
  if (job.environment !== undefined && !environmentPortable) native.environment = job.environment;
  const env = job.env === undefined ? undefined : neutralEnv(job.env, allowMatrix);
  if (job.env !== undefined && env === undefined) native.env = job.env;
  if (job.strategy !== undefined && matrix === undefined) native.strategy = job.strategy;
  for (const [key, entry] of Object.entries(job)) {
    if (!JOB_KEYS.has(key)) native[key] = entry;
  }

  const description = comments.at("jobs", id);
  const name = job.name === undefined ? id : scalarText(job.name, [...pointer, "name"], "a name");

  return {
    name,
    ...(description === undefined ? {} : { description }),
    runsOn: labels,
    ...(job.needs === undefined
      ? {}
      : { needs: stringsAt(job.needs, [...pointer, "needs"], "needs") }),
    ...(gated ? { needsPolicy: "gate" } : condition.always ? { needsPolicy: "always" } : {}),
    ...(condition.when === undefined ? {} : { when: condition.when }),
    ...(timeout !== undefined && timeoutPortable ? { timeoutMinutes: timeout } : {}),
    ...(permissions === undefined ? {} : { permissions }),
    ...(environmentPortable && typeof job.environment === "string"
      ? { environment: job.environment }
      : {}),
    ...(env === undefined ? {} : { env }),
    ...(matrix === undefined ? {} : { matrix }),
    steps,
    ...(Object.keys(native).length === 0 ? {} : { native: { [PROVIDER]: native } }),
  };
}

const WORKFLOW_KEYS = new Set(["name", "on", "permissions", "concurrency", "env", "jobs"]);

function nameOfPath(path: string): string {
  const file = path.split("/").at(-1) ?? path;

  return file.replace(/\.ya?ml$/, "");
}

function concurrencyAt(
  value: unknown,
  description: string | undefined,
): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  const pointer: Pointer = ["concurrency"];
  const described = description === undefined ? {} : { description };
  const group = (text: unknown, at: Pointer): string =>
    neutralText(text, false) ??
    fail(at, "a concurrency group with an expression outside the neutral context vocabulary");
  if (typeof value === "string") {
    return { group: group(value, pointer), cancelInProgress: false, ...described };
  }
  const settings = recordAt(value, pointer, "concurrency");
  onlyKeys(settings, new Set(["group", "cancel-in-progress"]), pointer, "a concurrency");
  const cancel = settings["cancel-in-progress"];
  if (cancel !== undefined && typeof cancel !== "boolean") {
    return fail(
      [...pointer, "cancel-in-progress"],
      "a cancel-in-progress computed by an expression",
    );
  }

  return {
    group: group(settings.group, [...pointer, "group"]),
    cancelInProgress: cancel ?? false,
    ...described,
  };
}

function importWorkflow(file: EmittedFile): Pipeline {
  const { value, comments: table } = readYaml(file.content);
  const comments: Comments = {
    at: (...segments) => table.get(commentPath(...segments)),
  };
  const workflow = recordAt(value, [], "the workflow");
  onlyKeys(workflow, WORKFLOW_KEYS, [], "a workflow");
  if (workflow.on === undefined) return fail([], "a workflow with no triggers");
  const jobs = recordAt(workflow.jobs, ["jobs"], "the jobs");
  const description = comments.at("name");
  const permissions =
    workflow.permissions === undefined ? undefined : neutralPermissions(workflow.permissions);
  if (workflow.permissions !== undefined && permissions === undefined) {
    return fail(["permissions"], "permissions in a form the model has no scope or level for");
  }
  const env = workflow.env === undefined ? undefined : neutralEnv(workflow.env, false);
  if (workflow.env !== undefined && env === undefined) {
    return fail(
      ["env"],
      "a workflow environment with an expression outside the neutral vocabulary",
    );
  }
  const concurrency = concurrencyAt(workflow.concurrency, comments.at("concurrency"));

  return validateImported(PROVIDER, {
    name: typeof workflow.name === "string" ? workflow.name : nameOfPath(file.path),
    ...(description === undefined ? {} : { description }),
    triggers: triggersAt(workflow.on, comments),
    ...(permissions === undefined ? {} : { permissions }),
    ...(concurrency === undefined ? {} : { concurrency }),
    ...(env === undefined ? {} : { env }),
    jobs: Object.fromEntries(
      Object.entries(jobs).map(([id, job]) => [id, jobAt(id, job, comments)]),
    ),
  });
}

/**
 * Reads a GitHub Actions workflow into the neutral model: the inverse of `createGitHubActionsCompiler`.
 *
 * Read: triggers (push and pull_request with a branch list, workflow_dispatch, schedule), permissions, concurrency, environments, jobs with `needs`, matrix axes, conditions, timeouts and steps. What GitHub owns and the model carries verbatim is kept, not dropped: a job key the model has no field for, a setting with no neutral form (an `include` matrix, an expression outside the neutral context vocabulary, a permission shorthand) and a condition with no neutral form go into the job's `native` mapping, and a step that is not a plain `run` or the pinned checkout becomes a `provider` step. What has nowhere to be carried is rejected with its JSON pointer in the workflow: a trigger filter other than branches, an event the model has no trigger for, a reusable-workflow job, a runner label computed by an expression, a workflow-level key or environment with no neutral form, and a call to this tool's runner. A file with no `name` is named for its file.
 */
export function createGitHubActionsImporter(): PipelineImporter {
  return {
    provider: PROVIDER,
    async import(file, options): Promise<Pipeline> {
      options?.signal?.throwIfAborted();

      return Promise.resolve(importWorkflow(file));
    },
  };
}
