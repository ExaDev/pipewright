import { conclusionSchema, runSchema, type Conclusion, type Run } from "@ci-adapters/platform-contract";
import { z } from "zod";

const STATUS_TO_WIRE = {
  queued: "queued",
  running: "in_progress",
  waiting: "waiting",
  completed: "completed",
} as const;

/** GitHub reports a run that has not started as any of these. */
const QUEUED_WIRE: ReadonlySet<string> = new Set(["queued", "requested", "pending"]);

const CONCLUSION_FROM_WIRE: Readonly<Record<string, Conclusion>> = {
  success: "success",
  failure: "failure",
  cancelled: "cancelled",
  skipped: "skipped",
  timed_out: "timedOut",
  action_required: "actionRequired",
  neutral: "neutral",
};

const CONCLUSION_TO_WIRE: Readonly<Record<Conclusion, string>> = {
  success: "success",
  failure: "failure",
  cancelled: "cancelled",
  skipped: "skipped",
  timedOut: "timed_out",
  actionRequired: "action_required",
  neutral: "neutral",
};

const EVENT_FROM_WIRE: Readonly<Record<string, string>> = {
  push: "push",
  pull_request: "pullRequest",
  schedule: "schedule",
  workflow_dispatch: "manual",
};

const EVENT_TO_WIRE: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(EVENT_FROM_WIRE).map(([wire, neutral]) => [neutral, wire]),
);

/** The documented ceiling for `per_page` on the endpoints used here. */
export const GITHUB_MAX_PAGE_SIZE = 100;

export function conclusionFromWire(wire: string): Conclusion {
  const conclusion = CONCLUSION_FROM_WIRE[wire];
  if (conclusion === undefined) {
    throw new Error(`GitHub reported the conclusion "${wire}", which has no neutral meaning`);
  }
  return conclusion;
}

export function eventFromWire(wire: string): string {
  return EVENT_FROM_WIRE[wire] ?? wire;
}

export function eventToWire(neutral: string): string {
  return EVENT_TO_WIRE[neutral] ?? neutral;
}

export function statusFromWire(wire: string): "queued" | "running" | "waiting" | "completed" {
  if (QUEUED_WIRE.has(wire)) return "queued";
  if (wire === "in_progress") return "running";
  if (wire === "waiting") return "waiting";
  if (wire === "completed") return "completed";
  throw new Error(`GitHub reported the status "${wire}", which has no neutral meaning`);
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
      throw new Error(`GitHub run ${wire.id} is completed but reports no conclusion`);
    }
    return { ...common, status, conclusion: conclusionFromWire(wire.conclusion) };
  },
  encode: (run): WireRun => ({
    id: Number(run.id),
    name: run.name,
    status: STATUS_TO_WIRE[run.status],
    conclusion: run.status === "completed" ? CONCLUSION_TO_WIRE[run.conclusion] : null,
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
      status: STATUS_TO_WIRE[check.status],
      conclusion: check.conclusion === undefined ? null : CONCLUSION_TO_WIRE[check.conclusion],
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
