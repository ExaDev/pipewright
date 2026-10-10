import type { z } from "zod";

import { type jobSchema, pipelineSchema, type stepSchema, type Pipeline } from "./schema.ts";

/**
 * The authoring shape of a pipeline: what a TypeScript module may write, before validation fills nothing in and rejects what the model does not allow.
 */
export type PipelineInput = z.input<typeof pipelineSchema>;
export type JobInput = z.input<typeof jobSchema>;
export type StepInput = z.input<typeof stepSchema>;

/**
 * Validates a pipeline written in TypeScript and returns it as the model every adapter compiles. Composition is ordinary TypeScript (functions, spreads, shared constants), so there is no `extends` or parameter mechanism on this path; a violation throws a `ZodError` whose paths are JSON pointers into the resolved pipeline.
 */
export function definePipeline(input: PipelineInput): Pipeline {
  return pipelineSchema.parse(input);
}
