import { UnsupportedFeatureError } from "./errors.ts";
import type { Pipeline, ProviderId } from "./schema.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Deep-merges carrier entries into the mapping a compiler produced: records merge key by key with the carrier winning, and every other value replaces. The carrier holds provider-owned settings, so its word is later than the compiler's own output for the same key.
 */
export function mergeNative(
  emitted: Record<string, unknown>,
  native: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...emitted };
  for (const [key, value] of Object.entries(native)) {
    const own = merged[key];
    merged[key] = isRecord(own) && isRecord(value) ? mergeNative(own, value) : value;
  }

  return merged;
}

/**
 * The pipeline-level carrier entries for one provider, after checking the pipeline carries no other provider's settings. A pipeline-level setting changes what every job does, so a provider whose settings they are not rejects the pipeline by pointer rather than running the jobs without them.
 */
export function nativeOf(pipeline: Pipeline, provider: ProviderId): Record<string, unknown> {
  const entries = pipeline.native ?? {};
  for (const other of Object.keys(entries)) {
    if (other !== provider) {
      throw new UnsupportedFeatureError(
        provider,
        `/native/${other}`,
        `pipeline-level settings owned by ${other}, which change what every job does`,
      );
    }
  }

  return entries[provider] ?? {};
}
