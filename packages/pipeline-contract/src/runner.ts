import type { ContextKey } from "./context.ts";
import type { MatrixCombination } from "./matrix.ts";
import type { Job, Pipeline, Step } from "./schema.ts";

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
 * What one step of the job produced, kept beside the step itself so a host can read the identity a provider gave it, which the report alone no longer carries once a provider step can resolve to several.
 */
export interface StepRecord {
  readonly step: Step;
  readonly outcome: Outcome;
  /** The outputs the step declared through its output file; for a step a host resolved into several, every output they wrote. */
  readonly outputs: Readonly<Record<string, string>>;
}

/** The run's state a job's steps are prepared against, before any of them has run. */
export interface JobView {
  readonly context: RunContext;
  readonly matrix: MatrixCombination;
  /** The result of each job this one needs that has run, by job id. A job this run does not execute is absent, so a provider's expression reads it the way an absent value reads. */
  readonly needs: Readonly<Record<string, Outcome>>;
  /** The environment the job's steps inherit before any of them adds to it: the pipeline's and the job's own values, rendered for this combination. */
  readonly env: Readonly<Record<string, string>>;
  /** The inclusive range of the job's own step indexes this run will execute, or undefined when it will execute them all. Preparation resolves actions whose steps run, so a step outside the range contributes nothing, not even the phases its action declares. */
  readonly range: { readonly from: number; readonly to: number } | undefined;
}

/** A job view plus what the job's steps have left behind so far. */
export interface StepView extends JobView {
  /** Every step of this job that has settled, in order, each with the outcome and outputs the run recorded. */
  readonly steps: readonly StepRecord[];
}

/** One command a host resolved a provider step into: everything the runner needs, with no expression of the provider's left unevaluated. */
export interface PreparedStep {
  /** The name the step's report entries and log lines carry. */
  readonly name: string;
  readonly command: string;
  /** The step's own environment, final values; the runner composes the pipeline's, the job's and what earlier steps wrote around it. */
  readonly env: Readonly<Record<string, string>>;
  readonly workingDirectory: string | undefined;
}

/** What a host answers when the run reaches a provider step. */
export type StepResolution =
  /** The steps to run where the provider step stood, in order; each gets the runner's file commands and its own report entry, and the first failure stops the rest. */
  | { readonly kind: "steps"; readonly steps: readonly PreparedStep[] }
  | { readonly kind: "skipped" }
  /** A provider step this host does not run; the runner rejects the run naming the construct. */
  | { readonly kind: "unhandled"; readonly construct: string };

/** A job's steps as the host prepares them: the list to run and any environment the host adds at job level. */
export interface JobExpansion {
  readonly steps: readonly Step[];
  /** Job-level environment the host supplies for this provider's steps, final values, composed over the pipeline's and the job's own. */
  readonly env: Readonly<Record<string, string>>;
}

/**
 * The host's port for provider steps, which have no meaning outside their provider. A host that supplies one takes over both moments a provider step is reached: before the job runs, when the steps are prepared (a host places the phases an imported action declares around the job's own steps and adds whatever job-level environment its provider carries), and when the run reaches one of the steps the preparation left in place, when the host resolves it into what runs. The runner calls no other port in between, so a host's expressions evaluate against exactly the view each call receives.
 */
export interface StepHost {
  /** Called once per job and matrix combination that will run, before any of its steps. */
  readonly expand: (job: Job, view: JobView) => Promise<JobExpansion>;
  /** Called when the run reaches a provider step the preparation left in place. */
  readonly resolve: (step: Step, view: StepView) => Promise<StepResolution>;
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
  /** The host's port for provider steps. Supplied, it replaces the upfront rejection of a provider step: the host prepares the job's steps before it runs and resolves each provider step when the run reaches it. */
  readonly host?: StepHost;
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
