import {
  UnsupportedFeatureError,
  assertNever,
  compilePredicate,
  expandMatrix,
  matrixValues,
  generatedHeaderLines,
  jobGraphOf,
  renderTemplate,
  type CompileOptions,
  type ContextKey,
  type EmittedFile,
  type EventKind,
  type Job,
  type Operand,
  type Pipeline,
  type PipelineCompiler,
  type PredicateHandlers,
  type Step,
  type Trigger,
} from "@pipewright/pipeline-contract";
import { renderYaml } from "@pipewright/yaml-emit";
import { dag } from "process-graph";

import {
  CONTEXT_VARIABLE,
  PIPELINE_SOURCE,
  PROVIDER,
  RESERVED_NAMES,
  escapeRegex,
  FAIL_FAST,
} from "./vocabulary.ts";

function isEventKind(value: string): value is EventKind {
  return value in PIPELINE_SOURCE;
}

/**
 * GitLab's `==` is case-sensitive and the neutral model's equality is not, so equality renders as an anchored case-insensitive regular expression match. That form needs exactly one variable and one literal; two variables cannot be compared case-insensitively. GitLab evaluates `rules:if` before a matrix expands, and has no negation of a grouped expression, so matrix references and `not` are rejected.
 */
function conditionHandlers(pointer: string): PredicateHandlers<string> {
  const unsupported = (feature: string): never => {
    throw new UnsupportedFeatureError(PROVIDER, pointer, feature);
  };

  const variable = (operand: Operand): string | undefined => {
    switch (operand.kind) {
      case "context":
        return CONTEXT_VARIABLE[operand.key];
      case "matrix":
        return unsupported(
          "a matrix reference in a condition, which GitLab evaluates before the matrix expands",
        );
      case "text":
        return undefined;
    }

    return assertNever(operand);
  };

  const literal = (operand: Operand, other: Operand): string => {
    if (operand.kind !== "text") return unsupported("a comparison between two variables");
    if (other.kind === "context" && other.key === "event") {
      if (!isEventKind(operand.value)) {
        return unsupported(`the event value ${JSON.stringify(operand.value)}`);
      }

      return PIPELINE_SOURCE[operand.value];
    }

    return operand.value;
  };

  const equals = (left: Operand, right: Operand, negated: boolean): string => {
    const leftVariable = variable(left);
    const rightVariable = variable(right);
    if (leftVariable === undefined && rightVariable === undefined) {
      const same = literal(left, right).toLowerCase() === literal(right, left).toLowerCase();

      return same !== negated ? '"1" == "1"' : '"1" == "0"';
    }
    const subject = leftVariable ?? rightVariable;
    if (subject === undefined) return unsupported("a comparison between two variables");
    const other = leftVariable === undefined ? left : right;
    const value = literal(other, leftVariable === undefined ? right : left);

    return `${subject} ${negated ? "!~" : "=~"} /^${escapeRegex(value)}$/i`;
  };

  return {
    and: (left, right) => `(${left} && ${right})`,
    or: (left, right) => `(${left} || ${right})`,
    allOf: (operands) =>
      operands.length === 0 ? unsupported("an empty allOf") : `(${operands.join(" && ")})`,
    anyOf: (operands) =>
      operands.length === 0 ? unsupported("an empty anyOf") : `(${operands.join(" || ")})`,
    equals,
    memberOf: (operand, candidates, negated) => {
      if (candidates.length === 0) return unsupported("an empty membership list");
      const parts = candidates.map((candidate) => equals(operand, candidate, negated));

      return `(${parts.join(negated ? " && " : " || ")})`;
    },
  };
}

function branchPattern(branches: readonly string[]): string {
  return `/^(${branches.map(escapeRegex).join("|")})$/i`;
}

function workflowRule(trigger: Trigger, index: number): string {
  const pointer = `/triggers/${String(index)}`;
  switch (trigger.kind) {
    case "push": {
      const base = `$CI_PIPELINE_SOURCE == "${PIPELINE_SOURCE.push}"`;

      return trigger.branches === undefined
        ? base
        : `${base} && $CI_COMMIT_BRANCH =~ ${branchPattern(trigger.branches)}`;
    }
    case "pullRequest": {
      const base = `$CI_PIPELINE_SOURCE == "${PIPELINE_SOURCE.pullRequest}"`;

      return trigger.branches === undefined
        ? base
        : `${base} && $CI_MERGE_REQUEST_TARGET_BRANCH_NAME =~ ${branchPattern(trigger.branches)}`;
    }
    case "manual":
      return `$CI_PIPELINE_SOURCE == "${PIPELINE_SOURCE.manual}"`;
    case "schedule":
      throw new UnsupportedFeatureError(
        PROVIDER,
        pointer,
        "a schedule trigger, because GitLab pipeline schedules are project settings and cannot be declared in the file",
      );
  }

  return assertNever(trigger);
}

/**
 * A variable reference inside text. Braces end the name, so text that follows it is not read as part of it: `$CI_COMMIT_REF_NAME_build` names a different variable from `${CI_COMMIT_REF_NAME}_build`.
 */
function variableFor(
  token: { kind: "context"; key: ContextKey } | { kind: "matrix"; name: string },
): string {
  return token.kind === "context"
    ? `\${${CONTEXT_VARIABLE[token.key].slice(1)}}`
    : `\${${token.name}}`;
}

/**
 * Text with each reference rendered as a variable. GitLab expands `$NAME` wherever it appears in a variable's value, so a literal `$` in the model's text, which a file for another provider can carry as plain text, is written `$$` and stays the character it was.
 */
function valueOf(value: string): string {
  return renderTemplate(value.replaceAll("$", "$$$$"), variableFor);
}

function variablesOf(env: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(Object.entries(env).map(([key, value]) => [key, valueOf(value)]));
}

interface JobOutput {
  readonly key: string;
  readonly value: Record<string, unknown>;
  readonly comments: ReadonlyMap<string, string>;
}

interface JobInput {
  readonly id: string;
  readonly job: Job;
  readonly pipeline: Pipeline;
  readonly level: number;
  readonly keyOf: ReadonlyMap<string, string>;
  readonly toolCommand: string | undefined;
  readonly source: string;
}

function isCollapsible(step: Step | undefined): boolean {
  return step?.kind === "run" && step.form !== "native";
}

/**
 * Builds the one script line that stands for a collapsed group of steps: a call to this tool's runner for exactly those step indexes, with each matrix axis passed through the job's variable of the same name.
 */
function wrapperOf(
  id: string,
  toolCommand: string | undefined,
  source: string,
): (from: number, to: number, axes: readonly string[]) => string {
  if (toolCommand === undefined) {
    throw new Error(
      `job ${id} renders in the wrapper form, which needs CompileOptions.toolCommand`,
    );
  }

  return (from, to, axes) =>
    `${toolCommand} run --pipeline ${source} --job ${id} --steps ${String(from)}-${String(to)}${axes
      .map((axis) => ` --matrix "${axis}=$${axis}"`)
      .join("")}`;
}

function jobOf(input: JobInput): JobOutput {
  const { id, job, pipeline, level, keyOf } = input;
  const pointer = `/jobs/${id}`;
  const unsupported = (path: string, feature: string): never => {
    throw new UnsupportedFeatureError(PROVIDER, `${pointer}${path}`, feature);
  };
  if (job.permissions !== undefined) {
    unsupported("/permissions", "job permissions, which GitLab configures per project");
  }
  const wrapper =
    (job.form ?? pipeline.form) === "wrapper"
      ? wrapperOf(id, input.toolCommand, input.source)
      : undefined;
  const key = keyOf.get(id) ?? job.name;
  const comments = new Map<string, string>();
  const script: string[] = [];
  /** The script entry that consecutive `run` steps are being joined into, since the lines of a GitLab script share one shell. */
  let openRun: number | undefined;
  /** The script entries written from `run` steps, which are the ones that must stop at their first failing command. */
  const runEntries = new Set<number>();
  let gitDepth: string | undefined;

  let index = 0;
  while (index < job.steps.length) {
    const step = job.steps[index];
    if (step === undefined) break;
    const at = `/steps/${String(index)}`;
    // A collapsed run step is interpreted by the tool's runner, which evaluates its condition and environment, so GitLab need not express them.
    const collapsed = wrapper !== undefined && step.kind === "run" && step.form !== "native";
    if (!collapsed && step.when !== undefined) {
      unsupported(
        `${at}/when`,
        "a step-level condition, because GitLab conditions apply to whole jobs",
      );
    }
    switch (step.kind) {
      case "checkout":
        if (step.fetchDepth !== undefined) {
          gitDepth = step.fetchDepth === "full" ? "0" : String(step.fetchDepth);
        }
        break;
      case "run": {
        if (!collapsed && step.env !== undefined) {
          unsupported(
            `${at}/env`,
            "a step-level environment, because GitLab scopes variables to the job",
          );
        }
        if (!collapsed && step.workingDirectory !== undefined) {
          unsupported(`${at}/workingDirectory`, "a step working directory");
        }
        if (wrapper !== undefined && step.form !== "native") {
          const from = index;
          while (isCollapsible(job.steps[index])) index += 1;
          script.push(wrapper(from, index - 1, Object.keys(job.matrix ?? {})));
          openRun = undefined;
          continue;
        }
        // The lines of a script run in one shell, so consecutive run steps are written as one entry whose lines are theirs, which is what the importer reads back as one step.
        const label = step.description ?? step.name;
        if (openRun === undefined) {
          openRun = script.length;
          runEntries.add(openRun);
          script.push(step.run);
          if (label !== undefined) comments.set(`${key}/script/${String(openRun)}`, label);
        } else {
          script[openRun] = `${script[openRun] ?? ""}\n${step.run}`;
          const path = `${key}/script/${String(openRun)}`;
          const joined = [comments.get(path), label].filter((text) => text !== undefined);
          if (joined.length > 0) comments.set(path, joined.join("\n"));
        }
        break;
      }
      case "provider": {
        if (step.provider !== PROVIDER) {
          unsupported(at, `a step owned by ${step.provider}`);
        }
        const lines: unknown = step.native.script;
        if (
          Object.keys(step.native).length !== 1 ||
          !Array.isArray(lines) ||
          !lines.every((line): line is string => typeof line === "string")
        ) {
          unsupported(at, "a gitlab-ci provider step other than { script: string[] }");
        } else {
          script.push(...lines);
          openRun = undefined;
        }
        break;
      }
    }
    index += 1;
  }

  const condition =
    job.when === undefined
      ? undefined
      : compilePredicate(job.when, conditionHandlers(`${pointer}/when`), {
          provider: PROVIDER,
          pointer: `${pointer}/when`,
        });
  const always = job.needsPolicy === "always";
  const rules =
    condition === undefined && !always
      ? undefined
      : [
          {
            ...(condition === undefined ? {} : { if: condition }),
            ...(always ? { when: "always" } : {}),
          },
        ];

  const variables = {
    ...(gitDepth === undefined ? {} : { GIT_DEPTH: gitDepth }),
    ...variablesOf(job.env ?? {}),
  };
  const group =
    pipeline.concurrency === undefined ? undefined : valueOf(pipeline.concurrency.group);

  if (job.description !== undefined) comments.set(key, job.description);

  return {
    key,
    comments,
    value: {
      stage: `level-${String(level)}`,
      ...(job.runsOn.length === 0 ? {} : { tags: job.runsOn }),
      ...(job.needs === undefined
        ? {}
        : { needs: job.needs.map((needed) => keyOf.get(needed) ?? needed) }),
      ...(job.timeoutMinutes === undefined
        ? {}
        : { timeout: `${String(job.timeoutMinutes)} minutes` }),
      ...(job.environment === undefined ? {} : { environment: job.environment }),
      ...(job.matrix === undefined ? {} : { parallel: { matrix: [job.matrix] } }),
      ...(Object.keys(variables).length === 0 ? {} : { variables }),
      ...(rules === undefined ? {} : { rules }),
      ...(pipeline.concurrency?.cancelInProgress === true ? { interruptible: true } : {}),
      ...(pipeline.concurrency?.cancelInProgress === false && group !== undefined
        ? { resource_group: group }
        : {}),
      script: script.map((entry, at) =>
        runEntries.has(at) && entry.includes("\n") ? `${FAIL_FAST}\n${entry}` : entry,
      ),
      ...(job.native?.["gitlab-ci"] ?? {}),
    },
  };
}

/**
 * Compiles a pipeline to `.gitlab-ci.yml`.
 *
 * Support matrix: push, pull request (merge request) and manual triggers; jobs with `needs`, matrix (as `parallel: matrix`), timeout, environment, variables and runner tags; `needsPolicy: always` as `when: always`; concurrency as `interruptible` or `resource_group`; job conditions over `and`, `or`, `allOf`, `anyOf`, text equality and membership. Not supported, each rejected with the node named: schedule triggers (a project setting in GitLab), permissions, step-level conditions, environments and working directories, `not`, matrix references in conditions, and any provider step not owned by gitlab-ci. A job's name becomes its key, so names must be unique and free of `/` and reserved words.
 */
export function createGitLabCiCompiler(): PipelineCompiler {
  return {
    provider: PROVIDER,
    /** GitLab reports a `parallel: matrix` job as `<name>: [<value>, <value>]`, values in declared axis order. */
    checkNames(pipeline: Pipeline): ReadonlyMap<string, readonly string[]> {
      return new Map(
        Object.entries(pipeline.jobs).map(([id, job]) => [
          id,
          expandMatrix(job.matrix).map((combination) =>
            job.matrix === undefined
              ? job.name
              : `${job.name}: [${matrixValues(job.matrix, combination).join(", ")}]`,
          ),
        ]),
      );
    },
    async compile(pipeline: Pipeline, options: CompileOptions): Promise<readonly EmittedFile[]> {
      options.signal?.throwIfAborted();
      if (pipeline.permissions !== undefined) {
        throw new UnsupportedFeatureError(
          PROVIDER,
          "/permissions",
          "pipeline permissions, which GitLab configures per project",
        );
      }

      const keyOf = new Map<string, string>();
      const taken = new Set<string>();
      for (const [id, job] of Object.entries(pipeline.jobs)) {
        const problem = RESERVED_NAMES.has(job.name)
          ? `the job name "${job.name}", which is a GitLab configuration keyword`
          : job.name.includes("/")
            ? `the job name "${job.name}", because it contains "/"`
            : taken.has(job.name)
              ? `a second job named "${job.name}"`
              : undefined;
        if (problem !== undefined) {
          throw new UnsupportedFeatureError(PROVIDER, `/jobs/${id}/name`, problem);
        }
        taken.add(job.name);
        keyOf.set(id, job.name);
      }

      const { levels, layers } = dag.topologicalLayers(jobGraphOf(pipeline.jobs));
      const deepest = layers.length - 1;
      const comments = new Map<string, string>();
      const jobs: Record<string, unknown> = {};
      for (const [id, job] of Object.entries(pipeline.jobs)) {
        const level = levels.get(id);
        if (level === undefined) {
          throw new Error(`job "${id}" has no dependency level in an acyclic graph`);
        }
        const output = jobOf({
          id,
          job,
          pipeline,
          level,
          keyOf,
          toolCommand: options.toolCommand,
          source: options.source,
        });
        jobs[output.key] = output.value;
        for (const [path, text] of output.comments) comments.set(path, text);
      }

      const document: Record<string, unknown> = {
        workflow: {
          name: pipeline.name,
          rules: pipeline.triggers.map((trigger, index) => ({
            if: workflowRule(trigger, index),
          })),
          ...(pipeline.concurrency?.cancelInProgress === true
            ? { auto_cancel: { on_new_commit: "interruptible" } }
            : {}),
        },
        stages: Array.from({ length: deepest + 1 }, (_unused, level) => `level-${String(level)}`),
        ...(pipeline.env === undefined ? {} : { variables: variablesOf(pipeline.env) }),
        ...jobs,
      };
      const workflowComment = [pipeline.description, pipeline.concurrency?.description]
        .filter((text): text is string => text !== undefined)
        .join("\n");
      if (workflowComment !== "") comments.set("workflow", workflowComment);

      return Promise.resolve([
        {
          path: ".gitlab-ci.yml",
          content: renderYaml(document, comments, generatedHeaderLines(options.source)),
        },
      ]);
    },
  };
}
