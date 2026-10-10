import { z } from "zod";

/**
 * The provider-neutral context vocabulary. A predicate `reference` node and a `{{ token }}` in a template string may name only these keys (plus `matrix.<name>` inside a job's predicates); each adapter maps them onto its provider's own context, and rejects any it cannot supply.
 */
export const CONTEXT_KEYS = [
  "event",
  "refName",
  "baseRefName",
  "sha",
  "repository",
  "workflow",
  "runId",
] as const;

export const contextKeySchema = z.enum(CONTEXT_KEYS);
export type ContextKey = z.infer<typeof contextKeySchema>;

/**
 * The values `event` may take, which are also the discriminants of the trigger kinds.
 */
export const EVENT_KINDS = ["push", "pullRequest", "schedule", "manual"] as const;
export const eventKindSchema = z.enum(EVENT_KINDS);
export type EventKind = z.infer<typeof eventKindSchema>;

const TOKEN_PATTERN = /\{\{\s*([A-Za-z][A-Za-z0-9_.]*)\s*\}\}/g;
const MATRIX_TOKEN_PREFIX = "matrix.";

/**
 * A parsed `{{ token }}`: a neutral context value or one axis of the enclosing job's matrix.
 */
export type TemplateToken =
  | { readonly kind: "context"; readonly key: ContextKey }
  | { readonly kind: "matrix"; readonly name: string };

/**
 * Parses the text inside `{{ }}`, or returns `undefined` when it names neither a context key nor a `matrix.<axis>`.
 */
export function parseTemplateToken(text: string): TemplateToken | undefined {
  if (text.startsWith(MATRIX_TOKEN_PREFIX) && text.length > MATRIX_TOKEN_PREFIX.length) {
    return { kind: "matrix", name: text.slice(MATRIX_TOKEN_PREFIX.length) };
  }
  const context = contextKeySchema.safeParse(text);
  return context.success ? { kind: "context", key: context.data } : undefined;
}

/**
 * Returns every `{{ token }}` name in `text`, in order of appearance and without checking that it is in the vocabulary.
 */
export function findTemplateTokens(text: string): string[] {
  return [...text.matchAll(TOKEN_PATTERN)].flatMap((match) =>
    match[1] === undefined ? [] : [match[1]],
  );
}

/**
 * Replaces each `{{ token }}` in `text` with what the adapter's `resolve` returns for it. A token outside the vocabulary throws, because the schema already rejects those and reaching here with one is a defect in the caller.
 */
export function renderTemplate(
  text: string,
  resolve: (token: TemplateToken) => string,
): string {
  return text.replace(TOKEN_PATTERN, (_whole, text: string) => {
    const token = parseTemplateToken(text);
    if (token === undefined) throw new Error(`unknown template token "${text}"`);
    return resolve(token);
  });
}
