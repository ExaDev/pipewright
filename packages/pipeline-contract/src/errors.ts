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
