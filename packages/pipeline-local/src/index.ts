import {
  UnsupportedFeatureError,
  compilePredicate,
  expandMatrix,
  renderTemplate,
  type Job,
  type MatrixCombination,
  type Operand,
  type Outcome,
  type Pipeline,
  type PipelineRunner,
  type RunContext,
  type StepReport,
  type JobReport,
  type PredicateHandlers,
  type PredicateNode,
} from "@ci-adapters/pipeline-contract";

const PROVIDER = "local";

interface Scope {
  readonly context: RunContext;
  readonly matrix: MatrixCombination;
}

type Condition = (scope: Scope) => boolean;

function operandValue(operand: Operand, scope: Scope): string {
  switch (operand.kind) {
    case "context":
      return scope.context[operand.key];
    case "matrix":
      return String(scope.matrix[operand.name]);
    case "text":
      return operand.value;
  }
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
        token.kind === "context" ? scope.context[token.key] : String(scope.matrix[token.name]),
      ),
    ]),
  );
}

function stepName(job: Job, index: number): string {
  const step = job.steps[index];
  if (step === undefined) throw new Error(`job ${job.name} has no step ${index}`);
  if (step.name !== undefined) return step.name;
  return step.kind === "run" ? step.run : step.kind;
}

/**
 * Runs a pipeline in-process by asking an injected executor to run each `run` step. No provider configuration is emitted, so this is the way to use a pipeline without ever synthesising a workflow file: from a terminal, from a static bootstrap workflow, or under test.
 *
 * A job with a matrix runs once per combination, sequentially. `checkout` is a no-op, because the host has already placed the working tree.
 */
export function createLocalRunner(): PipelineRunner {
  return {
    async run(pipeline, options) {
      const reports: JobReport[] = [];
      const jobOutcomes = new Map<string, Outcome>();
      const selected = options.only === undefined ? undefined : new Set(options.only);

      for (const id of orderedJobIds(pipeline)) {
        const job = pipeline.jobs[id];
        if (job === undefined) continue;
        if (selected !== undefined && !selected.has(id)) continue;

        const jobCondition =
          selected === undefined
            ? conditionOf(job.when, `/jobs/${id}/when`)
            : (): boolean => true;
        const inRange = (index: number): boolean =>
          options.steps === undefined ||
          (index >= options.steps.from && index <= options.steps.to);
        const stepConditions = job.steps.map((step, index) =>
          conditionOf(step.when, `/jobs/${id}/steps/${index}/when`),
        );
        for (const [index, step] of job.steps.entries()) {
          if (step.kind === "provider" && inRange(index)) {
            throw new UnsupportedFeatureError(
              PROVIDER,
              `/jobs/${id}/steps/${index}`,
              `a step owned by ${step.provider}`,
            );
          }
        }

        const needsSatisfied =
          selected !== undefined ||
          (job.needs ?? []).every((needed) => jobOutcomes.get(needed) === "success");
        const mayRun = job.needsPolicy === "always" || needsSatisfied;

        let aggregate: Outcome = "success";
        const combinations = expandMatrix(job.matrix).filter((combination) =>
          Object.entries(options.matrix ?? {}).every(
            ([axis, value]) => String(combination[axis]) === String(value),
          ),
        );
        if (combinations.length === 0) {
          throw new Error(
            `no matrix combination of job ${id} matches ${JSON.stringify(options.matrix)}`,
          );
        }
        for (const matrix of combinations) {
          const scope: Scope = { context: options.context, matrix };
          const steps: StepReport[] = [];
          let outcome: Outcome;

          if (!mayRun || !jobCondition(scope)) {
            outcome = "skipped";
            for (const [index] of job.steps.entries()) {
              steps.push({ name: stepName(job, index), outcome: "skipped" });
            }
          } else {
            outcome = "success";
            for (const [index, step] of job.steps.entries()) {
              const name = stepName(job, index);
              const condition = stepConditions[index];
              if (
                outcome === "failure" ||
                condition === undefined ||
                !inRange(index) ||
                !condition(scope)
              ) {
                steps.push({ name, outcome: "skipped" });
                continue;
              }
              if (step.kind === "checkout") {
                steps.push({ name, outcome: "success" });
                continue;
              }
              if (step.kind !== "run") continue;
              const result = await options.executor.execute(
                {
                  command: step.run,
                  env: {
                    ...resolveEnv(pipeline.env, scope),
                    ...resolveEnv(job.env, scope),
                    ...resolveEnv(step.env, scope),
                  },
                  workingDirectory: step.workingDirectory,
                },
                options.signal,
              );
              const stepOutcome: Outcome = result.exitCode === 0 ? "success" : "failure";
              steps.push({ name, outcome: stepOutcome });
              if (stepOutcome === "failure") outcome = "failure";
            }
          }

          reports.push({ id, name: job.name, matrix, outcome, steps });
          if (outcome === "failure") aggregate = "failure";
          else if (outcome === "skipped" && aggregate === "success") aggregate = "skipped";
        }
        jobOutcomes.set(id, aggregate);
      }

      return { jobs: reports, ok: reports.every((report) => report.outcome !== "failure") };
    },
  };
}
