import { assertNever } from "@pipewright/pipeline-contract";
import { z } from "zod";

/**
 * A value an expression can produce or read from the context: the JSON-shaped data GitHub's own evaluation carries, with null for anything absent.
 */
export type ExpressionValue =
  | string
  | number
  | boolean
  | null
  | readonly ExpressionValue[]
  | { readonly [name: string]: ExpressionValue };

const expressionValueSchema: z.ZodType<ExpressionValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(expressionValueSchema),
    z.record(z.string(), expressionValueSchema),
  ]),
);

/**
 * A step conclusion or a needed job's result, as GitHub reports them.
 * @see https://docs.github.com/en/actions/reference/workflows-and-actions/contexts
 */
const outcomeSchema = z.enum(["success", "failure", "cancelled", "skipped"]);

const outputsSchema = z.record(z.string().min(1), z.string());

/**
 * The `github` context under GitHub's own property names, restricted to the fields the neutral model has concepts for. Anything else the host supplies, an event payload under `event` or an `actor`, is validated as a value and read the same way. `run_id` is a string, as the documented example contents of the context show.
 * @see https://docs.github.com/en/actions/reference/workflows-and-actions/contexts
 */
const githubSchema = z
  .looseObject({
    event_name: z.string(),
    ref_name: z.string(),
    base_ref: z.string(),
    sha: z.string(),
    repository: z.string(),
    workflow: z.string(),
    run_id: z.string(),
  })
  .catchall(expressionValueSchema);

/**
 * The context an expression is evaluated against: the eight contexts GitHub exposes that a local run can supply as data. Every root is required, so a host states an empty `matrix` or `inputs` rather than leaving the shape implied, and `secrets` is a record the host injects, never a value this package stores.
 */
export const evaluationContextSchema = z.strictObject({
  github: githubSchema,
  env: z.record(z.string().min(1), z.string()),
  job: z.strictObject({ status: z.enum(["success", "failure", "cancelled"]) }),
  steps: z.record(
    z.string().min(1),
    z.strictObject({ conclusion: outcomeSchema, outputs: outputsSchema }),
  ),
  needs: z.record(
    z.string().min(1),
    z.strictObject({ result: outcomeSchema, outputs: outputsSchema }),
  ),
  matrix: z.record(z.string().min(1), expressionValueSchema),
  secrets: z.record(z.string().min(1), z.string()),
  inputs: z.record(z.string().min(1), expressionValueSchema),
});

export type EvaluationContext = z.infer<typeof evaluationContextSchema>;

/**
 * Raised when an expression cannot be evaluated: a construct this evaluator does not implement, a context it does not read, or a secret the host did not supply. The value is never a silent empty string, because a step that ran on a guess behaves differently from the workflow its author wrote.
 */
export class EvaluationError extends Error {
  /** The expression text, as written where it was evaluated. */
  readonly expression: string;

  /** What could not be evaluated, phrased like the importer's own rejections. */
  readonly construct: string;

  constructor(expression: string, construct: string) {
    super(`cannot evaluate ${JSON.stringify(expression)}: ${construct}`);
    this.name = "EvaluationError";
    this.expression = expression;
    this.construct = construct;
  }
}

/** Reports a construct that cannot be evaluated, naming the expression it came from. */
type Fail = (construct: string) => never;

/**
 * Narrows to the array variant. The builtin `Array.isArray` guard crosses the recursive array type with `any[]`, which degrades element access to `any`, so evaluation narrows through this guard instead.
 */
function isArrayValue(value: ExpressionValue): value is readonly ExpressionValue[] {
  return Array.isArray(value);
}

type Token =
  | { readonly kind: "string"; readonly value: string }
  | { readonly kind: "number"; readonly value: number }
  | { readonly kind: "name"; readonly value: string }
  | { readonly kind: "punct"; readonly value: string };

const NAME_START = /[A-Za-z_]/;
/** An identifier keeps hyphens, and `.` and `*` are separate tokens because the grammar has no arithmetic that could share them. */
const NAME_PART = /[A-Za-z0-9_-]/;
const DIGIT = /[0-9]/;
const TWO_CHARACTER = new Set(["<=", ">=", "==", "!=", "&&", "||"]);
const ONE_CHARACTER = new Set(["(", ")", "[", "]", "!", ",", ".", "*", "<", ">"]);

/**
 * The tokeniser for evaluation. It is deliberately separate from the one in `expression.ts`: that one lexes a dotted path such as `github.event_name` as a single name, which is what the importer's round trip reads back, while this one must split `.` and `*` so they can be the dereference and filter operators.
 */
function tokenise(text: string, fail: Fail): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < text.length) {
    const char = text.charAt(index);
    if (/\s/.test(char)) {
      index += 1;
    } else if (char === "'") {
      let value = "";
      index += 1;
      for (;;) {
        if (index >= text.length) fail("an unterminated string");
        const next = text.charAt(index);
        if (next === "'" && text.charAt(index + 1) === "'") {
          value += "'";
          index += 2;
        } else if (next === "'") {
          index += 1;
          break;
        } else {
          value += next;
          index += 1;
        }
      }
      tokens.push({ kind: "string", value });
    } else if (NAME_START.test(char)) {
      const start = index;
      while (index < text.length && NAME_PART.test(text.charAt(index))) index += 1;
      tokens.push({ kind: "name", value: text.slice(start, index) });
    } else if (DIGIT.test(char) || (char === "-" && DIGIT.test(text.charAt(index + 1)))) {
      // A minus starts a number only when a digit follows it; inside an identifier it stays part of the name, so `a-b` is one reference and not a subtraction, which the grammar has none of.
      const start = index;
      if (char === "-") index += 1;
      while (index < text.length && DIGIT.test(text.charAt(index))) index += 1;
      if (text.charAt(index) === ".") {
        index += 1;
        if (!DIGIT.test(text.charAt(index))) {
          fail(
            `the number ${JSON.stringify(text.slice(start, index))} with no digits after its point`,
          );
        }
        while (index < text.length && DIGIT.test(text.charAt(index))) index += 1;
      }
      const exponent = text.charAt(index);
      if (exponent === "e" || exponent === "E") {
        index += 1;
        const sign = text.charAt(index);
        if (sign === "+" || sign === "-") index += 1;
        if (!DIGIT.test(text.charAt(index))) {
          fail(`the exponent of ${JSON.stringify(text.slice(start, index))} with no digits`);
        }
        while (index < text.length && DIGIT.test(text.charAt(index))) index += 1;
      }
      const value = Number(text.slice(start, index));
      if (!Number.isFinite(value)) {
        fail(`the number ${JSON.stringify(text.slice(start, index))}, which overflows`);
      }
      tokens.push({ kind: "number", value });
    } else if (TWO_CHARACTER.has(text.slice(index, index + 2))) {
      tokens.push({ kind: "punct", value: text.slice(index, index + 2) });
      index += 2;
    } else if (ONE_CHARACTER.has(char)) {
      tokens.push({ kind: "punct", value: char });
      index += 1;
    } else {
      fail(`the character ${JSON.stringify(char)}`);
    }
  }

  return tokens;
}

/**
 * A parsed expression. The grammar is GitHub's: literals, context references with dereference, filter and index, function calls, `!`, the ordering and equality comparisons, and `&&` and `||`, which is every operator GitHub defines; there is no arithmetic to support.
 * @see https://docs.github.com/en/actions/reference/workflows-and-actions/expressions
 */
type Ast =
  | { readonly kind: "null" }
  | { readonly kind: "boolean"; readonly value: boolean }
  | { readonly kind: "string"; readonly value: string }
  | { readonly kind: "number"; readonly value: number }
  | { readonly kind: "context"; readonly name: string }
  | { readonly kind: "property"; readonly of: Ast; readonly name: string }
  | { readonly kind: "each" }
  | {
      readonly kind: "filter";
      readonly of: Ast;
      /** The path that follows the filter, evaluated once per selected value with `each` bound to it, because `a.*.b` reads `b` of every value `a` selected. */
      readonly rest: Ast;
    }
  | { readonly kind: "index"; readonly of: Ast; readonly index: Ast }
  | { readonly kind: "call"; readonly name: string; readonly args: readonly Ast[] }
  | { readonly kind: "not"; readonly of: Ast }
  | { readonly kind: "and"; readonly left: Ast; readonly right: Ast }
  | { readonly kind: "or"; readonly left: Ast; readonly right: Ast }
  | { readonly kind: "equal"; readonly negated: boolean; readonly left: Ast; readonly right: Ast }
  | {
      readonly kind: "compare";
      readonly operator: "<" | "<=" | ">" | ">=";
      readonly left: Ast;
      readonly right: Ast;
    };

/** The ordering operators, as a table so a lookup narrows the token to one of them without a cast. */
const COMPARISON: Readonly<Record<string, "<" | "<=" | ">" | ">=">> = {
  "<": "<",
  "<=": "<=",
  ">": ">",
  ">=": ">=",
};

class Parser {
  private position = 0;

  private readonly tokens: readonly Token[];

  private readonly fail: Fail;

  constructor(tokens: readonly Token[], fail: Fail) {
    this.tokens = tokens;
    this.fail = fail;
  }

  parse(): Ast {
    if (this.tokens.length === 0) this.fail("an empty expression");
    const node = this.or();
    if (this.position < this.tokens.length) this.fail("trailing text after the expression");

    return node;
  }

  private peek(): Token | undefined {
    return this.tokens[this.position];
  }

  private peekPunct(value: string): boolean {
    const token = this.tokens[this.position];

    return token?.kind === "punct" && token.value === value;
  }

  private takePunct(value: string): boolean {
    if (!this.peekPunct(value)) return false;
    this.position += 1;

    return true;
  }

  private expectPunct(value: string, construct: string): void {
    if (!this.takePunct(value)) this.fail(construct);
  }

  private or(): Ast {
    let node = this.and();
    while (this.takePunct("||")) node = { kind: "or", left: node, right: this.and() };

    return node;
  }

  private and(): Ast {
    let node = this.equality();
    while (this.takePunct("&&")) node = { kind: "and", left: node, right: this.equality() };

    return node;
  }

  private equality(): Ast {
    let node = this.comparison();
    for (;;) {
      const negated = this.peekPunct("!=");
      if (!this.takePunct("==") && !this.takePunct("!=")) return node;
      node = { kind: "equal", negated, left: node, right: this.comparison() };
    }
  }

  private comparison(): Ast {
    let node = this.unary();
    for (;;) {
      const token = this.peek();
      if (token?.kind !== "punct") return node;
      const operator = COMPARISON[token.value];
      if (operator === undefined) return node;
      this.position += 1;
      node = { kind: "compare", operator, left: node, right: this.unary() };
    }
  }

  private unary(): Ast {
    if (this.takePunct("!")) return { kind: "not", of: this.unary() };

    return this.postfix();
  }

  private postfix(): Ast {
    return this.postfixOf(this.primary());
  }

  /** The dereference, filter and index chain over a value that is already parsed. */
  private postfixOf(start: Ast): Ast {
    let node = start;
    for (;;) {
      if (this.takePunct(".")) {
        const token = this.peek();
        if (token?.kind === "name") {
          this.position += 1;
          node = { kind: "property", of: node, name: token.value };
        } else if (token?.kind === "punct" && token.value === "*") {
          this.position += 1;
          node = { kind: "filter", of: node, rest: this.postfixOf({ kind: "each" }) };
        } else {
          this.fail("a property name or * after .");
        }
      } else if (this.takePunct("[")) {
        const index = this.or();
        this.expectPunct("]", "an index it does not close");
        node = { kind: "index", of: node, index };
      } else {
        return node;
      }
    }
  }

  private primary(): Ast {
    const token = this.peek();
    if (token === undefined) this.fail("an incomplete expression");
    this.position += 1;
    switch (token.kind) {
      case "string":
        return { kind: "string", value: token.value };
      case "number":
        return { kind: "number", value: token.value };
      case "punct": {
        if (token.value !== "(") this.fail(`the token ${JSON.stringify(token.value)}`);
        const inner = this.or();
        this.expectPunct(")", "a parenthesis it does not close");

        return inner;
      }
      case "name": {
        if (token.value === "true") return { kind: "boolean", value: true };
        if (token.value === "false") return { kind: "boolean", value: false };
        if (token.value === "null") return { kind: "null" };
        if (this.takePunct("(")) {
          return { kind: "call", name: token.value, args: this.callArguments() };
        }

        return { kind: "context", name: token.value };
      }
    }

    return assertNever(token);
  }

  /** The argument list after a call's `(`, through its closing `)`. */
  private callArguments(): readonly Ast[] {
    if (this.takePunct(")")) return [];
    const args: Ast[] = [];
    for (;;) {
      args.push(this.or());
      if (this.takePunct(")")) return args;
      this.expectPunct(",", "an argument without a following comma or closing parenthesis");
    }
  }
}

/**
 * Reads a property the way GitHub's own evaluation does: the name matches without regard to case, and a property the object does not have reads as null rather than failing, which is how a workflow reads `github.event.pull_request` on a push.
 */
function propertyOf(container: ExpressionValue, name: string): ExpressionValue {
  if (container === null || typeof container !== "object" || isArrayValue(container)) return null;
  const sought = name.toLowerCase();
  for (const [key, value] of Object.entries(container)) {
    if (key.toLowerCase() === sought) return value;
  }

  return null;
}

/**
 * Reads an index the way GitHub's own evaluation does: an integer selects an array element and a string selects a property, and anything else, including an index out of range, reads as null.
 */
function indexOf(container: ExpressionValue, index: ExpressionValue): ExpressionValue {
  if (isArrayValue(container)) {
    if (typeof index !== "number" || !Number.isInteger(index)) return null;
    const item: ExpressionValue | undefined = container[index];

    return item === undefined ? null : item;
  }

  return typeof index === "string" ? propertyOf(container, index) : null;
}

/**
 * Reads a secret. A name the host did not supply is an error naming it, because an empty secret would run a step on a value its author never wrote, where GitHub's own empty read at least comes from the platform that owns the secret.
 */
function secretOf(name: string, context: EvaluationContext, fail: Fail): ExpressionValue {
  const value = propertyOf(context.secrets, name);
  if (value === null) fail(`the secret ${JSON.stringify(name)}, which was not supplied`);

  return value;
}

/**
 * Whether a value counts as false where a condition is needed. GitHub's falsy set is false, zero, minus zero, the empty string and null; any other string, including '0' and 'false', counts as true.
 * @see https://docs.github.com/en/actions/reference/workflows-and-actions/expressions
 */
function truthy(value: ExpressionValue): boolean {
  if (value === null || value === false) return false;
  if (value === true) return true;
  if (typeof value === "number") return value !== 0 && !Number.isNaN(value);
  if (typeof value === "string") return value !== "";

  return true;
}

/** A string GitHub reads as a number: a JSON number, since that is the format GitHub documents parsing. */
const JSON_NUMBER = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/;

/**
 * Casts to number the way GitHub documents: null to 0, a boolean to 1 or 0, the empty string to 0 and any other string parsed as a JSON number, with a string that is not one, and any array or object, reading as NaN, which compares unequal to everything.
 * @see https://docs.github.com/en/actions/reference/workflows-and-actions/expressions
 */
function numeric(value: ExpressionValue): number {
  if (value === null) return 0;
  if (value === true) return 1;
  if (value === false) return 0;
  if (typeof value === "number") return value;
  if (value === "") return 0;
  if (typeof value === "string") return JSON_NUMBER.test(value) ? Number(value) : Number.NaN;

  return Number.NaN;
}

/** The significant digits GitHub prints a number to at most, which its own pi example shows rounded at fifteen. */
const SIGNIFICANT_DIGITS = 15;

/**
 * A number as GitHub prints it: at most fifteen significant digits, in decimal form with exponential notation for large magnitudes. The thresholds are not documented, so this follows JavaScript's own notation after the rounding, which agrees with GitHub on the values workflows write.
 */
function numberText(value: number): string {
  if (Object.is(value, -0)) return "0";

  return String(Number(value.toPrecision(SIGNIFICANT_DIGITS)));
}

/**
 * Casts to string the way GitHub documents: null to the empty string, a boolean to 'true' or 'false', a number to its decimal form. Arrays and objects have no string form; casting one is an error rather than a guess, which is what toJSON() is for.
 * @see https://docs.github.com/en/actions/reference/workflows-and-actions/expressions
 */
function stringOf(value: ExpressionValue, fail: Fail): string {
  if (value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return numberText(value);

  return fail("an array or object where a string is required; toJSON() renders one");
}

/**
 * Compares for loose equality the way GitHub documents: strings ignore case, arrays and objects are equal only as the same instance, and every other pair is cast to number, where NaN makes the comparison false.
 * @see https://docs.github.com/en/actions/reference/workflows-and-actions/expressions
 */
function equals(left: ExpressionValue, right: ExpressionValue): boolean {
  if (typeof left === "string" && typeof right === "string") {
    return left.toLowerCase() === right.toLowerCase();
  }
  const eitherObject =
    (left !== null && typeof left === "object") || (right !== null && typeof right === "object");
  if (eitherObject) return left === right;

  return numeric(left) === numeric(right);
}

/**
 * Orders two values the way GitHub documents: both cast to number, and a comparison with NaN on either side is false rather than an error.
 * @see https://docs.github.com/en/actions/reference/workflows-and-actions/expressions
 */
function compare(
  operator: "<" | "<=" | ">" | ">=",
  left: ExpressionValue,
  right: ExpressionValue,
): boolean {
  const a = numeric(left);
  const b = numeric(right);
  if (Number.isNaN(a) || Number.isNaN(b)) return false;

  return operator === "<" ? a < b : operator === "<=" ? a <= b : operator === ">" ? a > b : a >= b;
}

/** Narrows a parsed JSON value to an expression value, so fromJSON's result carries the type every other value here has. */
function isValue(value: unknown): value is ExpressionValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (Array.isArray(value)) return value.every(isValue);
  if (typeof value === "object") return Object.values(value).every(isValue);

  return false;
}

/** Parses JSON for fromJSON(), reporting as an evaluation error the text JSON.parse rejects. */
function parseJson(source: string, fail: Fail): unknown {
  try {
    return JSON.parse(source);
  } catch {
    return fail("fromJSON() of text that is not JSON");
  }
}

/** Every needed job's result, in the order the context lists the jobs. */
function results(context: EvaluationContext): string[] {
  return Object.values(context.needs).map((need) => need.result);
}

/** Every step's conclusion, in the order the context lists the steps. */
function conclusions(context: EvaluationContext): string[] {
  return Object.values(context.steps).map((step) => step.conclusion);
}

/** The argument at a position, for a call whose arity the caller has already fixed. */
function argumentOf(
  name: string,
  args: readonly ExpressionValue[],
  position: number,
  fail: Fail,
): ExpressionValue {
  const value = args[position];
  if (value === undefined) fail(`the function ${name}() without its argument ${String(position)}`);

  return value;
}

/**
 * Expands a `format()` pattern: `{N}` takes the Nth replacement value, and a doubled brace is a literal brace. The pattern must name at least one replacement value, and a placeholder beyond them is an error rather than an empty substitution.
 */
function formatOf(values: readonly ExpressionValue[], fail: Fail): string {
  const pattern = values[0];
  if (values.length < 2 || pattern === undefined) {
    fail("format() without a pattern and at least one replacement value");
  }
  const replacements = values.slice(1);
  const source = stringOf(pattern, fail);
  let out = "";
  let index = 0;
  while (index < source.length) {
    const char = source.charAt(index);
    if (char === "{") {
      if (source.charAt(index + 1) === "{") {
        out += "{";
        index += 2;
        continue;
      }
      const end = source.indexOf("}", index + 1);
      if (end === -1) {
        fail(
          `the format pattern ${JSON.stringify(source)}, which opens a placeholder it does not close`,
        );
      }
      const digits = source.slice(index + 1, end);
      if (!/^[0-9]+$/.test(digits)) {
        fail(`the placeholder {${digits}} in a format pattern, which is not a number`);
      }
      const replacement = replacements[Number(digits)];
      if (replacement === undefined) {
        fail(
          `the placeholder {${digits}} in a format pattern, which exceeds its replacement values`,
        );
      }
      out += stringOf(replacement, fail);
      index = end + 1;
    } else if (char === "}") {
      out += "}";
      index += source.charAt(index + 1) === "}" ? 2 : 1;
    } else {
      out += char;
      index += 1;
    }
  }

  return out;
}

/**
 * Calls a function. The status functions read the needs results and step conclusions of the supplied context, which is the status view a local run has; `cancelled()` reads the same view because this evaluator has no run of its own to observe. `hashFiles()` is rejected, not approximated: it hashes workspace files matched by globs, and no file port is supplied here.
 * @see https://docs.github.com/en/actions/reference/workflows-and-actions/expressions
 */
function callOf(
  name: string,
  args: readonly ExpressionValue[],
  context: EvaluationContext,
  fail: Fail,
): ExpressionValue {
  const arity = (least: number, most: number = least): void => {
    if (args.length < least || args.length > most) {
      const takes = most === least ? String(least) : `${String(least)} or ${String(most)}`;
      const given = `${String(args.length)} argument${args.length === 1 ? "" : "s"}`;
      fail(`the function ${name}() with ${given}, where it takes ${takes}`);
    }
  };

  switch (name) {
    case "contains": {
      arity(2);
      const search = argumentOf(name, args, 0, fail);
      const item = argumentOf(name, args, 1, fail);
      if (isArrayValue(search)) return search.some((entry) => equals(entry, item));

      return stringOf(search, fail).toLowerCase().includes(stringOf(item, fail).toLowerCase());
    }
    case "startsWith": {
      arity(2);
      const search = argumentOf(name, args, 0, fail);
      const prefix = argumentOf(name, args, 1, fail);

      return stringOf(search, fail).toLowerCase().startsWith(stringOf(prefix, fail).toLowerCase());
    }
    case "endsWith": {
      arity(2);
      const search = argumentOf(name, args, 0, fail);
      const suffix = argumentOf(name, args, 1, fail);

      return stringOf(search, fail).toLowerCase().endsWith(stringOf(suffix, fail).toLowerCase());
    }
    case "join": {
      arity(1, 2);
      const list = argumentOf(name, args, 0, fail);
      const separator = args.length === 2 ? stringOf(argumentOf(name, args, 1, fail), fail) : ",";
      if (isArrayValue(list)) return list.map((entry) => stringOf(entry, fail)).join(separator);

      return stringOf(list, fail);
    }
    case "toJSON":
      arity(1);

      return JSON.stringify(argumentOf(name, args, 0, fail), null, 2);
    case "fromJSON": {
      arity(1);
      const source = argumentOf(name, args, 0, fail);
      if (typeof source !== "string") fail("fromJSON() of a value that is not a string");
      const parsed: unknown = parseJson(source, fail);
      if (!isValue(parsed)) fail("fromJSON() of JSON with a value no expression carries");

      return parsed;
    }
    case "format":
      return formatOf(args, fail);
    case "success": {
      arity(0);

      return (
        results(context).every((result) => result === "success") &&
        conclusions(context).every(
          (conclusion) => conclusion === "success" || conclusion === "skipped",
        )
      );
    }
    case "failure":
      arity(0);

      return [...results(context), ...conclusions(context)].includes("failure");
    case "cancelled":
      arity(0);

      return [...results(context), ...conclusions(context)].includes("cancelled");
    case "always":
      arity(0);

      return true;
    case "hashFiles":
      return fail(
        "the function hashFiles(), which hashes workspace files matched by globs; no file port is supplied to this evaluator",
      );
    default:
      return fail(`the function ${name}()`);
  }
}

function evaluate(
  node: Ast,
  context: EvaluationContext,
  fail: Fail,
  each: ExpressionValue,
): ExpressionValue {
  switch (node.kind) {
    case "null":
      return null;
    case "boolean":
      return node.value;
    case "string":
      return node.value;
    case "number":
      return node.value;
    case "each":
      return each;
    case "context":
      switch (node.name) {
        case "github":
          return context.github;
        case "env":
          return context.env;
        case "job":
          return context.job;
        case "steps":
          return context.steps;
        case "needs":
          return context.needs;
        case "matrix":
          return context.matrix;
        case "secrets":
          return context.secrets;
        case "inputs":
          return context.inputs;
        default:
          return fail(
            `the context ${node.name}, which is not among github, env, job, steps, needs, matrix, secrets and inputs`,
          );
      }
    case "property": {
      if (node.of.kind === "context" && node.of.name === "secrets") {
        return secretOf(node.name, context, fail);
      }

      return propertyOf(evaluate(node.of, context, fail, each), node.name);
    }
    case "index": {
      const index = evaluate(node.index, context, fail, each);
      if (node.of.kind === "context" && node.of.name === "secrets" && typeof index === "string") {
        return secretOf(index, context, fail);
      }

      return indexOf(evaluate(node.of, context, fail, each), index);
    }
    case "filter": {
      const container = evaluate(node.of, context, fail, each);
      const selected = isArrayValue(container)
        ? container
        : container !== null && typeof container === "object"
          ? Object.values(container)
          : [];

      return selected.map((entry) => evaluate(node.rest, context, fail, entry));
    }
    case "call":
      return callOf(
        node.name,
        node.args.map((argument) => evaluate(argument, context, fail, each)),
        context,
        fail,
      );
    case "not":
      return !truthy(evaluate(node.of, context, fail, each));
    case "and": {
      // The operands keep their own values, which the `env.X || 'default'` idiom relies on, and the second is not evaluated when the first decides the result.
      const left = evaluate(node.left, context, fail, each);

      return truthy(left) ? evaluate(node.right, context, fail, each) : left;
    }
    case "or": {
      const left = evaluate(node.left, context, fail, each);

      return truthy(left) ? left : evaluate(node.right, context, fail, each);
    }
    case "equal": {
      const same = equals(
        evaluate(node.left, context, fail, each),
        evaluate(node.right, context, fail, each),
      );

      return node.negated ? !same : same;
    }
    case "compare":
      return compare(
        node.operator,
        evaluate(node.left, context, fail, each),
        evaluate(node.right, context, fail, each),
      );
  }

  return assertNever(node);
}

/**
 * Evaluates GitHub Actions expression text against a context. The text is one expression, without the `${{ }}` wrapper; anything the grammar does not carry, a context it does not read or a secret it was not given raises `EvaluationError` naming the construct.
 * @see https://docs.github.com/en/actions/reference/workflows-and-actions/expressions
 */
export function evaluateExpression(text: string, context: EvaluationContext): ExpressionValue {
  const fail: Fail = (construct) => {
    throw new EvaluationError(text, construct);
  };

  return evaluate(parse(text, fail), context, fail, null);
}

/** A `${{ }}` expression. A `}` inside a quoted string, as in `format('v{0}', x)`, does not end it. */
const EXPRESSION = /\$\{\{\s*((?:[^}']|'[^']*')*?)\s*\}\}/g;

/**
 * Evaluates the `${{ }}` expressions in a text the way GitHub does before the shell or a value's consumer sees it: each one is replaced by the string form of its result, and text with no expression, or with a `${{` that no `}}` closes, is left as written.
 * @see https://docs.github.com/en/actions/reference/workflows-and-actions/expressions
 */
export function evaluateTemplate(source: string, context: EvaluationContext): string {
  return source.replace(EXPRESSION, (_whole, expression: string) =>
    stringOf(evaluateExpression(expression, context), (construct) => {
      throw new EvaluationError(expression, construct);
    }),
  );
}

/** Parses expression text into an AST, reporting anything the grammar does not carry. */
function parse(text: string, fail: Fail): Ast {
  return new Parser(tokenise(text, fail), fail).parse();
}

/**
 * Evaluates an `if` value: its text, optionally wrapped in a single `${{ }}`, read as one expression and cast to the boolean a condition needs.
 */
export function evaluateCondition(text: string, context: EvaluationContext): boolean {
  const trimmed = text.trim();
  const wrapped = /^\$\{\{([\s\S]*)\}\}$/.exec(trimmed);

  return truthy(evaluateExpression(wrapped?.[1] ?? trimmed, context));
}
