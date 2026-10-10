import { describe, expect, it } from "vitest";

import { context, predicateOf, when, type Condition } from "../src/index.ts";

describe("predicateOf", () => {
  it("builds what the when builders build for equality and negation", () => {
    const parsed: Condition = {
      kind: "equals",
      left: { kind: "context", key: "refName" },
      right: { kind: "text", value: "main" },
      negated: false,
    };

    expect(predicateOf(parsed)).toEqual(when.equals(context.refName, "main"));
    expect(predicateOf({ kind: "not", operand: parsed })).toEqual(
      when.not(when.equals(context.refName, "main")),
    );
  });

  it("maps a matrix operand to a matrix reference and inequality to notEquals", () => {
    expect(
      predicateOf({
        kind: "equals",
        left: { kind: "matrix", name: "node" },
        right: { kind: "text", value: "22" },
        negated: true,
      }),
    ).toEqual({
      kind: "textCompare",
      op: "notEquals",
      left: { kind: "reference", key: "matrix.node" },
      right: { kind: "textLiteral", value: "22" },
    });
  });

  it("keeps the constants as empty conjunction and disjunction", () => {
    expect(predicateOf({ kind: "allOf", operands: [] })).toEqual({ kind: "allOf", operands: [] });
    expect(predicateOf({ kind: "anyOf", operands: [] })).toEqual({ kind: "anyOf", operands: [] });
  });
});
