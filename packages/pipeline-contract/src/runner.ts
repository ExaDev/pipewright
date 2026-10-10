import type { ContextKey } from "./context.ts";
import type { MatrixCombination } from "./matrix.ts";
import type { Pipeline } from "./schema.ts";

/**
 * One command a runner asks its host to run. The runner never spawns processes itself, so the same runner executes in a CI job, on a laptop or under test.
 */
export interface CommandExecution {
  readonly command: string;
  readonly env: Readonly<Record<string, string>>;
  readonly workingDirectory: string | undefined;
}

export interface CommandResult {
  readonly exitCode: number;
}

export interface CommandExecutor {
  execute(command: CommandExecution, signal?: AbortSignal): Promise<CommandResult>;
}

/**
 * The neutral context values for one run, supplied by whoever hosts the runner.
 */
export type RunContext = Readonly<Record<ContextKey, string>>;

export type Outcome = "success" | "failure" | "skipped";

export interface StepReport {
  readonly name: string;
  readonly outcome: Outcome;
}

export interface JobReport {
  readonly id: string;
  readonly name: string;
  /** The matrix combination this entry ran, empty when the job has no matrix. */
  readonly matrix: MatrixCombination;
  readonly outcome: Outcome;
  readonly steps: readonly StepReport[];
}

export interface RunReport {
  readonly jobs: readonly JobReport[];
  /** True when no job failed. A skipped job is not a failure. */
  readonly ok: boolean;
}

export interface RunOptions {
  readonly executor: CommandExecutor;
  readonly context: RunContext;
  /** Run only these job ids, treating their `needs` as already satisfied; every job when omitted. */
  readonly only?: readonly string[];
  readonly signal?: AbortSignal;
}

/**
 * Executes a pipeline directly, without emitting provider configuration. This is the interpreted counterpart of `PipelineCompiler`: a provider's static bootstrap workflow, or a developer's terminal, runs the model itself.
 *
 * Pre: `pipeline` has passed `pipelineSchema`. Post: jobs run in `needs` order; a job runs only when its needs succeeded (or `needsPolicy` is `always`) and its `when` holds; the first failing step skips the rest of its job. Errors: throws `UnsupportedFeatureError` for a `provider` step, which has no meaning outside its provider.
 */
export interface PipelineRunner {
  run(pipeline: Pipeline, options: RunOptions): Promise<RunReport>;
}
