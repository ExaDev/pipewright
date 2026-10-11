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
  type StepFileContents,
  type StepReport,
} from "@pipewright/pipeline-contract";

import {
  applyMasks,
  parseKeyValueFile,
  parsePathFile,
  parseStdoutLine,
  preferredPaths,
  type FileEntry,
} from "./file-commands.ts";

const PROVIDER = "local";

/** The environment variables that carry the command files, as the command itself sees them. */
const OUTPUT_VARIABLE = "GITHUB_OUTPUT";
const ENV_VARIABLE = "GITHUB_ENV";
const PATH_VARIABLE = "GITHUB_PATH";
const SUMMARY_VARIABLE = "GITHUB_STEP_SUMMARY";

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

/** What one run of a job accumulates from its steps, as a runner process does on the host provider. Scoped to the job run, because no two job runs share a machine. */
interface JobRunState {
  /** Entries the steps wrote to their environment file, below the env the pipeline itself declares. */
  readonly env: Record<string, string>;
  /** Path entries the steps wrote, most preferred first; the host joins them onto the PATH it started from. Replaced, not appended, when a step writes more. */
  pathEntries: string[];
  /** Values the steps asked to mask, in the order they were registered. */
  readonly masks: string[];
}

/** The state one matrix combination runs against: what its steps read and what they accumulate. */
interface CombinationRun {
  readonly scope: Scope;
  readonly state: JobRunState;
}

/** What running one step produced: its report entry and what it handed to the job's later steps. */
interface StepRun {
  readonly outcome: Outcome;
  readonly outputs: Readonly<Record<string, string>>;
  /** Entries the step wrote to its environment file, applied to the job's later steps. */
  readonly env: readonly FileEntry[];
  /** Directories the step added, applied to the job's later steps. */
  readonly paths: readonly string[];
  /** The summary the step wrote, masked, when it wrote one. */
  readonly summary: string | undefined;
}

function inRange(options: RunOptions, index: number): boolean {
  return options.steps === undefined || (index >= options.steps.from && index <= options.steps.to);
}

function recordOf(entries: readonly FileEntry[]): Record<string, string> {
  return Object.fromEntries(entries.map((entry) => [entry.key, entry.value]));
}

/**
 * Reads the workflow command stream from one step's stdout and echoes the rest through the run's output, masked. A mask covers only the lines after the command that registered it, as a runner reading the stream live does.
 */
/**
 * A step's stderr carries no workflow commands, but it can carry a masked value, so each line is emitted through the masks the run has registered.
 */
function processStderr(plan: JobPlan, state: JobRunState, step: Step, stderr: string): void {
  if (stderr === "") return;
  const lines = stderr.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  for (const ended of lines) {
    const line = ended.endsWith("\r") ? ended.slice(0, -1) : ended;
    plan.options.output.log({
      job: plan.job.name,
      step: stepName(step),
      level: "info",
      message: applyMasks(line, state.masks),
    });
  }
}

function processStdout(plan: JobPlan, state: JobRunState, step: Step, stdout: string): void {
  const lines = stdout.split("\n");
  // A trailing newline ends the last line rather than starting an empty one, and a line's own CR is dropped, so a command emitted with CRLF line endings is still read.
  if (lines[lines.length - 1] === "") lines.pop();
  for (const ended of lines) {
    const line = ended.endsWith("\r") ? ended.slice(0, -1) : ended;
    const parsed = parseStdoutLine(line);
    if (parsed.kind === "command") {
      if (parsed.command.kind === "mask") {
        state.masks.push(parsed.command.value);
        continue;
      }
      plan.options.output.log({
        job: plan.job.name,
        step: stepName(step),
        level: parsed.command.level,
        message: applyMasks(parsed.command.message, state.masks),
        ...(parsed.command.annotation === undefined
          ? {}
          : {
              // The annotation's own strings can carry a masked value as the message can, so they go through the same masks.
              annotation: {
                ...parsed.command.annotation,
                ...(parsed.command.annotation.file === undefined
                  ? {}
                  : { file: applyMasks(parsed.command.annotation.file, state.masks) }),
                ...(parsed.command.annotation.title === undefined
                  ? {}
                  : { title: applyMasks(parsed.command.annotation.title, state.masks) }),
              },
            }),
      });
      continue;
    }
    plan.options.output.log({
      job: plan.job.name,
      step: stepName(step),
      level: "info",
      message: applyMasks(parsed.text, state.masks),
    });
  }
}

async function runStep(
  plan: JobPlan,
  combination: CombinationRun,
  step: Step,
  index: number,
): Promise<StepRun> {
  const { scope, state } = combination;
  const condition = plan.stepConditions[index];
  if (condition === undefined || !inRange(plan.options, index) || !condition(scope)) {
    return { outcome: "skipped", outputs: {}, env: [], paths: [], summary: undefined };
  }
  if (step.kind === "provider") {
    return { outcome: "skipped", outputs: {}, env: [], paths: [], summary: undefined };
  }
  if (step.kind !== "run") {
    return { outcome: "success", outputs: {}, env: [], paths: [], summary: undefined };
  }
  const files = await plan.options.scratch.create();
  const result = await plan.options.executor.execute(
    {
      command: step.run,
      env: {
        ...state.env,
        ...resolveEnv(plan.pipeline.env, scope),
        ...resolveEnv(plan.job.env, scope),
        ...resolveEnv(step.env, scope),
        [OUTPUT_VARIABLE]: files.output,
        [ENV_VARIABLE]: files.env,
        [PATH_VARIABLE]: files.path,
        [SUMMARY_VARIABLE]: files.summary,
      },
      workingDirectory: step.workingDirectory,
      pathEntries: [...state.pathEntries],
    },
    plan.options.signal,
  );
  let contents: StepFileContents;
  try {
    processStdout(plan, state, step, result.stdout);
    processStderr(plan, state, step, result.stderr);
    contents = await plan.options.scratch.read(files);
  } finally {
    // The files go even when reading or the command stream throws, so a failure leaves nothing a later process can read.
    await plan.options.scratch.release(files);
  }

  return {
    outcome: result.exitCode === 0 ? "success" : "failure",
    outputs: recordOf(parseKeyValueFile(files.output, contents.output)),
    env: parseKeyValueFile(files.env, contents.env),
    paths: parsePathFile(contents.path),
    summary: contents.summary === "" ? undefined : applyMasks(contents.summary, state.masks),
  };
}

async function runCombination(plan: JobPlan, matrix: MatrixCombination): Promise<JobReport> {
  const state: JobRunState = { env: {}, pathEntries: [], masks: [] };
  const combination: CombinationRun = { scope: { context: plan.options.context, matrix }, state };
  const { job, id } = plan;
  const skippedSteps = job.steps.map((step) => ({
    name: stepName(step),
    outcome: "skipped" as const,
    outputs: {},
  }));
  // A gate's condition is read first, because the gate is evaluated even after a failed dependency and its own condition decides whether it reports. Any other job is not evaluated at all once a dependency has not succeeded, so a condition over a value the host never supplied cannot mask the upstream failure.
  if (plan.failsGate) {
    return {
      id,
      name: job.name,
      matrix,
      outcome: plan.jobCondition(combination.scope) ? "failure" : "skipped",
      steps: skippedSteps,
    };
  }
  if (!plan.mayRun || !plan.jobCondition(combination.scope)) {
    return {
      id,
      name: job.name,
      matrix,
      outcome: "skipped",
      steps: skippedSteps,
    };
  }

  const steps = await job.steps.reduce<Promise<StepReport[]>>(async (previous, step, index) => {
    const reports = await previous;
    const failed = reports.some((report) => report.outcome === "failure");
    const run = failed
      ? { outcome: "skipped" as const, outputs: {}, env: [], paths: [], summary: undefined }
      : await runStep(plan, combination, step, index);
    for (const entry of run.env) state.env[entry.key] = entry.value;
    state.pathEntries = preferredPaths(run.paths, state.pathEntries);
    if (run.summary !== undefined) {
      plan.options.output.summary({ job: job.name, step: stepName(step), text: run.summary });
    }

    return [...reports, { name: stepName(step), outcome: run.outcome, outputs: run.outputs }];
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
 *
 * Around each step the runner applies the provider's file commands: it asks the host's scratch for fresh command files and passes their paths in the command's environment, then reads what the step wrote, records its outputs, and carries its environment and path entries to the job's later steps. The step's stdout is read for workflow commands, whose masks and levels are applied to the run's output.
 */
export function createLocalRunner(): PipelineRunner {
  return {
    async run(pipeline, options) {
      const selected = options.only === undefined ? undefined : new Set(options.only);
      const ids = orderedJobIds(pipeline).filter(
        (id) => selected === undefined || selected.has(id),
      );
      const outcomes = new Map<string, Outcome>();

      let jobReports;
      try {
        jobReports = await inSequence(ids, async (id) => {
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
      } finally {
        // The scratch root goes even when a job threw, so a failed run leaves nothing behind.
        await options.scratch.dispose();
      }

      const reports = jobReports.flat();

      return { jobs: reports, ok: reports.every((report) => report.outcome !== "failure") };
    },
  };
}
