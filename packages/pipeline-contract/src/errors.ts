/**
 * Raised by a compiler when the model uses something its provider cannot express. Silently dropping or approximating the feature would emit a pipeline that behaves differently from the one authored, so every adapter fails loudly instead.
 */
export class UnsupportedFeatureError extends Error {
  readonly provider: string;

  /** JSON pointer, in the resolved pipeline, to the node that cannot be expressed. */
  readonly pointer: string;

  readonly feature: string;

  constructor(provider: string, pointer: string, feature: string) {
    super(`${provider} cannot express ${feature} at ${pointer === "" ? "/" : pointer}`);
    this.name = "UnsupportedFeatureError";
    this.provider = provider;
    this.pointer = pointer;
    this.feature = feature;
  }
}

/**
 * Raised by an importer when a provider's native file uses something the neutral model cannot express. Reading it anyway would produce a pipeline that behaves differently from the file, so every importer fails loudly instead, the same stance the compilers take in the other direction.
 */
export class UnsupportedNativeError extends Error {
  readonly provider: string;

  /** JSON pointer, in the parsed native document, to the node that cannot be expressed. */
  readonly pointer: string;

  readonly construct: string;

  constructor(provider: string, pointer: string, construct: string) {
    super(`${provider} file uses ${construct} at ${pointer === "" ? "/" : pointer}`);
    this.name = "UnsupportedNativeError";
    this.provider = provider;
    this.pointer = pointer;
    this.construct = construct;
  }
}

/**
 * Raised when an importer read a native file but the pipeline it built is not a valid model, for example a job name the model forbids. The pointers locate the offending nodes in the imported pipeline, not in the native file.
 */
export class ImportedPipelineError extends Error {
  readonly provider: string;

  readonly issues: readonly { readonly pointer: string; readonly message: string }[];

  constructor(
    provider: string,
    issues: readonly { readonly pointer: string; readonly message: string }[],
  ) {
    super(
      `${provider} file does not map to a valid pipeline: ${issues
        .map((issue) => `${issue.pointer === "" ? "/" : issue.pointer} ${issue.message}`)
        .join("; ")}`,
    );
    this.name = "ImportedPipelineError";
    this.provider = provider;
    this.issues = issues;
  }
}

/**
 * Closes an exhaustive `switch`: the argument is `never` only while every variant has a case, so adding a variant to a union fails compilation at each switch that forgot it.
 */
export function assertNever(value: never): never {
  throw new Error(`unhandled variant ${JSON.stringify(value)}`);
}

/**
 * Raised when a pipeline's `needs` do not form a dependency graph a provider can schedule: a `needs` target that is not a job, or a cycle. A parsed `Pipeline` never has either, so this signals a value that bypassed the schema; the details are carried so the caller can say exactly which edges are wrong.
 */
export class DependencyGraphError extends Error {
  /** Every `needs` entry naming a job that does not exist, once per job and target. */
  readonly unknownNeeds: readonly { readonly job: string; readonly missing: string }[];

  /** One closed path per cycle, each job needing the next and the last needing the first, repeated at the end. */
  readonly cycles: readonly (readonly string[])[];

  constructor(
    unknownNeeds: readonly { readonly job: string; readonly missing: string }[],
    cycles: readonly (readonly string[])[],
  ) {
    super(
      [
        ...unknownNeeds.map(({ job, missing }) => `job "${job}" needs unknown job "${missing}"`),
        ...cycles.map((path) => `needs form a cycle: ${path.join(" -> ")}`),
      ].join("; "),
    );
    this.name = "DependencyGraphError";
    this.unknownNeeds = unknownNeeds;
    this.cycles = cycles;
  }
}
