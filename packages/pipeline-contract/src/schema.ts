import { JsonValueSchema, PredicateNodeSchema } from "trilean";
import { z } from "zod";

import { contextKeySchema, findTemplateTokens, parseTemplateToken } from "./context.ts";

const MATRIX_PREFIX = "matrix.";

/**
 * Optional prose carried by every node. JSON has no comments, so this is how an author explains a node; emitters write it into the generated file as a comment.
 */
const description = z.string().min(1).optional();

const templateString = z
  .string()
  .refine(
    (text) =>
      findTemplateTokens(text).every((token) => parseTemplateToken(token) !== undefined),
    {
      message:
        "contains a {{ token }} that is neither a neutral context key nor a matrix.<axis>",
    },
  );

const nonEmptyList = z.array(z.string().min(1)).min(1);

export const triggerSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("push"),
    branches: nonEmptyList.optional(),
    description,
  }),
  z.strictObject({
    kind: z.literal("pullRequest"),
    branches: nonEmptyList.optional(),
    description,
  }),
  z.strictObject({
    kind: z.literal("schedule"),
    cron: z.string().min(1),
    description,
  }),
  z.strictObject({ kind: z.literal("manual"), description }),
]);
export type Trigger = z.infer<typeof triggerSchema>;

export const PERMISSION_SCOPES = [
  "contents",
  "pullRequests",
  "issues",
  "checks",
  "packages",
  "identityToken",
] as const;
export const permissionLevelSchema = z.enum(["none", "read", "write"]);
export const permissionsSchema = z.partialRecord(
  z.enum(PERMISSION_SCOPES),
  permissionLevelSchema,
);
export type Permissions = z.infer<typeof permissionsSchema>;

const providerIdSchema = z.enum(["github-actions", "gitlab-ci"]);
export type ProviderId = z.infer<typeof providerIdSchema>;

const envSchema = z.record(z.string().min(1), templateString);

const stepCommon = {
  name: z.string().min(1).optional(),
  when: PredicateNodeSchema.optional(),
  description,
};

/**
 * The portable steps are `checkout` and `run`. Anything else is a `provider` step: a mapping handed to one named provider verbatim, which every other adapter rejects, so a pipeline's non-portable parts are always visible in the file.
 */
export const stepSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("checkout"),
    fetchDepth: z.union([z.literal("full"), z.number().int().positive()]).optional(),
    ...stepCommon,
  }),
  z.strictObject({
    kind: z.literal("run"),
    run: z.string().min(1),
    env: envSchema.optional(),
    workingDirectory: z.string().min(1).optional(),
    ...stepCommon,
  }),
  z.strictObject({
    kind: z.literal("provider"),
    provider: providerIdSchema,
    native: z.record(z.string(), JsonValueSchema),
    ...stepCommon,
  }),
]);
export type Step = z.infer<typeof stepSchema>;

const matrixSchema = z.record(
  z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/),
  z.array(z.union([z.string(), z.number(), z.boolean()])).min(1),
);

export const JOB_ID_PATTERN = /^[a-z][a-z0-9-]*$/;

export const jobSchema = z.strictObject({
  name: z.string().min(1),
  description,
  runsOn: nonEmptyList,
  needs: z.array(z.string().regex(JOB_ID_PATTERN)).optional(),
  /**
   * `success` (the default) runs the job only when every job it needs succeeded; `always` runs it whatever they concluded, which is how a fan-in gate job reports on failures.
   */
  needsPolicy: z.enum(["success", "always"]).optional(),
  when: PredicateNodeSchema.optional(),
  timeoutMinutes: z.number().int().positive().optional(),
  permissions: permissionsSchema.optional(),
  environment: z.string().min(1).optional(),
  env: envSchema.optional(),
  matrix: matrixSchema.optional(),
  steps: z.array(stepSchema).min(1),
  /** Mappings merged verbatim into the emitted job for one provider; every other adapter ignores the key it does not own. */
  native: z.partialRecord(providerIdSchema, z.record(z.string(), JsonValueSchema)).optional(),
});
export type Job = z.infer<typeof jobSchema>;

const pipelineShape = z.strictObject({
  $schema: z.string().min(1).optional(),
  name: z.string().min(1),
  description,
  triggers: z.array(triggerSchema).min(1),
  permissions: permissionsSchema.optional(),
  concurrency: z
    .strictObject({
      group: templateString,
      cancelInProgress: z.boolean(),
    })
    .optional(),
  env: envSchema.optional(),
  jobs: z.record(z.string().regex(JOB_ID_PATTERN), jobSchema),
});

/**
 * Every `reference` node in a predicate, as raw keys. Predicate trees are plain JSON, so this walks the value rather than the typed tree, which keeps it correct for every node kind trilean adds.
 */
function referenceKeys(value: unknown, found: unknown[] = []): unknown[] {
  if (Array.isArray(value)) {
    for (const item of value) referenceKeys(item, found);
  } else if (typeof value === "object" && value !== null) {
    if ("kind" in value && value.kind === "reference" && "key" in value) {
      found.push(value.key);
    }
    for (const child of Object.values(value)) referenceKeys(child, found);
  }
  return found;
}

function isKnownReference(key: unknown, matrixNames: ReadonlySet<string>): boolean {
  if (typeof key !== "string") return false;
  if (key.startsWith(MATRIX_PREFIX)) {
    return matrixNames.has(key.slice(MATRIX_PREFIX.length));
  }
  return contextKeySchema.safeParse(key).success;
}

function hasCycle(graph: ReadonlyMap<string, readonly string[]>): boolean {
  const state = new Map<string, "visiting" | "done">();
  const visit = (id: string): boolean => {
    const current = state.get(id);
    if (current === "visiting") return true;
    if (current === "done") return false;
    state.set(id, "visiting");
    const cyclic = (graph.get(id) ?? []).some(visit);
    state.set(id, "done");
    return cyclic;
  };
  return [...graph.keys()].some(visit);
}

/**
 * The pipeline model: the single definition from which the TypeScript type, the runtime validator and the published JSON Schema all derive. The cross-field rules (job references, cycles, predicate references) are part of the schema, so a value that parses is a pipeline every adapter can compile.
 */
export const pipelineSchema = pipelineShape.superRefine((pipeline, ctx) => {
  const ids = new Set(Object.keys(pipeline.jobs));
  const graph = new Map<string, readonly string[]>();

  for (const [id, job] of Object.entries(pipeline.jobs)) {
    graph.set(id, job.needs ?? []);
    for (const [index, needed] of (job.needs ?? []).entries()) {
      if (!ids.has(needed)) {
        ctx.addIssue({
          code: "custom",
          path: ["jobs", id, "needs", index],
          message: `needs unknown job "${needed}"`,
        });
      }
    }

    const matrixNames = new Set(Object.keys(job.matrix ?? {}));
    const templated: [(string | number)[], string][] = [];
    for (const [key, value] of Object.entries(job.env ?? {})) {
      templated.push([["jobs", id, "env", key], value]);
    }
    for (const [index, step] of job.steps.entries()) {
      if (step.kind !== "run") continue;
      for (const [key, value] of Object.entries(step.env ?? {})) {
        templated.push([["jobs", id, "steps", index, "env", key], value]);
      }
    }
    for (const [path, text] of templated) {
      for (const name of findTemplateTokens(text)) {
        const token = parseTemplateToken(name);
        if (token?.kind === "matrix" && !matrixNames.has(token.name)) {
          ctx.addIssue({
            code: "custom",
            path,
            message: `uses {{ ${name} }}, but this job's matrix has no axis "${token.name}"`,
          });
        }
      }
    }
    const predicates: [(string | number)[], unknown][] = [];
    if (job.when !== undefined) predicates.push([["jobs", id, "when"], job.when]);
    for (const [index, step] of job.steps.entries()) {
      if (step.when !== undefined) {
        predicates.push([["jobs", id, "steps", index, "when"], step.when]);
      }
    }
    for (const [path, predicate] of predicates) {
      for (const key of referenceKeys(predicate)) {
        if (!isKnownReference(key, matrixNames)) {
          ctx.addIssue({
            code: "custom",
            path,
            message: `references ${JSON.stringify(key)}, which is neither a context key nor a matrix axis of this job`,
          });
        }
      }
    }
  }

  const topLevel: [(string | number)[], string][] = [];
  for (const [key, value] of Object.entries(pipeline.env ?? {})) {
    topLevel.push([["env", key], value]);
  }
  if (pipeline.concurrency !== undefined) {
    topLevel.push([["concurrency", "group"], pipeline.concurrency.group]);
  }
  for (const [path, text] of topLevel) {
    for (const name of findTemplateTokens(text)) {
      if (parseTemplateToken(name)?.kind === "matrix") {
        ctx.addIssue({
          code: "custom",
          path,
          message: `uses {{ ${name} }}, but a matrix axis exists only inside a job`,
        });
      }
    }
  }

  if (hasCycle(graph)) {
    ctx.addIssue({ code: "custom", path: ["jobs"], message: "needs form a cycle" });
  }
});
export type Pipeline = z.infer<typeof pipelineSchema>;

/**
 * The `$schema` value authors put in a pipeline file so editors validate it without tooling.
 */
export const PIPELINE_JSON_SCHEMA_ID =
  "https://raw.githubusercontent.com/ExaDev/ci-adapters/main/schemas/pipeline.schema.json";
