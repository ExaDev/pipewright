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
  /** Directories to search before the host's own `PATH`, most preferred first: the additions the job's earlier steps declared, which only the host can join onto the `PATH` it started from. */
  readonly pathEntries: readonly string[];
}

export interface CommandResult {
  readonly exitCode: number;
  /** Everything the command wrote to stdout, which the runner reads for workflow commands and echoes through the run's output after masking. */
  readonly stdout: string;
  /** Everything the command wrote to stderr, which carries no workflow commands but can carry a masked value, so the runner emits it through the same masks. */
  readonly stderr: string;
}

/** The severity a log entry carries. `info` is a step's ordinary output. */
export type LogLevel = "info" | "debug" | "warning" | "error" | "notice";

/** Where in the repository a log entry points, as the command that raised it stated. */
export interface Annotation {
  readonly file?: string;
  readonly line?: number;
  readonly endLine?: number;
  readonly title?: string;
}

/** One piece of a run's output: a line of a step's stdout after masking, or a command the step routed to a level. */
export interface LogEntry {
  readonly job: string;
  readonly step: string;
  readonly level: LogLevel;
  readonly message: string;
  readonly annotation?: Annotation;
}

/** A step's summary markdown, as the step wrote it to its summary file. */
export interface StepSummary {
  readonly job: string;
  readonly step: string;
  readonly text: string;
}

/**
 * Where a run's output goes, supplied by whoever hosts the runner: each step's stdout after masking, the levels workflow commands were routed to, and each step's summary. The runner writes nowhere else, so a host that discards it silences the run.
 */
export interface RunOutput {
  readonly log: (entry: LogEntry) => void;
  readonly summary: (summary: StepSummary) => void;
}

/** The paths of the command files one step communicates through, named by the environment variable that carries each. */
export interface StepCommandFiles {
  readonly output: string;
  readonly env: string;
  readonly path: string;
  readonly summary: string;
}

/** What a step wrote to its command files. */
export interface StepFileContents {
  readonly output: string;
  readonly env: string;
  readonly path: string;
  readonly summary: string;
}

/**
 * Allocates, reads and reclaims the per-step command files, the runner's filesystem boundary: the runner never touches a filesystem itself, so the host creates each step's files empty before the command runs, reads them back after it exits and removes them once read, so one step can never read what another wrote, not even from disk.
 */
export interface StepScratch {
  readonly create: () => Promise<StepCommandFiles>;
  readonly read: (files: StepCommandFiles) => Promise<StepFileContents>;
  /** Called once the runner has read a step's files, so the host removes them: a later step's process must not be able to read what an earlier one wrote. */
  readonly release: (files: StepCommandFiles) => Promise<void>;
  /** Called when the run ends, so the host removes the scratch root and nothing the run wrote outlives it. */
  readonly dispose: () => Promise<void>;
}

export interface CommandExecutor {
  execute: (command: CommandExecution, signal?: AbortSignal) => Promise<CommandResult>;
}

/**
 * The neutral context values for one run, supplied by whoever hosts the runner. A host supplies the values its provider can, and a value a step or condition actually reads but the host did not supply is an error at that point, so a command that needs no context runs wherever it is hosted.
 */
export type RunContext = Readonly<Partial<Record<ContextKey, string>>>;

export type Outcome = "success" | "failure" | "skipped";

export interface StepReport {
  readonly name: string;
  readonly outcome: Outcome;
  /** The outputs the step declared through its output file, so later steps and the report consumer can read them. */
  readonly outputs: Readonly<Record<string, string>>;
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
  /** Allocates and reads each step's command files, the runner's filesystem boundary. */
  readonly scratch: StepScratch;
  /** Receives the run's output: step stdout after masking, the levels commands were routed to, and summaries. */
  readonly output: RunOutput;
  readonly context: RunContext;
  /** Run only these job ids; every job when omitted. The host has already decided to run them, so their `needs` and job-level `when` are treated as satisfied. */
  readonly only?: readonly string[];
  /** Run only the matrix combinations that agree with these axis values. Throws when none do. */
  readonly matrix?: MatrixCombination;
  /** Run only the steps with these inclusive indexes, reporting the rest as skipped. Only steps inside the range are checked for being portable. */
  readonly steps?: { readonly from: number; readonly to: number };
  /** Report steps owned by a provider as skipped instead of rejecting them, for a host that has supplied the toolchain those steps would install. */
  readonly skipProviderSteps?: boolean;
  readonly signal?: AbortSignal;
}

/**
 * Executes a pipeline directly, without emitting provider configuration. This is the interpreted counterpart of `PipelineCompiler`: a provider's static bootstrap workflow, or a developer's terminal, runs the model itself.
 *
 * Pre: `pipeline` has passed `pipelineSchema`. Post: jobs run in `needs` order; a job runs only when its needs succeeded (or `needsPolicy` is `always`) and its `when` holds; the first failing step skips the rest of its job. Errors: throws `UnsupportedFeatureError` for a `provider` step, which has no meaning outside its provider.
 */
export interface PipelineRunner {
  run: (pipeline: Pipeline, options: RunOptions) => Promise<RunReport>;
}
