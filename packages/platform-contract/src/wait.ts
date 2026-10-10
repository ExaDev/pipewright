import type { CiPlatformReader } from "./contract.ts";
import type { Check } from "./schema.ts";

/**
 * Time is an injected port so waiting is deterministic under test and never reads a wall clock.
 */
export interface Clock {
  sleep(milliseconds: number, signal?: AbortSignal): Promise<void>;
}

export interface WaitOptions {
  readonly sha: string;
  /** The check names that must complete. When omitted, every check currently reported for the commit must complete. */
  readonly required?: readonly string[];
  /** Delay between polls. There is no default: the right value depends on the provider's rate limits and the caller's patience. */
  readonly pollIntervalMs: number;
  /** Maximum number of polls before giving up, so a check that never appears fails the wait. */
  readonly maxPolls: number;
  readonly signal?: AbortSignal;
}

export class WaitExhaustedError extends Error {
  readonly pending: readonly string[];

  constructor(pending: readonly string[]) {
    super(`checks did not complete: ${pending.join(", ")}`);
    this.name = "WaitExhaustedError";
    this.pending = pending;
  }
}

function pendingNames(
  checks: readonly Check[],
  required: readonly string[] | undefined,
): string[] {
  const byName = new Map(checks.map((check) => [check.name, check]));
  const names = required ?? checks.map((check) => check.name);
  return names.filter((name) => byName.get(name)?.status !== "completed");
}

/**
 * Polls `reader.listChecks` until the awaited checks have all completed and returns the final listing. A check that is required but not yet reported counts as pending.
 */
export async function waitForChecks(
  reader: CiPlatformReader,
  clock: Clock,
  options: WaitOptions,
): Promise<readonly Check[]> {
  let pending: readonly string[] = [];
  for (let poll = 0; poll < options.maxPolls; poll += 1) {
    const checks = await reader.listChecks(options.sha, options.signal);
    pending = pendingNames(checks, options.required);
    if (pending.length === 0 && (options.required !== undefined || checks.length > 0)) {
      return checks;
    }
    await clock.sleep(options.pollIntervalMs, options.signal);
  }
  throw new WaitExhaustedError(pending);
}
