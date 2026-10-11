import { describe, expect, it } from "vitest";

import {
  EvaluationError,
  evaluateCondition,
  evaluateExpression,
  evaluateTemplate,
  evaluationContextSchema,
  type EvaluationContext,
} from "../src/evaluation.ts";

/** Fixture numbers the assertions read, named so the values carry their meaning outside the expression strings that write them. */
const PR_NUMBER = 42;
const NODE_MAJOR = 22;
const HALF = 0.5;
const THOUSAND = 1000;
const FIFTEEN_THOUSANDTHS = 0.015;

/** A context with a value in every root, including a failure in `needs` so the status functions have something to read. */
const CONTEXT: EvaluationContext = evaluationContextSchema.parse({
  github: {
    event_name: "pull_request",
    ref_name: "42/merge",
    base_ref: "main",
    sha: "abc123def456",
    repository: "exadev/pipewright",
    workflow: "CI",
    run_id: "1536140711",
    event: {
      pull_request: {
        number: PR_NUMBER,
        draft: false,
        labels: [{ name: "bug" }, { name: "CI" }],
      },
    },
  },
  env: { NODE_VERSION: String(NODE_MAJOR), EMPTY: "" },
  job: { status: "success" },
  steps: {
    build: { conclusion: "success", outputs: { version: "1.2.3" } },
    check: { conclusion: "skipped", outputs: {} },
  },
  needs: {
    lint: { result: "success", outputs: {} },
    test: { result: "failure", outputs: { failures: "3" } },
  },
  matrix: { node: "22", os: "ubuntu-latest" },
  secrets: { TOKEN: "s3cret" },
  inputs: { deploy: true, count: 3 },
});

/** The same context with every need succeeding and no failed or cancelled step, where `success()` reads true. */
const CLEAN: EvaluationContext = {
  ...CONTEXT,
  needs: { lint: { result: "success", outputs: {} } },
};

function errorOf(expression: string, context: EvaluationContext = CONTEXT): EvaluationError {
  try {
    evaluateExpression(expression, context);
  } catch (error) {
    if (!(error instanceof EvaluationError)) throw error;

    return error;
  }

  throw new Error(`expected ${JSON.stringify(expression)} to fail`);
}

describe("evaluateExpression", () => {
  it("reads each kind of literal", () => {
    expect(evaluateExpression("'hello'", CONTEXT)).toBe("hello");
    expect(evaluateExpression("''", CONTEXT)).toBe("");
    expect(evaluateExpression("'it''s'", CONTEXT)).toBe("it's");
    expect(evaluateExpression("true", CONTEXT)).toBe(true);
    expect(evaluateExpression("false", CONTEXT)).toBe(false);
    expect(evaluateExpression("null", CONTEXT)).toBe(null);
    expect(evaluateExpression("1", CONTEXT)).toBe(1);
    expect(evaluateExpression("-1", CONTEXT)).toBe(-1);
    expect(evaluateExpression("0.5", CONTEXT)).toBe(HALF);
    expect(evaluateExpression("1e3", CONTEXT)).toBe(THOUSAND);
    expect(evaluateExpression("1.5e-2", CONTEXT)).toBe(FIFTEEN_THOUSANDTHS);
  });

  it("reads properties by name, bracket and index", () => {
    expect(evaluateExpression("github.sha", CONTEXT)).toBe("abc123def456");
    expect(evaluateExpression("github['event_name']", CONTEXT)).toBe("pull_request");
    expect(evaluateExpression("github.event.pull_request.number", CONTEXT)).toBe(PR_NUMBER);
    expect(evaluateExpression("github.event.pull_request.labels[0].name", CONTEXT)).toBe("bug");
    expect(evaluateExpression("needs.test.outputs.failures", CONTEXT)).toBe("3");
    expect(evaluateExpression("steps['build'].outputs['version']", CONTEXT)).toBe("1.2.3");
  });

  it("matches a property name without regard to case", () => {
    expect(evaluateExpression("github.EVENT_NAME", CONTEXT)).toBe("pull_request");
    expect(evaluateExpression("matrix.NODE", CONTEXT)).toBe("22");
  });

  it("reads a property, an index or a context that is absent as null", () => {
    expect(evaluateExpression("github.event.release", CONTEXT)).toBe(null);
    expect(evaluateExpression("github.actor", CONTEXT)).toBe(null);
    expect(evaluateExpression("github.event.pull_request.labels[5]", CONTEXT)).toBe(null);
    expect(evaluateExpression("env.MISSING", CONTEXT)).toBe(null);
    expect(evaluateExpression("github.event.pull_request.labels.name", CONTEXT)).toBe(null);
  });

  it("selects a filter's values and carries the rest of the path over them", () => {
    expect(evaluateExpression("needs.*.result", CONTEXT)).toEqual(["success", "failure"]);
    expect(evaluateExpression("steps.*.conclusion", CONTEXT)).toEqual(["success", "skipped"]);
    expect(evaluateExpression("github.event.pull_request.labels.*.name", CONTEXT)).toEqual([
      "bug",
      "CI",
    ]);
    expect(evaluateExpression("needs.*", CONTEXT)).toEqual([
      { result: "success", outputs: {} },
      { result: "failure", outputs: { failures: "3" } },
    ]);
  });

  it("reads ! and the comparisons", () => {
    expect(evaluateExpression("!github.event.pull_request.draft", CONTEXT)).toBe(true);
    expect(evaluateExpression("!''", CONTEXT)).toBe(true);
    expect(evaluateExpression("!'a'", CONTEXT)).toBe(false);
    expect(evaluateExpression("github.event.pull_request.number > 40", CONTEXT)).toBe(true);
    expect(evaluateExpression("github.event.pull_request.number <= 42", CONTEXT)).toBe(true);
    expect(evaluateExpression("'10' >= 9", CONTEXT)).toBe(true);
    expect(evaluateExpression("'abc' < 'abd'", CONTEXT)).toBe(false);
    expect(evaluateExpression("null < 1", CONTEXT)).toBe(true);
  });

  it("compares for equality loosely, ignoring the case of strings", () => {
    expect(evaluateExpression("'Abc' == 'abc'", CONTEXT)).toBe(true);
    expect(evaluateExpression("'Abc' != 'abc'", CONTEXT)).toBe(false);
    expect(evaluateExpression("github.event.pull_request.number == 42", CONTEXT)).toBe(true);
    expect(evaluateExpression("env.NODE_VERSION == 22", CONTEXT)).toBe(true);
    expect(evaluateExpression("'' == null", CONTEXT)).toBe(true);
    expect(evaluateExpression("null == 0", CONTEXT)).toBe(true);
    expect(evaluateExpression("true == 1", CONTEXT)).toBe(true);
    expect(evaluateExpression("'true' == true", CONTEXT)).toBe(false);
    expect(evaluateExpression("'hello' == 1", CONTEXT)).toBe(false);
  });

  it("considers an array or object equal only to itself", () => {
    expect(evaluateExpression("fromJSON('[1]') == fromJSON('[1]')", CONTEXT)).toBe(false);
    expect(evaluateExpression("matrix == matrix", CONTEXT)).toBe(true);
  });

  it("returns the operand's own value from && and ||, binding tighter than ==", () => {
    expect(evaluateExpression("env.MISSING || 'default'", CONTEXT)).toBe("default");
    expect(evaluateExpression("matrix.node && matrix.os", CONTEXT)).toBe("ubuntu-latest");
    expect(evaluateExpression("null || !github.event.pull_request.draft", CONTEXT)).toBe(true);
    expect(evaluateExpression("'a' || 'b' == 'b'", CONTEXT)).toBe("a");
    expect(evaluateExpression("'a' == 'a' && 'b'", CONTEXT)).toBe("b");
  });

  it("casts a value to a boolean by GitHub's falsy set", () => {
    expect(evaluateCondition("0", CONTEXT)).toBe(false);
    expect(evaluateCondition("''", CONTEXT)).toBe(false);
    expect(evaluateCondition("null", CONTEXT)).toBe(false);
    expect(evaluateCondition("false", CONTEXT)).toBe(false);
    expect(evaluateCondition("'0'", CONTEXT)).toBe(true);
    expect(evaluateCondition("'false'", CONTEXT)).toBe(true);
    expect(evaluateCondition("inputs.deploy", CONTEXT)).toBe(true);
  });

  it("expands a format pattern", () => {
    expect(evaluateExpression("format('{0}={1}', 'a', 'b')", CONTEXT)).toBe("a=b");
    expect(evaluateExpression("format('{{{0}}}', 'x')", CONTEXT)).toBe("{x}");
    expect(evaluateExpression("format('{0}', matrix.node)", CONTEXT)).toBe("22");
    expect(evaluateExpression("format('{0}', 3.141592653589793)", CONTEXT)).toBe(
      "3.14159265358979",
    );
    expect(evaluateExpression("format('{0}', 10743.52)", CONTEXT)).toBe("10743.52");
    expect(evaluateExpression("format('{0}', -0)", CONTEXT)).toBe("0");
  });

  it("searches with contains, startsWith and endsWith, ignoring case", () => {
    expect(evaluateExpression("contains('Hello world', 'WORLD')", CONTEXT)).toBe(true);
    expect(evaluateExpression("contains('Hello', 'x')", CONTEXT)).toBe(false);
    expect(evaluateExpression("contains(needs.*.result, 'FAILURE')", CONTEXT)).toBe(true);
    expect(evaluateExpression("startsWith('Hello', 'he')", CONTEXT)).toBe(true);
    expect(evaluateExpression("endsWith('Hello', 'LO')", CONTEXT)).toBe(true);
    expect(evaluateExpression("startsWith('Hello', 'ello')", CONTEXT)).toBe(false);
  });

  it("joins a list, with a separator when one is given", () => {
    expect(evaluateExpression("join(needs.*.result)", CONTEXT)).toBe("success,failure");
    expect(evaluateExpression("join(needs.*.result, ' + ')", CONTEXT)).toBe("success + failure");
    expect(evaluateExpression("join('alone')", CONTEXT)).toBe("alone");
  });

  it("renders and parses JSON", () => {
    expect(evaluateExpression("toJSON(fromJSON('{\"a\": 1}'))", CONTEXT)).toBe('{\n  "a": 1\n}');
    expect(evaluateExpression("fromJSON('[1, true, null]')[1]", CONTEXT)).toBe(true);
    expect(evaluateExpression("fromJSON(env.NODE_VERSION)", CONTEXT)).toBe(NODE_MAJOR);
    expect(evaluateExpression('fromJSON(\'{"b": {"c": 2}}\').b.c', CONTEXT)).toBe(2);
  });

  it("reads the status functions from the needs and steps view", () => {
    expect(evaluateExpression("success()", CONTEXT)).toBe(false);
    expect(evaluateExpression("failure()", CONTEXT)).toBe(true);
    expect(evaluateExpression("cancelled()", CONTEXT)).toBe(false);
    expect(evaluateExpression("always()", CONTEXT)).toBe(true);
    expect(evaluateExpression("success()", CLEAN)).toBe(true);
    expect(evaluateExpression("failure()", CLEAN)).toBe(false);
  });

  it("rejects each kind of unsupported or malformed input", () => {
    expect(errorOf("runner.os").construct).toContain("the context runner");
    expect(errorOf("secrets.MISSING").construct).toContain('the secret "MISSING"');
    expect(errorOf("secrets['MISSING']").construct).toContain('the secret "MISSING"');
    expect(errorOf("hashFiles('**/*.ts')").construct).toContain("hashFiles");
    expect(errorOf("matrix.node == nodeVersion").construct).toContain("the context nodeVersion");
    expect(errorOf("nope('x')").construct).toContain("the function nope()");
    expect(errorOf("github.sha github.sha").construct).toContain("trailing text");
    expect(errorOf("").construct).toContain("an empty expression");
    expect(errorOf("github.sha ==").construct).toContain("an incomplete expression");
    expect(errorOf("1 + 1").construct).toContain('the character "+"');
    expect(errorOf("fromJSON('not json')").construct).toContain("not JSON");
    expect(errorOf("contains('a')").construct).toContain("the function contains() with 1 argument");
    expect(errorOf("format('{0}')").construct).toContain("at least one replacement value");
    expect(errorOf("format('{1}', 'a')").construct).toContain("exceeds its replacement values");
    expect(errorOf("format('{x}', 'a')").construct).toContain("which is not a number");
    expect(errorOf("github.sha.").construct).toContain("a property name or * after .");
  });

  it("names the expression an error came from", () => {
    expect(errorOf("runner.os").expression).toBe("runner.os");
  });
});

describe("evaluateTemplate", () => {
  it("replaces each expression with the string form of its result", () => {
    expect(evaluateTemplate("v${{ matrix.node }}", CONTEXT)).toBe("v22");
    expect(evaluateTemplate("a ${{ github.sha }} b ${{ matrix.os }}", CONTEXT)).toBe(
      "a abc123def456 b ubuntu-latest",
    );
    expect(evaluateTemplate("${{ github.event.pull_request.number }}", CONTEXT)).toBe("42");
    expect(evaluateTemplate("${{ inputs.deploy }}", CONTEXT)).toBe("true");
  });

  it("leaves text without an expression, or with an unclosed one, as written", () => {
    expect(evaluateTemplate("plain text", CONTEXT)).toBe("plain text");
    expect(evaluateTemplate("a ${{ github.sha", CONTEXT)).toBe("a ${{ github.sha");
  });

  it("writes null as the empty string and keeps a brace inside quotes", () => {
    expect(evaluateTemplate("[${{ github.event.release }}]", CONTEXT)).toBe("[]");
    expect(evaluateTemplate("echo ${{ format('{{{0}}}', 'x') }}", CONTEXT)).toBe("echo {x}");
    expect(evaluateTemplate("token=${{ secrets.TOKEN }}", CONTEXT)).toBe("token=s3cret");
  });

  it("rejects an interpolation whose value has no string form", () => {
    expect(() => evaluateTemplate("${{ inputs }}", CONTEXT)).toThrow(EvaluationError);
    expect(() => evaluateTemplate("${{ needs.*.result }}", CONTEXT)).toThrow(EvaluationError);
  });
});

describe("evaluateCondition", () => {
  it("reads a bare condition and a whole-value ${{ }} wrapper", () => {
    expect(evaluateCondition("github.event_name == 'pull_request'", CONTEXT)).toBe(true);
    expect(evaluateCondition("${{ github.event_name == 'push' }}", CONTEXT)).toBe(false);
  });

  it("reads the conditions a gate writes", () => {
    expect(
      evaluateCondition(
        "contains(needs.*.result, 'failure') || contains(needs.*.result, 'cancelled')",
        CONTEXT,
      ),
    ).toBe(true);
    expect(evaluateCondition("failure() && needs.test.result == 'failure'", CONTEXT)).toBe(true);
    expect(evaluateCondition("!cancelled()", CONTEXT)).toBe(true);
    expect(evaluateCondition("always()", CONTEXT)).toBe(true);
  });
});

describe("evaluationContextSchema", () => {
  it("accepts a github field the neutral seven do not name", () => {
    const parsed = evaluationContextSchema.parse({
      ...CONTEXT,
      github: { ...CONTEXT.github, actor: "mearman" },
    });

    expect(evaluateExpression("github.actor", parsed)).toBe("mearman");
  });

  it("rejects a context whose shape is not what a local run supplies", () => {
    expect(evaluationContextSchema.safeParse({ ...CONTEXT, secrets: { TOKEN: 1 } }).success).toBe(
      false,
    );
    expect(
      evaluationContextSchema.safeParse({
        ...CONTEXT,
        steps: { build: { conclusion: "crashed", outputs: {} } },
      }).success,
    ).toBe(false);
    expect(evaluationContextSchema.safeParse({ ...CONTEXT, job: undefined }).success).toBe(false);
    expect(evaluationContextSchema.safeParse({ ...CONTEXT, runner: { os: "macOS" } }).success).toBe(
      false,
    );
  });
});
