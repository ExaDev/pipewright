import type { ExpressionNode, PredicateNode } from "trilean";

import { contextKeySchema, type ContextKey } from "./context.ts";
import { UnsupportedFeatureError, assertNever } from "./errors.ts";

const MATRIX_PREFIX = "matrix.";

/**
 * An operand a provider compiler can render: a neutral context value, one axis of the job's matrix, or a text literal.
 */
export type Operand =
  | { readonly kind: "context"; readonly key: ContextKey }
  | { readonly kind: "matrix"; readonly name: string }
  | { readonly kind: "text"; readonly value: string };

/**
 * One handler per construct a provider can express. A construct without a handler is rejected with `UnsupportedFeatureError`, so the set of handlers an adapter supplies is its support matrix for conditions and is the whole of its guard.
 *
 * The provider's expression languages are two-valued and coerce a missing value differently from trilean's three-valued evaluation, so each handler must render only constructs whose result cannot differ; anything else belongs outside the handler set.
 */
export interface PredicateHandlers<T> {
  readonly not?: (operand: T) => T;
  readonly and?: (left: T, right: T) => T;
  readonly or?: (left: T, right: T) => T;
  readonly allOf?: (operands: readonly T[]) => T;
  readonly anyOf?: (operands: readonly T[]) => T;
  /** Text equality in the neutral model is case-insensitive, because GitHub's `==` cannot be made case-sensitive; an adapter whose provider compares case-sensitively must render a case-insensitive comparison. */
  readonly equals?: (left: Operand, right: Operand, negated: boolean) => T;
  readonly memberOf?: (operand: Operand, candidates: readonly Operand[], negated: boolean) => T;
}

interface Where {
  readonly provider: string;
  readonly pointer: string;
}

function unsupported(where: Where, feature: string): never {
  throw new UnsupportedFeatureError(where.provider, where.pointer, feature);
}

function operandOf(expression: ExpressionNode, where: Where): Operand {
  if (expression.kind === "textLiteral") {
    return { kind: "text", value: expression.value };
  }
  if (expression.kind === "reference" && typeof expression.key === "string") {
    if (expression.key.startsWith(MATRIX_PREFIX)) {
      return { kind: "matrix", name: expression.key.slice(MATRIX_PREFIX.length) };
    }
    const context = contextKeySchema.safeParse(expression.key);
    if (context.success) return { kind: "context", key: context.data };
  }

  return unsupported(where, `the ${expression.kind} expression as an operand`);
}

function present<H>(handler: H | undefined, where: Where, feature: string): H {
  return handler ?? unsupported(where, feature);
}

/**
 * Compiles a trilean predicate tree through `handlers`, building the provider's own condition value bottom-up. `where.pointer` locates the tree in the resolved pipeline so a rejection names the exact node.
 */
export function compilePredicate<T>(
  node: PredicateNode,
  handlers: PredicateHandlers<T>,
  where: Where,
): T {
  const child = (next: PredicateNode, segment: string): T =>
    compilePredicate(next, handlers, {
      provider: where.provider,
      pointer: `${where.pointer}/${segment}`,
    });
  const at = (segment: string): Where => ({
    provider: where.provider,
    pointer: `${where.pointer}/${segment}`,
  });

  switch (node.kind) {
    case "not":
      return present(handlers.not, where, "negation")(child(node.operand, "operand"));
    case "and":
      return present(
        handlers.and,
        where,
        "conjunction",
      )(child(node.left, "left"), child(node.right, "right"));
    case "or":
      return present(
        handlers.or,
        where,
        "disjunction",
      )(child(node.left, "left"), child(node.right, "right"));
    case "allOf":
      return present(
        handlers.allOf,
        where,
        "allOf",
      )(node.operands.map((operand, index) => child(operand, `operands/${String(index)}`)));
    case "anyOf":
      return present(
        handlers.anyOf,
        where,
        "anyOf",
      )(node.operands.map((operand, index) => child(operand, `operands/${String(index)}`)));
    case "textCompare": {
      if (node.op !== "equals" && node.op !== "notEquals") {
        return unsupported(where, `the ${node.op} text comparison`);
      }

      return present(handlers.equals, where, "equality")(
        operandOf(node.left, at("left")),
        operandOf(node.right, at("right")),
        node.op === "notEquals",
      );
    }
    case "compare": {
      if (node.op !== "eq" && node.op !== "neq") {
        return unsupported(where, `the ${node.op} comparison`);
      }

      return present(handlers.equals, where, "equality")(
        operandOf(node.left, at("left")),
        operandOf(node.right, at("right")),
        node.op === "neq",
      );
    }
    case "memberOf":
      return present(handlers.memberOf, where, "membership")(
        operandOf(node.operand, at("operand")),
        node.candidates.map((candidate, index) =>
          operandOf(candidate, at(`candidates/${String(index)}`)),
        ),
        node.op === "notIn",
      );
    case "exists":
    case "some":
    case "every":
    case "treeReference":
      return unsupported(where, `the ${node.kind} predicate`);
  }

  return assertNever(node);
}
