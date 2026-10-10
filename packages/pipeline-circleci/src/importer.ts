import {
  UnsupportedNativeError,
  findTemplateTokens,
  jsonPointerOf,
  slugOf,
  uniqueJobIds,
  validateImported,
  type EmittedFile,
  type Pipeline,
  type PipelineImporter,
} from "@ci-adapters/pipeline-contract";
import { readYaml } from "@ci-adapters/yaml-emit";

import { CONFIG_VERSION, CONTEXT_OF_VALUE, EXECUTOR_KEYS, PROVIDER } from "./vocabulary.ts";

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

/**
 * A call of this tool's runner, which is what a wrapper-form file contains where steps were. It carries none of the steps, so there is nothing to import from it.
 */
const WRAPPER_CALL = /\srun --pipeline \S+ --job \S+ --steps \d+-\d+/;

/** A shell reference to a variable CircleCI defines, which another provider's runner does not. */
const RUNTIME_VARIABLE = /\$\{?CIRCLE_[A-Z0-9_]+/;

const SUBSTITUTION = /<<\s*([^>]*?)\s*>>/g;
const PARAMETER_PREFIX = "parameters.";
const AXIS = /^[A-Za-z][A-Za-z0-9_]*$/;
const MATRIX_NAME_SUFFIX = /^(.*) \(((?:<< matrix\.[A-Za-z0-9_]+ >>(?:, )?)+)\)$/;

/**
 * An environment value with each CircleCI substitution that names a neutral pipeline value or a matrix parameter replaced by its token, or `undefined` when the value has no neutral form.
 */
function neutralText(value: unknown, axes: ReadonlySet<string>): string | undefined {
  if (!isScalar(value)) return undefined;
  const text = String(value);
  if (findTemplateTokens(text).length > 0) return undefined;
  let foreign = 0;
  const neutral = text.replace(SUBSTITUTION, (whole, expression: string) => {
    const key = CONTEXT_OF_VALUE.get(`<< ${expression} >>`);
    if (key !== undefined) return `{{ ${key} }}`;
    if (expression.startsWith(PARAMETER_PREFIX)) {
      const axis = expression.slice(PARAMETER_PREFIX.length);
      if (axes.has(axis) && AXIS.test(axis)) return `{{ matrix.${axis} }}`;
    }
    foreign += 1;

    return whole;
  });

  return foreign === 0 ? neutral : undefined;
}

function stepAt(
  value: unknown,
  pointer: Pointer,
  axes: ReadonlySet<string>,
): Record<string, unknown> {
  if (value === "checkout") return { kind: "checkout" };
  if (typeof value === "string") {
    // A bare step name is a step with no arguments.
    return { kind: "provider", provider: PROVIDER, native: { [value]: {} } };
  }
  const entry = recordAt(value, pointer, "a step");
  const keys = Object.keys(entry);
  if (keys.length !== 1) return fail(pointer, "a step with more than one key");
  const [key] = keys;
  if (key === "checkout") {
    const settings = entry.checkout;
    if (isRecord(settings) && Object.keys(settings).length === 1 && settings.method === "full") {
      return { kind: "checkout", fetchDepth: "full" };
    }
  }
  if (key === "run") {
    const run = entry.run;
    const settings = typeof run === "string" ? { command: run } : isRecord(run) ? run : undefined;
    if (settings !== undefined && typeof settings.command === "string") {
      if (WRAPPER_CALL.test(settings.command)) {
        return fail(
          [...pointer, "run", "command"],
          "a call to this tool's runner, which stands for steps held in the pipeline file it names; import that file",
        );
      }
      const known = new Set(["name", "command", "environment", "working_directory"]);
      const environment = settings.environment;
      const neutralEnvironment =
        environment === undefined
          ? undefined
          : isRecord(environment)
            ? Object.fromEntries(
                Object.entries(environment).map(([name, text]) => [name, neutralText(text, axes)]),
              )
            : null;
      // CircleCI fills `<< >>` in before the shell sees a command, which a command the model carries verbatim cannot say.
      const substituted = [settings.command, settings.name, settings.working_directory].some(
        (text) =>
          typeof text === "string" &&
          (new RegExp(SUBSTITUTION.source).test(text) || RUNTIME_VARIABLE.test(text)),
      );
      const portable =
        !substituted &&
        Object.keys(settings).every((name) => known.has(name)) &&
        (settings.name === undefined || typeof settings.name === "string") &&
        (settings.working_directory === undefined ||
          typeof settings.working_directory === "string") &&
        neutralEnvironment !== null &&
        Object.values(neutralEnvironment ?? {}).every((text) => text !== undefined);
      if (portable) {
        return {
          kind: "run",
          ...(typeof settings.name === "string" ? { name: settings.name } : {}),
          run: settings.command,
          ...(neutralEnvironment === undefined ? {} : { env: neutralEnvironment }),
          ...(typeof settings.working_directory === "string"
            ? { workingDirectory: settings.working_directory }
            : {}),
        };
      }
    }
  }

  return { kind: "provider", provider: PROVIDER, native: entry };
}

interface Definition {
  readonly executor: Record<string, unknown>;
  readonly steps: unknown[];
  readonly environment: unknown;
  readonly parameters: Record<string, unknown> | undefined;
}

function definitionAt(key: string, value: unknown): Definition {
  const pointer: Pointer = ["jobs", key];
  const job = recordAt(value, pointer, "a job");
  if (!Array.isArray(job.steps) || job.steps.length === 0) {
    return fail([...pointer, "steps"], "a job with no steps");
  }
  const executorKeys = Object.keys(job).filter((name) => EXECUTOR_KEYS.has(name));
  if (executorKeys.length !== 1) {
    return fail(pointer, "a job without exactly one of docker, machine, macos and executor");
  }
  if (job.executor !== undefined) {
    return fail(
      [...pointer, "executor"],
      "a job that names an executor defined elsewhere, which the model does not resolve",
    );
  }
  const { steps, environment, parameters, ...executor } = job;

  return {
    executor,
    steps,
    environment,
    parameters:
      parameters === undefined
        ? undefined
        : recordAt(parameters, [...pointer, "parameters"], "parameters"),
  };
}

interface WorkflowEntry {
  readonly key: string;
  readonly name: string | undefined;
  readonly requires: readonly unknown[] | undefined;
  readonly matrix: Record<string, unknown> | undefined;
  readonly alias: string | undefined;
  readonly pointer: Pointer;
}

function entryAt(value: unknown, pointer: Pointer): WorkflowEntry {
  if (typeof value === "string") {
    return {
      key: value,
      name: undefined,
      requires: undefined,
      matrix: undefined,
      alias: undefined,
      pointer,
    };
  }
  const wrapper = recordAt(value, pointer, "a workflow job");
  const [key] = Object.keys(wrapper);
  if (key === undefined || Object.keys(wrapper).length !== 1) {
    return fail(pointer, "a workflow job that is not a single job name");
  }
  const at: Pointer = [...pointer, key];
  const config = wrapper[key] === null ? {} : recordAt(wrapper[key], at, "a workflow job");
  const allowed = new Set(["name", "requires", "matrix"]);
  for (const name of Object.keys(config)) {
    if (!allowed.has(name)) fail([...at, name], `the workflow job setting ${JSON.stringify(name)}`);
  }
  if (config.name !== undefined && typeof config.name !== "string") {
    return fail([...at, "name"], "a name that is not text");
  }
  if (config.requires !== undefined && !Array.isArray(config.requires)) {
    return fail([...at, "requires"], "requires that is not a list");
  }
  const matrix =
    config.matrix === undefined
      ? undefined
      : recordAt(config.matrix, [...at, "matrix"], "a matrix");
  if (matrix !== undefined) {
    for (const name of Object.keys(matrix)) {
      if (name !== "alias" && name !== "parameters") {
        fail([...at, "matrix", name], `the matrix setting ${JSON.stringify(name)}`);
      }
    }
  }

  return {
    key,
    name: typeof config.name === "string" ? config.name : undefined,
    requires: Array.isArray(config.requires) ? config.requires : undefined,
    matrix,
    alias: typeof matrix?.alias === "string" ? matrix.alias : undefined,
    pointer: at,
  };
}

const PUSH_BRANCH = "<< pipeline.git.branch >>";

/**
 * The branches of a workflow `when` the compiler writes: one equality with the branch, or an `or` of them.
 */
function branchesOf(condition: unknown, pointer: Pointer): string[] {
  const equal = (value: unknown): string | undefined => {
    if (!isRecord(value) || Object.keys(value).length !== 1) return undefined;
    const pair: unknown = value.equal;
    if (!Array.isArray(pair) || pair.length !== 2) return undefined;
    const name: unknown = pair[0];
    const subject: unknown = pair[1];

    if (typeof name === "string" && subject === PUSH_BRANCH) return name;

    return typeof subject === "string" && name === PUSH_BRANCH ? subject : undefined;
  };
  const single = equal(condition);
  if (single !== undefined) return [single];
  if (isRecord(condition) && Array.isArray(condition.or)) {
    const alternatives: unknown[] = condition.or;
    const names = alternatives.map(equal);
    if (names.every((name): name is string => name !== undefined) && names.length > 0) {
      return names;
    }
  }

  return fail(pointer, "a workflow condition that is not a branch equality or a list of them");
}

function importConfiguration(file: EmittedFile): Pipeline {
  const { value, comments } = readYaml(file.content);
  const document = recordAt(value, [], "the configuration");
  for (const key of Object.keys(document)) {
    if (key !== "version" && key !== "jobs" && key !== "workflows") {
      fail([key], `the ${key} setting, which has no place in the model`);
    }
  }
  if (document.version !== CONFIG_VERSION) {
    return fail(["version"], "a configuration version other than the one the compiler writes");
  }
  const jobs = recordAt(document.jobs, ["jobs"], "the jobs");
  const workflows = recordAt(document.workflows, ["workflows"], "the workflows");
  const names = Object.keys(workflows);
  const [workflowName] = names;
  if (workflowName === undefined || names.length !== 1) {
    return fail(
      ["workflows"],
      "a configuration that does not have exactly one workflow, because the model has one job graph",
    );
  }
  if (slugOf(workflowName) !== workflowName) {
    return fail(
      ["workflows", workflowName],
      "a workflow name the compiler would rewrite, because it writes the lower-case, hyphen-separated form of the pipeline name",
    );
  }
  const workflow = recordAt(workflows[workflowName], ["workflows", workflowName], "the workflow");
  for (const key of Object.keys(workflow)) {
    if (key !== "when" && key !== "jobs") {
      fail(["workflows", workflowName, key], `the workflow setting ${JSON.stringify(key)}`);
    }
  }
  if (!Array.isArray(workflow.jobs) || workflow.jobs.length === 0) {
    return fail(["workflows", workflowName, "jobs"], "a workflow with no jobs");
  }

  const entries = workflow.jobs.map((entry: unknown, index) =>
    entryAt(entry, ["workflows", workflowName, "jobs", index]),
  );
  const used = new Set(entries.map((entry) => entry.key));
  for (const key of Object.keys(jobs)) {
    if (!used.has(key)) fail(["jobs", key], "a job that no workflow runs");
  }
  for (const entry of entries) {
    if (!(entry.key in jobs)) {
      fail(entry.pointer, `the job ${JSON.stringify(entry.key)}, which this file does not define`);
    }
  }

  const ids = uniqueJobIds(entries.map((entry) => entry.key));
  // A job is required by its alias when it has a matrix and by its name otherwise.
  const idOfName = new Map<string, string>();
  for (const [index, entry] of entries.entries()) {
    const label =
      entry.matrix === undefined
        ? (entry.name ?? entry.key)
        : (entry.alias ?? entry.name ?? entry.key);
    idOfName.set(label, ids[index] ?? entry.key);
  }

  const jobsOut: [string, Record<string, unknown>][] = [];
  for (const [index, entry] of entries.entries()) {
    const id = ids[index] ?? entry.key;
    const definition = definitionAt(entry.key, jobs[entry.key]);
    const parameters = isRecord(entry.matrix?.parameters) ? entry.matrix.parameters : undefined;
    const axes = new Set(Object.keys(parameters ?? {}));
    if (entry.matrix !== undefined && parameters === undefined) {
      return fail([...entry.pointer, "matrix"], "a matrix with no parameters");
    }
    for (const [name, declaration] of Object.entries(definition.parameters ?? {})) {
      const at: Pointer = ["jobs", entry.key, "parameters", name];
      if (!axes.has(name)) {
        return fail(at, "a job parameter that no matrix supplies");
      }
      // The compiler declares each axis by its type alone, so anything more would be lost when it writes the job back.
      if (!isRecord(declaration) || Object.keys(declaration).join() !== "type") {
        return fail(at, "a parameter declaration with settings beyond its type");
      }
    }
    const matrix =
      parameters === undefined
        ? undefined
        : Object.fromEntries(
            Object.entries(parameters).map(([axis, values]) => {
              if (!Array.isArray(values) || values.length === 0 || !values.every(isScalar)) {
                return fail(
                  [...entry.pointer, "matrix", "parameters", axis],
                  "a matrix axis that is not a list of scalars",
                );
              }

              return [axis, values];
            }),
          );

    let name = entry.name ?? entry.key;
    if (matrix !== undefined && entry.name !== undefined) {
      const suffix = MATRIX_NAME_SUFFIX.exec(entry.name);
      const written = [...(suffix?.[2] ?? "").matchAll(/matrix\.([A-Za-z0-9_]+)/g)].map(
        (part) => part[1],
      );
      if (suffix?.[1] === undefined || JSON.stringify(written) !== JSON.stringify([...axes])) {
        return fail(
          [...entry.pointer, "name"],
          "a matrix job name that does not end in its axis values in order",
        );
      }
      name = suffix[1];
    }

    const requires = (entry.requires ?? []).map((required, position) => {
      const at: Pointer = [...entry.pointer, "requires", position];
      const [label, status] = isRecord(required)
        ? [Object.keys(required)[0], Object.values(required)[0]]
        : [required, undefined];
      if (typeof label !== "string") return fail(at, "a requires entry that is not a job name");
      const target = idOfName.get(label);
      if (target === undefined) {
        return fail(
          at,
          `a requires entry ${JSON.stringify(label)} that is not a job in this workflow`,
        );
      }
      if (status !== undefined && status !== "terminal") {
        return fail(at, `the required status ${JSON.stringify(status)}`);
      }

      return { target, terminal: status === "terminal" };
    });
    const terminal = requires.length > 0 && requires.every((required) => required.terminal);
    if (requires.some((required) => required.terminal) && !terminal) {
      return fail(
        [...entry.pointer, "requires"],
        "requires that mix a terminal status with others",
      );
    }

    const environment =
      definition.environment === undefined
        ? undefined
        : isRecord(definition.environment)
          ? Object.fromEntries(
              Object.entries(definition.environment).map(([variable, text]) => {
                const neutral = neutralText(text, axes);
                if (neutral === undefined) {
                  return fail(
                    ["jobs", entry.key, "environment", variable],
                    "an environment value with a substitution outside the neutral vocabulary",
                  );
                }

                return [variable, neutral];
              }),
            )
          : fail(["jobs", entry.key, "environment"], "an environment that is not a mapping");

    const description = comments.get(`jobs/${entry.key}`);
    jobsOut.push([
      id,
      {
        name,
        ...(description === undefined ? {} : { description }),
        runsOn: [],
        ...(requires.length === 0 ? {} : { needs: requires.map((required) => required.target) }),
        ...(terminal ? { needsPolicy: "always" } : {}),
        ...(environment === undefined ? {} : { env: environment }),
        ...(matrix === undefined ? {} : { matrix }),
        steps: definition.steps.map((step, position) =>
          stepAt(step, ["jobs", entry.key, "steps", position], axes),
        ),
        native: { [PROVIDER]: definition.executor },
      },
    ]);
  }

  const description = comments.get("workflows");
  const branches =
    workflow.when === undefined
      ? undefined
      : branchesOf(workflow.when, ["workflows", workflowName, "when"]);

  return validateImported(PROVIDER, {
    name: workflowName,
    ...(description === undefined ? {} : { description }),
    triggers: [{ kind: "push", ...(branches === undefined ? {} : { branches }) }],
    jobs: Object.fromEntries(jobsOut),
  });
}

/**
 * Reads a `.circleci/config.yml` into the neutral model: the inverse of `createCircleCiCompiler`.
 *
 * Read: one workflow, whose name is the pipeline's, with an optional branch condition as the push trigger; its jobs, each with the executor and other job keys kept on `native.circleci`, `requires` as `needs` (every requirement at the `terminal` status as an always-running job), a matrix with its alias and the axis values in the display name, run, checkout and other steps, and environments over the sha, ref and run id. A job with no runner label is how the model states that the executor is the job's own. What CircleCI owns and the model carries verbatim is kept: any step that is not a plain run or checkout becomes a `provider` step. What has nowhere to be carried is rejected with its JSON pointer: orbs, commands, executors and other top-level settings, more than one workflow, a workflow name the compiler would rewrite, workflow job settings such as `filters` and `context`, a job no workflow runs, an environment substitution outside the neutral vocabulary, and a call to this tool's runner.
 */
export function createCircleCiImporter(): PipelineImporter {
  return {
    provider: PROVIDER,
    async import(file, options): Promise<Pipeline> {
      options?.signal?.throwIfAborted();

      return Promise.resolve(importConfiguration(file));
    },
  };
}
