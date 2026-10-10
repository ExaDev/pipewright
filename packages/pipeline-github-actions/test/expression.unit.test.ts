import { describe, expect, it } from "vitest";

import { ExpressionError, parseIf } from "../src/expression.ts";

const JOB = { leadingAlways: true, allowMatrix: false } as const;
const STEP = { leadingAlways: false, allowMatrix: true } as const;

describe("parseIf", () => {
  it("reads && over || with the usual precedence", () => {
    const { condition } = parseIf(
      "github.ref_name == 'a' || github.ref_name == 'b' && github.sha == 'c'",
      JOB,
    );

    expect(condition).toMatchObject({
      kind: "anyOf",
      operands: [{ kind: "textCompare" }, { kind: "allOf", operands: [{}, {}] }],
    });
  });

  it("reads a doubled quote as a quote and unwraps a ${{ }} wrapper", () => {
    const { condition } = parseIf("${{ github.ref_name == 'it''s' }}", JOB);

    expect(condition).toMatchObject({ right: { kind: "textLiteral", value: "it's" } });
  });

  it("reads a leading always() as a policy and not as a condition", () => {
    expect(parseIf("always()", JOB)).toEqual({ always: true, condition: undefined });
    expect(parseIf("always() && github.ref_name == 'a'", JOB).always).toBe(true);
  });

  it("does not read always() as a policy in a step condition", () => {
    expect(() => parseIf("always()", STEP)).toThrow(ExpressionError);
  });

  it("allows a matrix reference only where a matrix is modelled", () => {
    expect(() => parseIf("matrix.node == '22'", JOB)).toThrow(ExpressionError);
    expect(parseIf("matrix.node == '22'", STEP).condition).toMatchObject({ kind: "textCompare" });
  });

  it("translates an event name to the model's event kind", () => {
    const { condition } = parseIf("github.event_name == 'workflow_dispatch'", JOB);

    expect(condition).toMatchObject({ right: { kind: "textLiteral", value: "manual" } });
  });

  it.each([
    ["a status function", "failure()"],
    ["a function with arguments", "contains(github.ref_name, 'a')"],
    ["a number", "github.run_id == 1"],
    ["an ordering comparison", "github.run_id > 1"],
    ["a context value outside the vocabulary", "github.actor == 'a'"],
    ["an unknown event", "github.event_name == 'release'"],
    ["trailing text", "github.sha == 'a' github.sha"],
    ["an unterminated string", "github.sha == 'a"],
  ])("rejects %s", (_name, text) => {
    expect(() => parseIf(text, STEP)).toThrow(ExpressionError);
  });
});
