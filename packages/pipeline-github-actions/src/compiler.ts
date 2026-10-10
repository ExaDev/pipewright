import {
  PERMISSION_SCOPES,
  UnsupportedFeatureError,
  assertNever,
  compilePredicate,
  expandMatrix,
  matrixValues,
  generatedHeaderLines,
  renderTemplate,
  slugOf,
  type CompileOptions,
  type ContextKey,
  type EmittedFile,
  type EventKind,
  type Job,
  type Operand,
  type Permissions,
  type Pipeline,
  type PipelineCompiler,
  type PredicateHandlers,
  type PredicateNode,
  type Step,
} from "@ci-adapters/pipeline-contract";
import { renderYaml } from "@ci-adapters/yaml-emit";

const PROVIDER = "github-actions";

/**
 * The checkout action's major version. It is pinned here, in one place, so a bump is a single reviewed change to the adapter rather than an edit to every pipeline.
 */
const CHECKOUT_ACTION = "actions/checkout@v7";

const CONTEXT_EXPRESSION: Readonly<Record<ContextKey, string>> = {
  event: "github.event_name",
  refName: "github.ref_name",
  baseRefName: "github.base_ref",
  sha: "github.sha",
  repository: "github.repository",
  workflow: "github.workflow",
  runId: "github.run_id",
};

const EVENT_NAME: Readonly<Record<EventKind, string>> = {
  push: "push",
  pullRequest: "pull_request",
  schedule: "schedule",
  manual: "workflow_dispatch",
};

/**
 * The step a gate job starts with. GitHub reports a job skipped because a dependency failed as successful, and a skipped job does not block a required check, so a gate has to run regardless and fail explicitly when any job it needs did not succeed.
 * @see https://docs.github.com/en/actions/using-jobs/using-conditions-to-control-job-execution
 */
const GATE_STEP = {
  name: "Fail unless every needed job succeeded",
  if: "contains(needs.*.result, 'failure') || contains(needs.*.result, 'cancelled') || contains(needs.*.result, 'skipped')",
  run: "exit 1",
} as const;

const PERMISSION_SCOPE: Readonly<Record<keyof Permissions, string>> = {
  actions: "actions",
  contents: "contents",
  pullRequests: "pull-requests",
  issues: "issues",
  checks: "checks",
  packages: "packages",
  identityToken: "id-token",
};

function quote(text: string): string {
  return `'${text.replaceAll("'", "''")}'`;
}

function isEventKind(value: string): value is EventKind {
  return value in EVENT_NAME;
}

/**
 * GitHub's `==` is case-insensitive, which is the neutral model's equality, so it renders directly. A matrix reference is rejected in a job-level condition because GitHub evaluates that before the matrix expands.
 */
function conditionHandlers(pointer: string, allowMatrix: boolean): PredicateHandlers<string> {
  const unsupported = (feature: string): never => {
    throw new UnsupportedFeatureError(PROVIDER, pointer, feature);
  };
  const render = (operand: Operand, other: Operand): string => {
    switch (operand.kind) {
      case "context":
        return CONTEXT_EXPRESSION[operand.key];
      case "matrix":
        if (!allowMatrix) {
          return unsupported(
            "a matrix reference in a job-level condition, which GitHub evaluates before the matrix expands",
          );
        }

        return `matrix.${operand.name}`;
      case "text": {
        if (other.kind === "context" && other.key === "event") {
          if (!isEventKind(operand.value)) {
            return unsupported(`the event value ${JSON.stringify(operand.value)}`);
          }

          return quote(EVENT_NAME[operand.value]);
        }

        return quote(operand.value);
      }
    }

    return assertNever(operand);
  };
  const equals = (left: Operand, right: Operand, negated: boolean): string =>
    `(${render(left, right)} ${negated ? "!=" : "=="} ${render(right, left)})`;

  return {
    not: (operand) => `!${operand}`,
    and: (left, right) => `(${left} && ${right})`,
    or: (left, right) => `(${left} || ${right})`,
    allOf: (operands) => (operands.length === 0 ? "true" : `(${operands.join(" && ")})`),
    anyOf: (operands) => (operands.length === 0 ? "false" : `(${operands.join(" || ")})`),
    equals,
    memberOf: (operand, candidates, negated) => {
      const any =
        candidates.length === 0
          ? "false"
          : `(${candidates.map((candidate) => equals(operand, candidate, false)).join(" || ")})`;

      return negated ? `!${any}` : any;
    },
  };
}

function conditionOf(predicate: PredicateNode, pointer: string, allowMatrix: boolean): string {
  return compilePredicate(predicate, conditionHandlers(pointer, allowMatrix), {
    provider: PROVIDER,
    pointer,
  });
}

function permissionsOf(permissions: Readonly<Permissions>): Record<string, string> {
  return Object.fromEntries(
    PERMISSION_SCOPES.flatMap((scope) => {
      const level = permissions[scope];

      return level === undefined ? [] : [[PERMISSION_SCOPE[scope], level]];
    }),
  );
}

function envOf(env: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).map(([key, value]) => [
      key,
      renderTemplate(value, (token) =>
        token.kind === "context"
          ? `\${{ ${CONTEXT_EXPRESSION[token.key]} }}`
          : `\${{ matrix.${token.name} }}`,
      ),
    ]),
  );
}

function stepOf(step: Step, pointer: string): Record<string, unknown> {
  const common: Record<string, unknown> = {};
  if (step.name !== undefined) common.name = step.name;
  if (step.when !== undefined) {
    common.if = conditionOf(step.when, `${pointer}/when`, true);
  }
  switch (step.kind) {
    case "checkout":
      return {
        ...common,
        uses: CHECKOUT_ACTION,
        ...(step.fetchDepth === undefined
          ? {}
          : { with: { "fetch-depth": step.fetchDepth === "full" ? 0 : step.fetchDepth } }),
      };
    case "run":
      return {
        ...common,
        run: step.run,
        ...(step.env === undefined ? {} : { env: envOf(step.env) }),
        ...(step.workingDirectory === undefined
          ? {}
          : { "working-directory": step.workingDirectory }),
      };
    case "provider":
      if (step.provider !== PROVIDER) {
        throw new UnsupportedFeatureError(PROVIDER, pointer, `a step owned by ${step.provider}`);
      }

      return { ...common, ...step.native };
  }

  return assertNever(step);
}

interface WrapperContext {
  readonly source: string;
  readonly toolCommand: string;
}

/**
 * Renders a job's steps in the wrapper form: checkouts and GitHub-owned steps stay native and keep their order, and each contiguous run of portable `run` steps becomes one invocation of the tool's runner for exactly those step indexes. Step names, conditions and per-step environments move into the pipeline file the runner reads, so GitHub's UI and actionlint no longer see them.
 */
function isCollapsible(step: Step | undefined): boolean {
  return step?.kind === "run" && step.form !== "native";
}

function wrapperStepsOf(id: string, job: Job, context: WrapperContext): Record<string, unknown>[] {
  const pointer = `/jobs/${id}`;
  const matrixFlags = Object.keys(job.matrix ?? {})
    .map((axis) => ` --matrix "${axis}=\${{ matrix.${axis} }}"`)
    .join("");
  const steps: Record<string, unknown>[] = [];
  let index = 0;
  while (index < job.steps.length) {
    const step = job.steps[index];
    if (step?.kind !== "run" || step.form === "native") {
      if (step === undefined) break;
      steps.push(stepOf(step, `${pointer}/steps/${String(index)}`));
      index += 1;
      continue;
    }
    const from = index;
    while (isCollapsible(job.steps[index])) index += 1;
    steps.push({
      name: `Run ${job.name}`,
      run: `${context.toolCommand} run --pipeline ${context.source} --job ${id} --steps ${String(from)}-${String(index - 1)}${matrixFlags}`,
    });
  }

  return steps;
}

function jobOf(id: string, job: Job, wrapper: WrapperContext | undefined): Record<string, unknown> {
  const pointer = `/jobs/${id}`;
  const conditions: string[] = [];
  const runsRegardless = job.needsPolicy === "always" || job.needsPolicy === "gate";
  if (runsRegardless) conditions.push("always()");
  if (job.when !== undefined) {
    conditions.push(conditionOf(job.when, `${pointer}/when`, false));
  }
  const condition =
    conditions.length === 0
      ? undefined
      : runsRegardless && job.when !== undefined
        ? `always() && ${conditions[1] ?? ""}`
        : (conditions[0] ?? "");

  return {
    name: job.name,
    "runs-on": job.runsOn.length === 1 ? job.runsOn[0] : job.runsOn,
    ...(job.needs === undefined ? {} : { needs: job.needs }),
    ...(condition === undefined ? {} : { if: condition }),
    ...(job.timeoutMinutes === undefined ? {} : { "timeout-minutes": job.timeoutMinutes }),
    ...(job.permissions === undefined ? {} : { permissions: permissionsOf(job.permissions) }),
    ...(job.environment === undefined ? {} : { environment: job.environment }),
    ...(job.env === undefined ? {} : { env: envOf(job.env) }),
    ...(job.matrix === undefined ? {} : { strategy: { matrix: job.matrix } }),
    steps: [
      ...(job.needsPolicy === "gate" ? [GATE_STEP] : []),
      ...(wrapper === undefined
        ? job.steps.map((step, index) => stepOf(step, `${pointer}/steps/${String(index)}`))
        : wrapperStepsOf(id, job, wrapper)),
    ],
    ...(job.native?.["github-actions"] ?? {}),
  };
}

function triggersOf(pipeline: Pipeline, comments: Map<string, string>): Record<string, unknown> {
  const on: Record<string, unknown> = {};
  const schedules: { cron: string }[] = [];
  const claim = (key: string, index: number, description: string | undefined): void => {
    if (key in on) {
      throw new UnsupportedFeatureError(
        PROVIDER,
        `/triggers/${String(index)}`,
        `a second ${key} trigger, which GitHub merges into one`,
      );
    }
    if (description !== undefined) comments.set(`on/${key}`, description);
  };

  for (const [index, trigger] of pipeline.triggers.entries()) {
    switch (trigger.kind) {
      case "push":
        claim("push", index, trigger.description);
        on.push = trigger.branches === undefined ? {} : { branches: trigger.branches };
        break;
      case "pullRequest":
        claim("pull_request", index, trigger.description);
        on.pull_request = trigger.branches === undefined ? {} : { branches: trigger.branches };
        break;
      case "manual":
        claim("workflow_dispatch", index, trigger.description);
        on.workflow_dispatch = {};
        break;
      case "schedule":
        schedules.push({ cron: trigger.cron });
        break;
    }
  }
  if (schedules.length > 0) on.schedule = schedules;

  return on;
}

/**
 * Compiles a pipeline to one GitHub Actions workflow file, `.github/workflows/<name>.yml`, with each job in the `native` or `wrapper` form (see `formSchema`); the two mix freely within a file.
 *
 * Support matrix: every trigger kind; permissions; concurrency; matrix; `checkout`, `run` and GitHub-owned `provider` steps; job and step conditions over `not`, `and`, `or`, `allOf`, `anyOf`, text equality and membership. Not supported: regular-expression text comparisons, ordering comparisons, arithmetic and collection quantifiers, none of which GitHub's expression language can render with the neutral model's meaning. A matrix reference is rejected in a job-level condition.
 */
export function createGitHubActionsCompiler(): PipelineCompiler {
  return {
    provider: PROVIDER,
    /** GitHub reports a matrix job as `<name> (<value>, <value>)`, values in declared axis order. */
    checkNames(pipeline: Pipeline): ReadonlyMap<string, readonly string[]> {
      return new Map(
        Object.entries(pipeline.jobs).map(([id, job]) => [
          id,
          expandMatrix(job.matrix).map((combination) =>
            job.matrix === undefined
              ? job.name
              : `${job.name} (${matrixValues(job.matrix, combination).join(", ")})`,
          ),
        ]),
      );
    },
    async compile(pipeline: Pipeline, options: CompileOptions): Promise<readonly EmittedFile[]> {
      options.signal?.throwIfAborted();
      const comments = new Map<string, string>();
      if (pipeline.description !== undefined) comments.set("name", pipeline.description);
      if (pipeline.concurrency?.description !== undefined) {
        comments.set("concurrency", pipeline.concurrency.description);
      }

      const document: Record<string, unknown> = {
        name: pipeline.name,
        on: triggersOf(pipeline, comments),
        ...(pipeline.permissions === undefined
          ? {}
          : { permissions: permissionsOf(pipeline.permissions) }),
        ...(pipeline.concurrency === undefined
          ? {}
          : {
              concurrency: {
                group: renderTemplate(pipeline.concurrency.group, (token) =>
                  token.kind === "context"
                    ? `\${{ ${CONTEXT_EXPRESSION[token.key]} }}`
                    : `\${{ matrix.${token.name} }}`,
                ),
                "cancel-in-progress": pipeline.concurrency.cancelInProgress,
              },
            }),
        ...(pipeline.env === undefined ? {} : { env: envOf(pipeline.env) }),
        jobs: Object.fromEntries(
          Object.entries(pipeline.jobs).map(([id, job]) => {
            if (job.description !== undefined) comments.set(`jobs/${id}`, job.description);
            for (const [index, step] of job.steps.entries()) {
              if (step.description !== undefined) {
                comments.set(`jobs/${id}/steps/${String(index)}`, step.description);
              }
            }
            const form = job.form ?? pipeline.form ?? "native";
            if (form === "wrapper" && options.toolCommand === undefined) {
              throw new Error(
                `job ${id} renders in the wrapper form, which needs CompileOptions.toolCommand`,
              );
            }
            const wrapper =
              form === "wrapper" && options.toolCommand !== undefined
                ? { source: options.source, toolCommand: options.toolCommand }
                : undefined;

            return [id, jobOf(id, job, wrapper)];
          }),
        ),
      };

      return Promise.resolve([
        {
          path: `.github/workflows/${slugOf(pipeline.name)}.yml`,
          content: renderYaml(document, comments, generatedHeaderLines(options.source)),
        },
      ]);
    },
  };
}
