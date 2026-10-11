import {
  conclusionSchema,
  runSchema,
  type Conclusion,
  type Run,
} from "@pipewright/platform-contract";
import { z } from "zod";

/**
 * One correspondence between GitHub's spelling of a value and the neutral one, written once as a list of pairs, so decoding and encoding are derived from the same definition and cannot disagree.
 */
class Correspondence<Wire extends string, Neutral extends string> {
  private readonly toNeutral: ReadonlyMap<string, Neutral>;

  private readonly toWire: ReadonlyMap<Neutral, Wire>;

  constructor(
    pairs: readonly (readonly [Wire, Neutral])[],
    aliases: readonly (readonly [string, Neutral])[] = [],
  ) {
    this.toNeutral = new Map<string, Neutral>([...pairs, ...aliases]);
    this.toWire = new Map(pairs.map(([wire, neutral]) => [neutral, wire]));
  }

  /** The neutral value for a wire spelling, or `undefined` when GitHub sent one this adapter has no meaning for. */
  decode(wire: string): Neutral | undefined {
    return this.toNeutral.get(wire);
  }

  /** The wire spelling for a neutral value. */
  encode(neutral: Neutral): Wire {
    const wire = this.toWire.get(neutral);
    if (wire === undefined) throw new Error(`no GitHub spelling is defined for "${neutral}"`);

    return wire;
  }
}

type NeutralStatus = "queued" | "running" | "waiting" | "completed";

/** GitHub reports a run that has not started as `queued`, `requested` or `pending`; all three decode to `queued`, and `queued` is what is written. */
const STATUS = new Correspondence<string, NeutralStatus>(
  [
    ["queued", "queued"],
    ["in_progress", "running"],
    ["waiting", "waiting"],
    ["completed", "completed"],
  ],
  [
    ["requested", "queued"],
    ["pending", "queued"],
  ],
);

const CONCLUSION = new Correspondence<string, Conclusion>([
  ["success", "success"],
  ["failure", "failure"],
  ["cancelled", "cancelled"],
  ["skipped", "skipped"],
  ["timed_out", "timedOut"],
  ["action_required", "actionRequired"],
  ["neutral", "neutral"],
  ["stale", "stale"],
]);

const EVENT = new Correspondence<string, string>([
  ["push", "push"],
  ["pull_request", "pullRequest"],
  ["schedule", "schedule"],
  ["workflow_dispatch", "manual"],
]);

/** The documented ceiling for `per_page` on the endpoints used here. */
export const GITHUB_MAX_PAGE_SIZE = 100;

export function conclusionFromWire(wire: string): Conclusion {
  const conclusion = CONCLUSION.decode(wire);
  if (conclusion === undefined) {
    throw new Error(`GitHub reported the conclusion "${wire}", which has no neutral meaning`);
  }

  return conclusion;
}

export function eventFromWire(wire: string): string {
  return EVENT.decode(wire) ?? wire;
}

export function eventToWire(neutral: string): string {
  try {
    return EVENT.encode(neutral);
  } catch {
    return neutral;
  }
}

export function statusFromWire(wire: string): NeutralStatus {
  const status = STATUS.decode(wire);
  if (status === undefined) {
    throw new Error(`GitHub reported the status "${wire}", which has no neutral meaning`);
  }

  return status;
}

const wireRunSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  status: z.string(),
  conclusion: z.string().nullable(),
  head_branch: z.string().nullable(),
  head_sha: z.string(),
  event: z.string(),
  html_url: z.string(),
  created_at: z.string(),
});
export type WireRun = z.infer<typeof wireRunSchema>;

/**
 * Decodes GitHub's snake_case run object into the contract's `Run` and encodes it back. A codec rather than a hand-written mapper because the two directions are one definition, so the test server that seeds responses from contract values cannot drift from what the adapter reads.
 */
export const runCodec = z.codec(wireRunSchema, runSchema, {
  decode: (wire): Run => {
    const common = {
      id: String(wire.id),
      name: wire.name,
      ref: wire.head_branch ?? "",
      sha: wire.head_sha,
      event: eventFromWire(wire.event),
      url: wire.html_url,
      createdAt: wire.created_at,
    };
    const status = statusFromWire(wire.status);
    if (status !== "completed") return { ...common, status };
    if (wire.conclusion === null) {
      throw new Error(`GitHub run ${String(wire.id)} is completed but reports no conclusion`);
    }

    return { ...common, status, conclusion: conclusionFromWire(wire.conclusion) };
  },
  encode: (run): WireRun => ({
    id: Number(run.id),
    name: run.name,
    status: STATUS.encode(run.status),
    conclusion: run.status === "completed" ? CONCLUSION.encode(run.conclusion) : null,
    head_branch: run.ref,
    head_sha: run.sha,
    event: eventToWire(run.event),
    html_url: run.url,
    created_at: run.createdAt,
  }),
});

const wireCheckSchema = z.object({
  name: z.string(),
  status: z.string(),
  conclusion: z.string().nullable(),
  html_url: z.string().nullable(),
});
export type WireCheck = z.infer<typeof wireCheckSchema>;

export const checkCodec = z.codec(
  wireCheckSchema,
  z.object({
    name: z.string(),
    status: z.enum(["queued", "running", "waiting", "completed"]),
    conclusion: conclusionSchema.optional(),
    url: z.string().optional(),
  }),
  {
    decode: (wire) => {
      const status = statusFromWire(wire.status);
      const url = wire.html_url ?? undefined;
      if (status !== "completed") return { name: wire.name, status, url };
      if (wire.conclusion === null) {
        throw new Error(`GitHub check ${wire.name} is completed but reports no conclusion`);
      }

      return {
        name: wire.name,
        status,
        conclusion: conclusionFromWire(wire.conclusion),
        url,
      };
    },
    encode: (check): WireCheck => ({
      name: check.name,
      status: STATUS.encode(check.status),
      conclusion: check.conclusion === undefined ? null : CONCLUSION.encode(check.conclusion),
      html_url: check.url ?? null,
    }),
  },
);

export const runListSchema = z.object({ workflow_runs: z.array(wireRunSchema) });
export const checkListSchema = z.object({ check_runs: z.array(wireCheckSchema) });
export const jobListSchema = z.object({
  jobs: z.array(z.object({ id: z.number().int(), name: z.string() })),
});
export const ruleListSchema = z.array(
  z.object({
    type: z.string(),
    parameters: z
      .object({
        required_status_checks: z.array(z.object({ context: z.string() })).optional(),
      })
      .optional(),
  }),
);
