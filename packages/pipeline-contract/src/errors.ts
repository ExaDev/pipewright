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
