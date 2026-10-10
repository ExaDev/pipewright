import {
  UnsupportedFeatureError,
  compilePredicate,
  expandMatrix,
  renderTemplate,
  type ContextKey,
  type Job,
  type JobReport,
  type MatrixCombination,
  type Operand,
  type Outcome,
  type Pipeline,
  type PipelineRunner,
  type PredicateHandlers,
  type PredicateNode,
  type RunContext,
  type RunOptions,
  type Step,
  type StepReport,
} from "@pipewright/pipeline-contract";

const PROVIDER = "local";

interface Scope {
  readonly context: RunContext;
  readonly matrix: MatrixCombination;
}

type Condition = (scope: Scope) => boolean;

function contextValue(context: RunContext, key: ContextKey): string {
  const value = context[key];
  if (value === undefined) {
    throw new Error(
      `the context value ${key} was read but the host did not supply it; pass --context ${key}=<value>`,
    );
  }

  return value;
}

function operandValue(operand: Operand, scope: Scope): string {
  if (operand.kind === "context") return contextValue(scope.context, operand.key);
  if (operand.kind === "matrix") return String(scope.matrix[operand.name]);

  return operand.value;
}

function sameText(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

/**
 * The runner's whole condition language. It is the set the neutral model defines, so a condition either adapter accepts evaluates here identically.
 */
const handlers: PredicateHandlers<Condition> = {
  not: (operand) => (scope) => !operand(scope),
  and: (left, right) => (scope) => left(scope) && right(scope),
  or: (left, right) => (scope) => left(scope) || right(scope),
  allOf: (operands) => (scope) => operands.every((operand) => operand(scope)),
  anyOf: (operands) => (scope) => operands.some((operand) => operand(scope)),
  equals: (left, right, negated) => (scope) =>
    sameText(operandValue(left, scope), operandValue(right, scope)) !== negated,
  memberOf: (operand, candidates, negated) => (scope) =>
    candidates.some((candidate) =>
      sameText(operandValue(operand, scope), operandValue(candidate, scope)),
    ) !== negated,
};

function conditionOf(predicate: PredicateNode | undefined, pointer: string): Condition {
  if (predicate === undefined) return () => true;

  return compilePredicate(predicate, handlers, { provider: PROVIDER, pointer });
}

function orderedJobIds(pipeline: Pipeline): string[] {
  const ordered: string[] = [];
  const placed = new Set<string>();
  const place = (id: string): void => {
    if (placed.has(id)) return;
    placed.add(id);
    for (const needed of pipeline.jobs[id]?.needs ?? []) place(needed);
    ordered.push(id);
  };
  for (const id of Object.keys(pipeline.jobs)) place(id);

  return ordered;
}

function resolveEnv(
  env: Readonly<Record<string, string>> | undefined,
  scope: Scope,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env ?? {}).map(([key, value]) => [
      key,
      renderTemplate(value, (token) =>
        token.kind === "context"
          ? contextValue(scope.context, token.key)
          : String(scope.matrix[token.name]),
      ),
    ]),
  );
}

function stepName(step: Step): string {
  if (step.name !== undefined) return step.name;

  return step.kind === "run" ? step.run : step.kind;
}

/**
 * Runs `work` over `items` one at a time, in order, collecting the results. A promise chain rather than a loop keeps the sequencing explicit: each item starts only after the previous one has finished.
 */
async function inSequence<Item, Result>(
  items: readonly Item[],
  work: (item: Item) => Promise<Result>,
): Promise<Result[]> {
  return items.reduce<Promise<Result[]>>(async (previous, item) => {
    const results = await previous;

    return [...results, await work(item)];
  }, Promise.resolve([]));
}

interface JobPlan {
  readonly id: string;
  readonly job: Job;
  readonly pipeline: Pipeline;
  readonly options: RunOptions;
  readonly jobCondition: Condition;
  readonly stepConditions: readonly Condition[];
  /** False when an earlier job failed or was skipped and this job does not run regardless. */
  readonly mayRun: boolean;
  /** A gate reports failure when a job it needs did not succeed, rather than being skipped. */
  readonly failsGate: boolean;
}

function inRange(options: RunOptions, index: number): boolean {
  return options.steps === undefined || (index >= options.steps.from && index <= options.steps.to);
}

async function runStep(plan: JobPlan, scope: Scope, step: Step, index: number): Promise<Outcome> {
  const condition = plan.stepConditions[index];
  if (condition === undefined || !inRange(plan.options, index) || !condition(scope)) {
    return "skipped";
  }
  if (step.kind === "provider") return "skipped";
  if (step.kind !== "run") return "success";
  const result = await plan.options.executor.execute(
    {
      command: step.run,
      env: {
        ...resolveEnv(plan.pipeline.env, scope),
        ...resolveEnv(plan.job.env, scope),
        ...resolveEnv(step.env, scope),
      },
      workingDirectory: step.workingDirectory,
    },
    plan.options.signal,
  );

  return result.exitCode === 0 ? "success" : "failure";
}

async function runCombination(plan: JobPlan, matrix: MatrixCombination): Promise<JobReport> {
  const scope: Scope = { context: plan.options.context, matrix };
  const { job, id } = plan;
  const skippedSteps = job.steps.map((step) => ({
    name: stepName(step),
    outcome: "skipped" as const,
  }));
  // A gate's condition is read first, because the gate is evaluated even after a failed dependency and its own condition decides whether it reports. Any other job is not evaluated at all once a dependency has not succeeded, so a condition over a value the host never supplied cannot mask the upstream failure.
  if (plan.failsGate) {
    return {
      id,
      name: job.name,
      matrix,
      outcome: plan.jobCondition(scope) ? "failure" : "skipped",
      steps: skippedSteps,
    };
  }
  if (!plan.mayRun || !plan.jobCondition(scope)) {
    return {
      id,
      name: job.name,
      matrix,
      outcome: "skipped",
      steps: job.steps.map((step) => ({ name: stepName(step), outcome: "skipped" })),
    };
  }

  const steps = await job.steps.reduce<Promise<StepReport[]>>(async (previous, step, index) => {
    const reports = await previous;
    const failed = reports.some((report) => report.outcome === "failure");
    const outcome = failed ? "skipped" : await runStep(plan, scope, step, index);

    return [...reports, { name: stepName(step), outcome }];
  }, Promise.resolve([]));

  return {
    id,
    name: job.name,
    matrix,
    outcome: steps.some((report) => report.outcome === "failure") ? "failure" : "success",
    steps,
  };
}

function combinationsOf(job: Job, id: string, options: RunOptions): MatrixCombination[] {
  const combinations = expandMatrix(job.matrix).filter((combination) =>
    Object.entries(options.matrix ?? {}).every(
      ([axis, value]) => String(combination[axis]) === String(value),
    ),
  );
  if (combinations.length === 0) {
    throw new Error(`no matrix combination of job ${id} matches ${JSON.stringify(options.matrix)}`);
  }

  return combinations;
}

function checkPortable(id: string, job: Job, options: RunOptions): void {
  for (const [index, step] of job.steps.entries()) {
    if (step.kind === "provider" && inRange(options, index) && options.skipProviderSteps !== true) {
      throw new UnsupportedFeatureError(
        PROVIDER,
        `/jobs/${id}/steps/${String(index)}`,
        `a step owned by ${step.provider}`,
      );
    }
  }
}

function aggregate(reports: readonly JobReport[]): Outcome {
  if (reports.some((report) => report.outcome === "failure")) return "failure";
  if (reports.some((report) => report.outcome === "skipped")) return "skipped";

  return "success";
}

/**
 * Runs a pipeline in-process by asking an injected executor to run each `run` step. No provider configuration is emitted, so this is the way to use a pipeline without ever synthesising a workflow file: from a terminal, from a static bootstrap workflow, or under test.
 *
 * A job with a matrix runs once per combination, sequentially. `checkout` is a no-op, because the host has already placed the working tree.
 */
export function createLocalRunner(): PipelineRunner {
  return {
    async run(pipeline, options) {
      const selected = options.only === undefined ? undefined : new Set(options.only);
      const ids = orderedJobIds(pipeline).filter(
        (id) => selected === undefined || selected.has(id),
      );
      const outcomes = new Map<string, Outcome>();

      const jobReports = await inSequence(ids, async (id) => {
        const job = pipeline.jobs[id];
        if (job === undefined) throw new Error(`unknown job ${id}`);
        checkPortable(id, job, options);

        const needsSatisfied =
          selected !== undefined ||
          (job.needs ?? []).every((needed) => outcomes.get(needed) === "success");
        const plan: JobPlan = {
          id,
          job,
          pipeline,
          options,
          jobCondition:
            selected === undefined ? conditionOf(job.when, `/jobs/${id}/when`) : () => true,
          stepConditions: job.steps.map((step, index) =>
            conditionOf(step.when, `/jobs/${id}/steps/${String(index)}/when`),
          ),
          mayRun: job.needsPolicy === "always" || needsSatisfied,
          failsGate: job.needsPolicy === "gate" && !needsSatisfied,
        };
        const reports = await inSequence(combinationsOf(job, id, options), async (matrix) =>
          runCombination(plan, matrix),
        );
        outcomes.set(id, aggregate(reports));

        return reports;
      });

      const reports = jobReports.flat();

      return { jobs: reports, ok: reports.every((report) => report.outcome !== "failure") };
    },
  };
}
