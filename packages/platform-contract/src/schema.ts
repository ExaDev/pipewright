import { z } from "zod";

/**
 * Run and check vocabulary shared by every provider. `waiting` covers a run held for approval or a protected environment; `completed` is the only status that carries a conclusion.
 */
export const conclusionSchema = z.enum([
  "success",
  "failure",
  "cancelled",
  "skipped",
  "timedOut",
  "actionRequired",
  "neutral",
]);
export type Conclusion = z.infer<typeof conclusionSchema>;

const common = {
  id: z.string().min(1),
  name: z.string().min(1),
  url: z.string().min(1),
};

const runCommon = {
  ...common,
  ref: z.string(),
  sha: z.string().min(1),
  event: z.string().min(1),
  createdAt: z.string().min(1),
};

/**
 * A run is a discriminated union on `status`, so an unfinished run cannot carry a conclusion and a finished one cannot lack it.
 */
export const runSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("queued"), ...runCommon }),
  z.strictObject({ status: z.literal("running"), ...runCommon }),
  z.strictObject({ status: z.literal("waiting"), ...runCommon }),
  z.strictObject({
    status: z.literal("completed"),
    conclusion: conclusionSchema,
    ...runCommon,
  }),
]);
export type Run = z.infer<typeof runSchema>;

const checkCommon = { name: z.string().min(1), url: z.string().optional() };

export const checkSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("queued"), ...checkCommon }),
  z.strictObject({ status: z.literal("running"), ...checkCommon }),
  z.strictObject({ status: z.literal("waiting"), ...checkCommon }),
  z.strictObject({
    status: z.literal("completed"),
    conclusion: conclusionSchema,
    ...checkCommon,
  }),
]);
export type Check = z.infer<typeof checkSchema>;

export interface RunQuery {
  readonly ref?: string;
  readonly sha?: string;
  readonly event?: string;
  /** Upper bound on runs returned, at most the provider's page maximum. */
  readonly limit?: number;
}

export interface DispatchRequest {
  /** The workflow or pipeline file name or identifier. */
  readonly workflow: string;
  readonly ref: string;
  readonly inputs?: Readonly<Record<string, string>>;
}
