import type { PredicateNode, ReferenceNode } from "trilean";

import { CONTEXT_KEYS, type ContextKey, type EventKind } from "./context.ts";
import type { JobInput } from "./define.ts";

/**
 * A typed reference to a value that exists only when the pipeline runs: a neutral context value or one axis of a job's matrix. A reference is obtained from `context` or from the axes a `matrixJob` callback receives, never written as text, so a misspelt name is a compile error. It serialises to the `{{ name }}` token the model stores.
 */
export class Ref {
  /** The key a condition's `reference` node uses: a context key, or `matrix.<axis>`. */
  readonly key: string;

  constructor(key: string) {
    this.key = key;
  }

  /** The token form stored in a pipeline's string values. */
  get token(): string {
    return `{{ ${this.key} }}`;
  }
}

type ContextRefs = Readonly<Record<ContextKey, Ref>>;

function hasEveryContextKey(value: Record<string, Ref>): value is ContextRefs {
  return CONTEXT_KEYS.every((key) => key in value);
}

function buildContext(): ContextRefs {
  const refs: Record<string, Ref> = Object.fromEntries(
    CONTEXT_KEYS.map((key) => [key, new Ref(key)]),
  );
  if (!hasEveryContextKey(refs)) throw new Error("a context key has no reference");

  return refs;
}

/**
 * The neutral context values, as typed references: `context.sha`, `context.refName`, and so on. Each adapter maps them onto its provider's own context.
 */
export const context: ContextRefs = buildContext();

type Matrix = Readonly<Record<string, readonly (string | number | boolean)[]>>;

/**
 * One reference per axis of the matrix a job declares, keyed by the axis names themselves.
 */
export type MatrixAxes<Declared extends Matrix> = Readonly<Record<keyof Declared & string, Ref>>;

function hasEveryAxis<Declared extends Matrix>(
  value: Record<string, Ref>,
  matrix: Declared,
): value is MatrixAxes<Declared> {
  return Object.keys(matrix).every((axis) => axis in value);
}

/**
 * Defines a job together with its matrix, so a reference to an axis exists only for an axis that is declared. `build` receives the axes and returns the rest of the job.
 *
 * The matrix is stated once, here, and the returned job carries it; there is no second place for an axis name to be misspelt.
 */
export function matrixJob<const Declared extends Matrix>(
  matrix: Declared,
  build: (axes: MatrixAxes<Declared>) => Omit<JobDefinition, "matrix">,
): JobDefinition {
  const refs: Record<string, Ref> = Object.fromEntries(
    Object.keys(matrix).map((axis) => [axis, new Ref(`matrix.${axis}`)]),
  );
  if (!hasEveryAxis(refs, matrix)) throw new Error("a matrix axis has no reference");

  const mutable = Object.fromEntries(
    Object.entries(matrix).map(([axis, values]) => [axis, [...values]]),
  );

  return { ...build(refs), matrix: mutable };
}

/**
 * Builds a string from literal text and references, used as a tagged template, for a value that is partly fixed and partly known only at run time.
 */
export function t(strings: TemplateStringsArray, ...parts: readonly Ref[]): string {
  return strings.reduce(
    (text, literal, index) => `${text}${literal}${parts[index]?.token ?? ""}`,
    "",
  );
}

function referenceNode(ref: Ref): ReferenceNode {
  return { kind: "reference", key: ref.key };
}

/**
 * Builders for the conditions the adapters can express, typed so that only references and event kinds the model defines can be named. Each returns a plain predicate tree, which is what the model stores.
 */
export const when = {
  /** The text value of `ref` equals `value`, ignoring case. */
  equals(ref: Ref, value: string): PredicateNode {
    return {
      kind: "textCompare",
      op: "equals",
      left: referenceNode(ref),
      right: { kind: "textLiteral", value },
    };
  },

  /** The value of `ref` is one of `values`. */
  oneOf(ref: Ref, values: readonly string[]): PredicateNode {
    return {
      kind: "memberOf",
      op: "in",
      operand: referenceNode(ref),
      candidates: values.map((value) => ({ kind: "textLiteral", value }) as const),
    };
  },

  /** The run was started by one of these events. */
  event(...kinds: readonly [EventKind, ...EventKind[]]): PredicateNode {
    return when.oneOf(context.event, kinds);
  },

  allOf(...operands: readonly PredicateNode[]): PredicateNode {
    return { kind: "allOf", operands: [...operands] };
  },

  anyOf(...operands: readonly PredicateNode[]): PredicateNode {
    return { kind: "anyOf", operands: [...operands] };
  },

  not(operand: PredicateNode): PredicateNode {
    return { kind: "not", operand };
  },
};

/**
 * A job that has been given its id. Another job names it in `needs` by passing the handle, so a dependency on a job that does not exist is an undefined variable, and a cycle cannot be written because a handle only exists after the job it names.
 */
export interface JobHandle {
  readonly id: string;
  readonly input: JobInput;
}

export type JobDefinition = Omit<JobInput, "needs"> & {
  readonly needs?: readonly JobHandle[];
};

/**
 * Defines the job `id`. Its `needs` are handles of jobs defined earlier.
 */
export function defineJob(id: string, definition: JobDefinition): JobHandle {
  const { needs, ...rest } = definition;

  return {
    id,
    input: { ...rest, ...(needs === undefined ? {} : { needs: needs.map((handle) => handle.id) }) },
  };
}

/**
 * Collects job handles into the `jobs` map of a pipeline, keyed by each handle's id. Two handles with one id is an error rather than one silently replacing the other.
 */
export function jobsOf(...handles: readonly JobHandle[]): Record<string, JobInput> {
  const jobs = new Map<string, JobInput>();
  for (const handle of handles) {
    if (jobs.has(handle.id)) throw new Error(`job ${handle.id} is defined twice`);
    jobs.set(handle.id, handle.input);
  }

  return Object.fromEntries(jobs);
}
