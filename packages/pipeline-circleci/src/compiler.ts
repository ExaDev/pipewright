import {
  UnsupportedFeatureError,
  assertNever,
  expandMatrix,
  generatedHeaderLines,
  matrixValues,
  renderTemplate,
  slugOf,
  type CompileOptions,
  type EmittedFile,
  type Job,
  type MatrixCombination,
  type Pipeline,
  type PipelineCompiler,
  type Step,
  type TemplateToken,
} from "@pipewright/pipeline-contract";
import { renderYaml } from "@pipewright/yaml-emit";

import {
  CONFIG_VERSION,
  EXECUTOR_KEYS,
  FILE,
  PIPELINE_VALUE,
  PROVIDER,
  RESERVED_PARAMETERS,
} from "./vocabulary.ts";

function unsupported(pointer: string, feature: string): never {
  throw new UnsupportedFeatureError(PROVIDER, pointer, feature);
}

function isCollapsible(step: Step | undefined): boolean {
  return step?.kind === "run" && step.form !== "native";
}

function renderValue(text: string, pointer: string): string {
  return renderTemplate(text, (token: TemplateToken) => {
    if (token.kind === "matrix") return `<< parameters.${token.name} >>`;
    const value = PIPELINE_VALUE[token.key];
    if (value === undefined) {
      return unsupported(
        pointer,
        `the ${token.key} context value, which CircleCI has no pipeline value for`,
      );
    }

    return value;
  });
}

function envOf(
  env: Readonly<Record<string, string>> | undefined,
  pointer: string,
): Record<string, string> | undefined {
  if (env === undefined) return undefined;

  return Object.fromEntries(
    Object.entries(env).map(([key, value]) => [key, renderValue(value, `${pointer}/${key}`)]),
  );
}

/**
 * The step entries of one job. A `checkout` is CircleCI's own, a `run` becomes a `run` step, and in the wrapper form each contiguous run of portable steps is one call to the tool's runner for exactly those step indexes, with matrix axes passed as the job's parameters.
 */
function stepsOf(
  id: string,
  job: Job,
  wrapper: { readonly source: string; readonly toolCommand: string } | undefined,
): unknown[] {
  const entries: unknown[] = [];
  let index = 0;
  while (index < job.steps.length) {
    const step = job.steps[index];
    if (step === undefined) break;
    const pointer = `/jobs/${id}/steps/${String(index)}`;
    if (step.when !== undefined) {
      unsupported(
        `${pointer}/when`,
        "a step condition, because CircleCI step conditions are compile-time logic statements over pipeline values",
      );
    }

    if (step.kind === "checkout") {
      if (typeof step.fetchDepth === "number") {
        unsupported(
          `${pointer}/fetchDepth`,
          "a shallow checkout depth, which CircleCI's checkout step has no equivalent for",
        );
      }
      entries.push(step.fetchDepth === "full" ? { checkout: { method: "full" } } : "checkout");
      index += 1;
    } else if (step.kind === "provider") {
      if (step.provider !== PROVIDER) unsupported(pointer, `a step owned by ${step.provider}`);
      entries.push(step.native);
      index += 1;
    } else {
      if (wrapper !== undefined && isCollapsible(step)) {
        const from = index;
        while (isCollapsible(job.steps[index])) index += 1;
        const matrixFlags = Object.keys(job.matrix ?? {})
          .map((axis) => ` --matrix "${axis}=<< parameters.${axis} >>"`)
          .join("");
        entries.push({
          run: {
            name: `Run ${job.name}`,
            command: `${wrapper.toolCommand} run --pipeline ${wrapper.source} --job ${id} --steps ${String(from)}-${String(index - 1)}${matrixFlags}`,
          },
        });
      } else {
        const environment = envOf(step.env, `${pointer}/env`);
        entries.push({
          run: {
            ...(step.name === undefined ? {} : { name: step.name }),
            command: step.run,
            ...(environment === undefined ? {} : { environment }),
            ...(step.workingDirectory === undefined
              ? {}
              : { working_directory: step.workingDirectory }),
          },
        });
        index += 1;
      }
    }
  }

  return entries;
}

function parameterType(values: readonly (string | number | boolean)[], pointer: string): string {
  const types = new Set(values.map((value) => typeof value));
  if (types.size !== 1) unsupported(pointer, "a matrix axis mixing value types");
  const [type] = [...types];
  if (type === "string") return "string";
  if (type === "boolean") return "boolean";
  if (values.every((value) => Number.isInteger(value))) return "integer";

  return unsupported(pointer, "a non-integer numeric matrix axis");
}

interface JobInput {
  readonly id: string;
  readonly job: Job;
  readonly pipeline: Pipeline;
  readonly toolCommand: string | undefined;
  readonly source: string;
}

function jobOf({ id, job, pipeline, toolCommand, source }: JobInput): Record<string, unknown> {
  const pointer = `/jobs/${id}`;
  for (const [field, feature] of [
    ["when", "a job condition, which CircleCI declares on the workflow"],
    ["permissions", "job permissions, which CircleCI configures with contexts"],
    ["environment", "a deployment environment"],
    ["timeoutMinutes", "a job timeout, which CircleCI configures per plan and per step"],
  ] as const) {
    if (job[field] !== undefined) unsupported(`${pointer}/${field}`, feature);
  }
  const executor = job.native?.circleci;
  const executorKeys = Object.keys(executor ?? {}).filter((key) => EXECUTOR_KEYS.has(key));
  if (executor === undefined || executorKeys.length !== 1) {
    unsupported(
      `${pointer}/native`,
      "a job without exactly one executor, because CircleCI requires one of docker, machine, macos or executor declared under native.circleci",
    );
  }
  for (const generated of ["parameters", "environment", "steps"]) {
    if (generated in executor) {
      unsupported(
        `${pointer}/native`,
        `a native.circleci mapping that sets ${generated}, which the compiler generates and would silently replace`,
      );
    }
  }
  const form = job.form ?? pipeline.form ?? "native";
  if (form === "wrapper" && toolCommand === undefined) {
    throw new Error(
      `job ${id} renders in the wrapper form, which needs CompileOptions.toolCommand`,
    );
  }
  const wrapper =
    form === "wrapper" && toolCommand !== undefined ? { source, toolCommand } : undefined;
  const environment = envOf(job.env, `${pointer}/env`);
  const parameters =
    job.matrix === undefined
      ? undefined
      : Object.fromEntries(
          Object.entries(job.matrix).map(([axis, values]) => {
            if (RESERVED_PARAMETERS.has(axis)) {
              unsupported(
                `${pointer}/matrix/${axis}`,
                `the matrix axis name ${axis}, which CircleCI reserves for workflow job configuration`,
              );
            }

            return [axis, { type: parameterType(values, `${pointer}/matrix/${axis}`) }];
          }),
        );

  return {
    ...(parameters === undefined ? {} : { parameters }),
    ...executor,
    ...(environment === undefined ? {} : { environment }),
    steps: stepsOf(id, job, wrapper),
  };
}

/**
 * The name other jobs `require`: the display name of an ordinary job, and the alias of a matrix job, which stands for every combination of it.
 */
function workflowJobName(id: string, job: Job): string {
  return job.matrix === undefined ? job.name : id;
}

/**
 * The name CircleCI reports a matrix combination under, written as the job's name followed by its axis values so that it reads like the other providers' check names.
 */
function matrixDisplayName(job: Job): string {
  const values = Object.keys(job.matrix ?? {}).map((axis) => `<< matrix.${axis} >>`);

  return `${job.name} (${values.join(", ")})`;
}

function branchCondition(branches: readonly string[]): Record<string, unknown> {
  const equals = branches.map((branch) => ({ equal: [branch, "<< pipeline.git.branch >>"] }));
  const [only] = equals;

  return equals.length === 1 && only !== undefined ? only : { or: equals };
}

/**
 * Compiles a pipeline to `.circleci/config.yml`.
 *
 * Support matrix: push triggers, with branch lists as a workflow condition, and schedule triggers as scheduled workflows; jobs with `needs`, an always-running fan-in through `requires` with the `terminal` status, matrices as parameterised jobs, job and step environments over the sha, ref and run id, checkout, run and circleci-owned provider steps. The executor of each job comes from `native.circleci`, because CircleCI cannot run a job without one, so runner labels are not used. Not supported, each rejected with the node named: pull-request and manual triggers (project settings and the API), conditions, permissions, concurrency, deployment environments, timeouts, and context values CircleCI has no pipeline value for.
 */
export function createCircleCiCompiler(): PipelineCompiler {
  return {
    provider: PROVIDER,
    checkNames(pipeline: Pipeline): ReadonlyMap<string, readonly string[]> {
      return new Map(
        Object.entries(pipeline.jobs).map(([id, job]) => [
          id,
          expandMatrix(job.matrix).map((combination: MatrixCombination) =>
            job.matrix === undefined
              ? job.name
              : `${job.name} (${matrixValues(job.matrix, combination).join(", ")})`,
          ),
        ]),
      );
    },
    async compile(pipeline: Pipeline, options: CompileOptions): Promise<readonly EmittedFile[]> {
      options.signal?.throwIfAborted();
      if (pipeline.permissions !== undefined) {
        unsupported(
          "/permissions",
          "pipeline permissions, which CircleCI configures with contexts",
        );
      }
      if (pipeline.concurrency !== undefined) {
        unsupported(
          "/concurrency",
          "a concurrency group with cancellation, because redundant-run cancellation is a project setting",
        );
      }
      if (pipeline.env !== undefined) {
        unsupported(
          "/env",
          "pipeline-level environment variables, which CircleCI takes from settings",
        );
      }

      const taken = new Set<string>();
      for (const [id, job] of Object.entries(pipeline.jobs)) {
        const expanded =
          job.matrix === undefined
            ? [job.name]
            : expandMatrix(job.matrix).map(
                (combination) =>
                  `${job.name} (${matrixValues(job.matrix, combination).join(", ")})`,
              );
        for (const display of expanded) {
          if (taken.has(`display:${display}`)) {
            unsupported(
              `/jobs/${id}/name`,
              `a second job reported as "${display}", because CircleCI appends numeric suffixes to duplicate workflow job names`,
            );
          }
          taken.add(`display:${display}`);
        }
        const name = workflowJobName(id, job);
        if (taken.has(name)) {
          unsupported(
            `/jobs/${id}/name`,
            `a second job named "${name}", because CircleCI requires workflow job names to be unique and refers to a dependency by that name`,
          );
        }
        taken.add(name);
      }
      const comments = new Map<string, string>();
      const jobs: Record<string, unknown> = {};
      const nameOf = new Map<string, string>();
      for (const [id, job] of Object.entries(pipeline.jobs)) {
        jobs[id] = jobOf({
          id,
          job,
          pipeline,
          toolCommand: options.toolCommand,
          source: options.source,
        });
        nameOf.set(id, workflowJobName(id, job));
        if (job.description !== undefined) comments.set(`jobs/${id}`, job.description);
      }

      const workflowJobs = Object.entries(pipeline.jobs).map(([id, job]) => {
        const requires = (job.needs ?? []).map((needed) => {
          const name = nameOf.get(needed) ?? needed;

          return job.needsPolicy === "always" ? { [name]: "terminal" } : name;
        });

        return {
          [id]: {
            name: job.matrix === undefined ? job.name : matrixDisplayName(job),
            ...(requires.length === 0 ? {} : { requires }),
            ...(job.matrix === undefined ? {} : { matrix: { alias: id, parameters: job.matrix } }),
          },
        };
      });

      const slug = slugOf(pipeline.name);
      if (slug === "") {
        unsupported(
          "/name",
          "a pipeline name with no letters or digits, because the workflow key is derived from it and CircleCI requires a non-empty key",
        );
      }
      const workflows: Record<string, unknown> = {};
      for (const [index, trigger] of pipeline.triggers.entries()) {
        const pointer = `/triggers/${String(index)}`;
        switch (trigger.kind) {
          case "push":
            if (slug in workflows) unsupported(pointer, "a second push trigger");
            workflows[slug] = {
              ...(trigger.branches === undefined
                ? {}
                : { when: branchCondition(trigger.branches) }),
              jobs: workflowJobs,
            };
            break;
          case "schedule":
            unsupported(
              pointer,
              "a schedule trigger, because CircleCI requires a branch filter on a scheduled workflow and the neutral trigger names no branch",
            );
            break;
          case "pullRequest":
            unsupported(
              pointer,
              "a pull-request trigger, because CircleCI selects pull-request events in project trigger settings",
            );
            break;
          case "manual":
            unsupported(
              pointer,
              "a manual trigger, because CircleCI pipelines are started from the web app or the API, not declared in the file",
            );
            break;
          default:
            assertNever(trigger);
        }
      }
      if (pipeline.description !== undefined) comments.set("workflows", pipeline.description);

      return Promise.resolve([
        {
          path: FILE,
          content: renderYaml(
            { version: CONFIG_VERSION, jobs, workflows },
            comments,
            generatedHeaderLines(options.source),
          ),
        },
      ]);
    },
  };
}
