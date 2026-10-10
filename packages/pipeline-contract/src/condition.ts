import type { ExpressionNode, PredicateNode } from "trilean";

import { assertNever } from "./errors.ts";
import type { Operand } from "./predicate.ts";

/**
 * A condition as an importer reads it out of a native file: the same constructs `PredicateHandlers` renders, as data. A provider's expression parser builds this from its own syntax, and `predicateOf` turns it into the model's predicate tree, so the four importers share one definition of what each construct means and none builds trilean nodes itself.
 *
 * `allOf` and `anyOf` hold at least two operands, or none for the constants true and false.
 */
export type Condition =
  | { readonly kind: "not"; readonly operand: Condition }
  | { readonly kind: "allOf"; readonly operands: readonly Condition[] }
  | { readonly kind: "anyOf"; readonly operands: readonly Condition[] }
  | {
      readonly kind: "equals";
      readonly left: Operand;
      readonly right: Operand;
      readonly negated: boolean;
    };

function expressionOf(operand: Operand): ExpressionNode {
  switch (operand.kind) {
    case "context":
      return { kind: "reference", key: operand.key };
    case "matrix":
      return { kind: "reference", key: `matrix.${operand.name}` };
    case "text":
      return { kind: "textLiteral", value: operand.value };
  }

  return assertNever(operand);
}

/**
 * The model's predicate tree for a parsed condition. Text equality is the model's case-insensitive `equals`, which is what every compiler renders it as.
 */
export function predicateOf(condition: Condition): PredicateNode {
  switch (condition.kind) {
    case "not":
      return { kind: "not", operand: predicateOf(condition.operand) };
    case "allOf":
      return { kind: "allOf", operands: condition.operands.map(predicateOf) };
    case "anyOf":
      return { kind: "anyOf", operands: condition.operands.map(predicateOf) };
    case "equals":
      return {
        kind: "textCompare",
        op: condition.negated ? "notEquals" : "equals",
        left: expressionOf(condition.left),
        right: expressionOf(condition.right),
      };
  }

  return assertNever(condition);
}
