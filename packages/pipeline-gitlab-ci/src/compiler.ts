import {
  UnsupportedFeatureError,
  assertNever,
  compilePredicate,
  dependencyLevels,
  expandMatrix,
  matrixValues,
  generatedHeaderLines,
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
  type Trigger,
} from "@ci-adapters/pipeline-contract";
import { renderYaml } from "@ci-adapters/yaml-emit";

const PROVIDER = "gitlab-ci";

const CONTEXT_VARIABLE: Readonly<Record<ContextKey, string>> = {
  event: "$CI_PIPELINE_SOURCE",
  refName: "$CI_COMMIT_REF_NAME",
  baseRefName: "$CI_MERGE_REQUEST_TARGET_BRANCH_NAME",
  sha: "$CI_COMMIT_SHA",
  repository: "$CI_PROJECT_PATH",
  workflow: "$CI_PIPELINE_NAME",
  runId: "$CI_PIPELINE_ID",
};

const PIPELINE_SOURCE: Readonly<Record<EventKind, string>> = {
  push: "push",
  pullRequest: "merge_request_event",
  schedule: "schedule",
  manual: "web",
};

/** Top-level keys that are configuration rather than job names, so a job cannot be called one of them. */
const RESERVED_NAMES: ReadonlySet<string> = new Set([
  "image",
  "services",
  "stages",
  "types",
  "before_script",
  "after_script",
  "variables",
  "cache",
  "include",
  "default",
  "workflow",
]);

function isEventKind(value: string): value is EventKind {
  return value in PIPELINE_SOURCE;
}

function escapeRegex(text: string): string {
  return text.replaceAll(/[.*+?^${}()|[\]\\/]/g, "\\$&");
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

function variableFor(
  token: { kind: "context"; key: ContextKey } | { kind: "matrix"; name: string },
): string {
  return token.kind === "context" ? CONTEXT_VARIABLE[token.key] : `$${token.name}`;
}

function variablesOf(env: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).map(([key, value]) => [key, renderTemplate(value, variableFor)]),
  );
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
}

function jobOf({ id, job, pipeline, level, keyOf }: JobInput): JobOutput {
  const pointer = `/jobs/${id}`;
  const unsupported = (path: string, feature: string): never => {
    throw new UnsupportedFeatureError(PROVIDER, `${pointer}${path}`, feature);
  };
  if (job.permissions !== undefined) {
    unsupported("/permissions", "job permissions, which GitLab configures per project");
  }
  if ((job.form ?? pipeline.form) === "wrapper") {
    unsupported("/form", "the wrapper form, which only github-actions implements");
  }
  const key = keyOf.get(id) ?? job.name;
  const comments = new Map<string, string>();
  const script: string[] = [];
  let gitDepth: string | undefined;

  for (const [index, step] of job.steps.entries()) {
    const at = `/steps/${String(index)}`;
    if (step.when !== undefined) {
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
        if (step.env !== undefined) {
          unsupported(
            `${at}/env`,
            "a step-level environment, because GitLab scopes variables to the job",
          );
        }
        if (step.workingDirectory !== undefined) {
          unsupported(`${at}/workingDirectory`, "a step working directory");
        }
        const label = step.description ?? step.name;
        if (label !== undefined) comments.set(`${key}/script/${String(script.length)}`, label);
        script.push(step.run);
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
        }
        break;
      }
    }
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
    pipeline.concurrency === undefined
      ? undefined
      : renderTemplate(pipeline.concurrency.group, variableFor);

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
      script,
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

      const levels = dependencyLevels(pipeline.jobs);
      const deepest = Math.max(...levels.values());
      const comments = new Map<string, string>();
      const jobs: Record<string, unknown> = {};
      for (const [id, job] of Object.entries(pipeline.jobs)) {
        const output = jobOf({ id, job, pipeline, level: levels.get(id) ?? 0, keyOf });
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
