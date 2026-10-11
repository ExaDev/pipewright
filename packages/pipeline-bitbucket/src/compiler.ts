import {
  UnsupportedFeatureError,
  assertNever,
  expandMatrix,
  generatedHeaderLines,
  jobGraphOf,
  matrixValues,
  type CompileOptions,
  type EmittedFile,
  type Job,
  type MatrixCombination,
  type Pipeline,
  type PipelineCompiler,
  type Step,
  joinShellSteps,
  mergeNative,
  nativeOf,
} from "@pipewright/pipeline-contract";
import { commentPath, renderYaml } from "@pipewright/yaml-emit";
import { dag } from "process-graph";

import {
  FILE,
  MANUAL_PIPELINE,
  MAX_TIME_RANGE,
  PROVIDER,
  SELF_HOSTED_LABEL,
} from "./vocabulary.ts";

interface PlacedStep {
  readonly id: string;
  /** The mapping stored under `step` (or `final`). */
  readonly body: Record<string, unknown>;
  readonly description: string | undefined;
  readonly always: boolean;
}

/**
 * Quotes a literal for a POSIX shell, so a matrix value containing a space or a shell metacharacter reaches the runner as one argument.
 */
function shellQuote(text: string): string {
  return `'${text.replaceAll("'", `'\\''`)}'`;
}

function unsupported(pointer: string, feature: string): never {
  throw new UnsupportedFeatureError(PROVIDER, pointer, feature);
}

function stepLabel(job: Job, matrix: MatrixCombination): string {
  return job.matrix === undefined
    ? job.name
    : `${job.name} (${matrixValues(job.matrix, matrix).join(", ")})`;
}

function isCollapsible(step: Step | undefined): boolean {
  return step?.kind === "run" && step.form !== "native";
}

interface ScriptContext {
  readonly id: string;
  readonly job: Job;
  readonly matrix: MatrixCombination;
  readonly wrapper: { readonly source: string; readonly toolCommand: string } | undefined;
}

/**
 * Bitbucket has no per-step working directory, environment or condition, so each is rejected, and a `provider` step is accepted only as script lines or a `pipe`.
 */
function scriptOf(context: ScriptContext): {
  script: unknown[];
  cloneDepth: string | number | undefined;
} {
  const { id, job, matrix, wrapper } = context;
  const script: unknown[] = [];
  /** The script entry that consecutive `run` steps are being joined into, since the commands of a Bitbucket step share one shell. */
  let openRun: number | undefined;
  /** The run steps of each script entry written from them, joined into the entry's text once the job's steps are read. */
  const runSteps = new Map<number, string[]>();
  let cloneDepth: string | number | undefined;
  let index = 0;
  while (index < job.steps.length) {
    const step = job.steps[index];
    if (step === undefined) break;
    const pointer = `/jobs/${id}/steps/${String(index)}`;
    // A collapsed run step is interpreted by the tool's runner, which evaluates its condition and environment, so Bitbucket need not express them.
    const collapsed = wrapper !== undefined && isCollapsible(step);
    if (!collapsed && step.when !== undefined) {
      unsupported(
        `${pointer}/when`,
        "a condition, because Bitbucket's == is case-sensitive and the neutral model's is not",
      );
    }

    if (step.kind === "checkout") {
      if (step.fetchDepth !== undefined) cloneDepth = step.fetchDepth;
      index += 1;
    } else if (step.kind === "provider") {
      if (step.provider !== PROVIDER) unsupported(pointer, `a step owned by ${step.provider}`);
      const lines: unknown = step.native.script;
      if (
        Array.isArray(lines) &&
        Object.keys(step.native).length === 1 &&
        lines.every((line): line is string => typeof line === "string")
      ) {
        script.push(...lines);
        openRun = undefined;
      } else if ("pipe" in step.native) {
        script.push(step.native);
        openRun = undefined;
      } else {
        unsupported(pointer, "a bitbucket-pipelines provider step other than { script } or a pipe");
      }
      index += 1;
    } else {
      if (!collapsed && step.env !== undefined) {
        unsupported(
          `${pointer}/env`,
          "a step environment, because Bitbucket takes variables from repository and deployment settings",
        );
      }
      if (!collapsed && step.workingDirectory !== undefined) {
        unsupported(`${pointer}/workingDirectory`, "a step working directory");
      }
      if (wrapper !== undefined && isCollapsible(step)) {
        const from = index;
        while (isCollapsible(job.steps[index])) index += 1;
        const matrixFlags = Object.entries(matrix)
          .map(([axis, value]) => ` --matrix ${shellQuote(`${axis}=${String(value)}`)}`)
          .join("");
        script.push(
          `${wrapper.toolCommand} run --pipeline ${wrapper.source} --job ${id} --steps ${String(from)}-${String(index - 1)}${matrixFlags}`,
        );
        openRun = undefined;
      } else {
        // The commands of a step run in one shell, so consecutive run steps are written as one entry, with a status check between steps that the importer reads back as the steps' boundaries.
        if (openRun === undefined) {
          openRun = script.length;
          runSteps.set(openRun, [step.run]);
          script.push("");
        } else {
          runSteps.get(openRun)?.push(step.run);
        }
        index += 1;
      }
    }
  }

  return {
    script: script.map((entry, at) => {
      const steps = runSteps.get(at);

      return steps === undefined ? entry : joinShellSteps(steps);
    }),
    cloneDepth,
  };
}

interface PlaceInput {
  readonly id: string;
  readonly job: Job;
  readonly pipeline: Pipeline;
  readonly toolCommand: string | undefined;
  readonly source: string;
}

function placeJob({ id, job, pipeline, toolCommand, source }: PlaceInput): PlacedStep[] {
  const pointer = `/jobs/${id}`;
  if (job.when !== undefined) {
    unsupported(
      `${pointer}/when`,
      "a condition, because Bitbucket's == is case-sensitive and the neutral model's is not",
    );
  }
  if (job.env !== undefined) {
    unsupported(
      `${pointer}/env`,
      "environment variables, which Bitbucket takes from repository and deployment settings rather than the file",
    );
  }
  if (job.permissions !== undefined) {
    unsupported(
      `${pointer}/permissions`,
      "job permissions, which Bitbucket configures in settings",
    );
  }
  if (
    job.timeoutMinutes !== undefined &&
    (job.timeoutMinutes < MAX_TIME_RANGE.min || job.timeoutMinutes > MAX_TIME_RANGE.max)
  ) {
    unsupported(
      `${pointer}/timeoutMinutes`,
      `a timeout of ${String(job.timeoutMinutes)} minutes, outside Bitbucket's ${String(MAX_TIME_RANGE.min)} to ${String(MAX_TIME_RANGE.max)}`,
    );
  }
  const form = job.form ?? pipeline.form ?? "native";
  if (form === "wrapper" && toolCommand === undefined) {
    throw new Error(
      `job ${id} renders in the wrapper form, which needs CompileOptions.toolCommand`,
    );
  }
  const wrapper =
    form === "wrapper" && toolCommand !== undefined ? { source, toolCommand } : undefined;
  const always = job.needsPolicy === "always";

  return expandMatrix(job.matrix).map((matrix) => {
    const { script, cloneDepth } = scriptOf({ id, job, matrix, wrapper });
    if (script.length === 0) {
      unsupported(
        `${pointer}/steps`,
        "a job with no command, because Bitbucket requires a step to have at least one script item and checkout is clone configuration",
      );
    }

    return {
      id,
      always,
      description: job.description,
      body: {
        name: stepLabel(job, matrix),
        ...(job.runsOn.includes(SELF_HOSTED_LABEL) ? { "runs-on": job.runsOn } : {}),
        ...(job.timeoutMinutes === undefined ? {} : { "max-time": job.timeoutMinutes }),
        ...(job.environment === undefined ? {} : { deployment: job.environment }),
        ...(cloneDepth === undefined ? {} : { clone: { depth: cloneDepth } }),
        script,
        ...(job.native?.["bitbucket-pipelines"] ?? {}),
      },
    };
  });
}

/**
 * Bitbucket's graph is a sequence of parallel groups, so a pipeline compiles only when scheduling by level adds no dependency the model did not state: every job must depend, directly or through others, on exactly the jobs of the levels below it.
 */
function assertSequenceOfGroups(graph: dag.Dag<string>, levels: ReadonlyMap<string, number>): void {
  for (const [id, level] of levels) {
    const below = new Set(
      [...levels].filter(([, other]) => other < level).map(([otherId]) => otherId),
    );
    const needed = new Set(dag.ancestorsOf(graph, id));
    const exact = below.size === needed.size && [...below].every((other) => needed.has(other));
    if (!exact) {
      unsupported(
        `/jobs/${id}/needs`,
        "a dependency graph that is not a sequence of parallel groups, which is the only shape Bitbucket expresses",
      );
    }
  }
}

function itemsOf(
  pipeline: Pipeline,
  toolCommand: string | undefined,
  source: string,
): { items: Record<string, unknown>[]; descriptions: Map<string, string> } {
  const graph = jobGraphOf(pipeline.jobs);
  const { levels } = dag.topologicalLayers(graph);
  assertSequenceOfGroups(graph, levels);
  const deepest = Math.max(...levels.values());
  const items: Record<string, unknown>[] = [];
  const descriptions = new Map<string, string>();
  const deployments = new Set<string>();

  for (let level = 0; level <= deepest; level += 1) {
    const placed = Object.entries(pipeline.jobs)
      .filter(([id]) => levels.get(id) === level)
      .flatMap(([id, job]) => placeJob({ id, job, pipeline, toolCommand, source }));
    for (const entry of placed) {
      const deployment = entry.body.deployment;
      if (typeof deployment !== "string") continue;
      if (deployments.has(deployment)) {
        unsupported(
          `/jobs/${entry.id}/environment`,
          `the deployment environment ${deployment} a second time, because Bitbucket permits one step per deployment environment in a pipeline`,
        );
      }
      deployments.add(deployment);
    }
    const always = placed.filter((entry) => entry.always);
    if (always.length > 0) {
      if (level !== deepest || placed.length !== 1) {
        unsupported(
          "/jobs",
          "an always-running job that is not the only job of the last level, because Bitbucket's final step must be last and single",
        );
      }
      const [only] = placed;
      if (only === undefined) break;
      if ("deployment" in only.body) {
        unsupported("/jobs", "a deployment environment on the final step");
      }
      items.push({ final: only.body });
      if (only.description !== undefined)
        descriptions.set(String(items.length - 1), only.description);
    } else if (placed.length === 1) {
      const [only] = placed;
      if (only === undefined) break;
      items.push({ step: only.body });
      if (only.description !== undefined)
        descriptions.set(String(items.length - 1), only.description);
    } else {
      items.push({ parallel: placed.map((entry) => ({ step: entry.body })) });
      for (const [index, entry] of placed.entries()) {
        if (entry.description !== undefined) {
          descriptions.set(
            `${String(items.length - 1)}/parallel/${String(index)}`,
            entry.description,
          );
        }
      }
    }
  }

  return { items, descriptions };
}

type Items = readonly Record<string, unknown>[];

function withBranches(
  existing: Readonly<Record<string, unknown>>,
  names: readonly string[],
  target: { items: Items; pointer: string; place: (prefix: string) => void },
): Record<string, unknown> {
  const added = names.map((branch): [string, unknown[]] => {
    if (branch in existing) unsupported(target.pointer, `branch ${branch} named twice`);
    target.place(commentPath("pipelines", "branches", branch));

    return [branch, [...target.items]];
  });

  return { ...existing, ...Object.fromEntries(added) };
}

/**
 * Maps each trigger to the key of the `pipelines` section it selects. `place` is told where the items were put so their descriptions can be attached as comments there.
 */
function pipelinesOf(
  pipeline: Pipeline,
  items: Items,
  place: (prefix: string) => void,
): Record<string, unknown> {
  const pipelines: Record<string, Record<string, unknown> | unknown[]> = {};
  let branches: Record<string, unknown> = {};
  if (pipeline.triggers.length === 0) {
    unsupported(
      "/triggers",
      "a pipeline with no triggers, because the file must name a pipeline to run",
    );
  }
  for (const [index, trigger] of pipeline.triggers.entries()) {
    const pointer = `/triggers/${String(index)}`;
    switch (trigger.kind) {
      case "push":
        if (trigger.branches === undefined) {
          if ("default" in pipelines)
            unsupported(pointer, "a second push trigger with no branches");
          pipelines.default = [...items];
          place(commentPath("pipelines", "default"));
        } else {
          branches = withBranches(branches, trigger.branches, { items, pointer, place });
        }
        break;
      case "pullRequest":
        if (trigger.branches !== undefined) {
          unsupported(
            `${pointer}/branches`,
            "a pull-request target-branch filter, because the file filters on the source branch",
          );
        }
        pipelines["pull-requests"] = { "**": [...items] };
        place(commentPath("pipelines", "pull-requests", "**"));
        break;
      case "manual":
        pipelines.custom = { [MANUAL_PIPELINE]: [...items] };
        place(commentPath("pipelines", "custom", MANUAL_PIPELINE));
        break;
      case "schedule":
        unsupported(
          pointer,
          "a schedule trigger, because Bitbucket schedules are repository settings and cannot be declared in the file",
        );
        break;
      default:
        assertNever(trigger);
    }
  }
  if (Object.keys(branches).length > 0) pipelines.branches = branches;

  const ordered: Record<string, unknown> = {};
  for (const key of ["default", "branches", "pull-requests", "custom"]) {
    const value = pipelines[key];
    if (value !== undefined) ordered[key] = value;
  }

  return ordered;
}

/**
 * Compiles a pipeline to `bitbucket-pipelines.yml`.
 *
 * Support matrix: push (a branch list or the default pipeline), pull request (any target branch) and manual triggers; a graph that is a sequence of parallel groups, with one trailing always-running job as `final`; a matrix expanded into explicit parallel steps; timeouts from 1 to 720 minutes; deployment environments; runner labels; clone depth; script and pipe provider steps. Not supported, each rejected with the node named: schedule triggers (a repository setting), a pull-request target-branch filter (the file filters on the source branch), environment variables, permissions, concurrency, every condition (Bitbucket's equality is case-sensitive), step-level environments and working directories, and any graph that is not a sequence of parallel groups.
 */
export function createBitbucketPipelinesCompiler(): PipelineCompiler {
  return {
    provider: PROVIDER,
    checkNames(pipeline: Pipeline): ReadonlyMap<string, readonly string[]> {
      return new Map(
        Object.entries(pipeline.jobs).map(([id, job]) => [
          id,
          expandMatrix(job.matrix).map((matrix) => stepLabel(job, matrix)),
        ]),
      );
    },
    async compile(pipeline: Pipeline, options: CompileOptions): Promise<readonly EmittedFile[]> {
      options.signal?.throwIfAborted();
      if (pipeline.permissions !== undefined) {
        unsupported("/permissions", "pipeline permissions, which Bitbucket configures in settings");
      }
      if (pipeline.concurrency !== undefined) {
        unsupported(
          "/concurrency",
          "a concurrency group with cancellation, because Bitbucket's concurrency-group only queues",
        );
      }
      if (pipeline.env !== undefined) {
        unsupported("/env", "environment variables, which Bitbucket takes from settings");
      }

      const { items, descriptions } = itemsOf(pipeline, options.toolCommand, options.source);
      const comments = new Map<string, string>();
      const ordered = pipelinesOf(pipeline, items, (prefix) => {
        for (const [suffix, text] of descriptions) comments.set(`${prefix}/${suffix}`, text);
      });
      if (pipeline.description !== undefined) comments.set("pipelines", pipeline.description);

      return Promise.resolve([
        {
          path: FILE,
          content: renderYaml(
            mergeNative({ pipelines: ordered }, nativeOf(pipeline, PROVIDER)),
            comments,
            generatedHeaderLines(options.source),
          ),
        },
      ]);
    },
  };
}
