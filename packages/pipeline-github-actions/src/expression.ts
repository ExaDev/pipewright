import {
  assertNever,
  predicateOf,
  type Condition,
  type Operand,
  type PredicateNode,
} from "@pipewright/pipeline-contract";

import { CONTEXT_OF_EXPRESSION, EVENT_OF_NAME } from "./vocabulary.ts";

/**
 * Raised for an expression the neutral model cannot express. The message names the construct; the importer decides whether that rejects the file or carries the expression verbatim.
 */
export class ExpressionError extends Error {
  constructor(construct: string) {
    super(construct);
    this.name = "ExpressionError";
  }
}

type Token =
  | { readonly kind: "string"; readonly value: string }
  | { readonly kind: "name"; readonly value: string }
  | { readonly kind: "number" }
  | { readonly kind: "punct"; readonly value: string };

const NAME_START = /[A-Za-z_]/;
const NAME_PART = /[A-Za-z0-9_.*-]/;
const DIGIT = /[0-9]/;
const TWO_CHARACTER = new Set(["&&", "||", "==", "!="]);
const ONE_CHARACTER = new Set(["(", ")", "!", ","]);

function tokenise(text: string): Token[] {
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
        if (index >= text.length) throw new ExpressionError("an unterminated string");
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
    } else if (DIGIT.test(char)) {
      while (index < text.length && /[0-9.]/.test(text.charAt(index))) index += 1;
      tokens.push({ kind: "number" });
    } else if (TWO_CHARACTER.has(text.slice(index, index + 2))) {
      tokens.push({ kind: "punct", value: text.slice(index, index + 2) });
      index += 2;
    } else if (ONE_CHARACTER.has(char)) {
      tokens.push({ kind: "punct", value: char });
      index += 1;
    } else {
      throw new ExpressionError(`the operator or character ${JSON.stringify(char)}`);
    }
  }

  return tokens;
}

/**
 * A parsed expression, grouping preserved: a parenthesised sub-expression is its own node, so `((a) || (b)) || (c)` and `(a) || (b) || (c)` read back as the different trees they are.
 */
type Node =
  | { readonly kind: "boolean"; readonly value: boolean }
  | { readonly kind: "string"; readonly value: string }
  | { readonly kind: "path"; readonly path: string }
  | { readonly kind: "call"; readonly name: string }
  | { readonly kind: "not"; readonly operand: Node }
  | { readonly kind: "and"; readonly operands: readonly Node[] }
  | { readonly kind: "or"; readonly operands: readonly Node[] }
  | { readonly kind: "group"; readonly inner: Node }
  | {
      readonly kind: "compare";
      readonly negated: boolean;
      readonly left: Node;
      readonly right: Node;
    };

class Parser {
  private position = 0;

  private readonly tokens: readonly Token[];

  constructor(tokens: readonly Token[]) {
    this.tokens = tokens;
  }

  parse(): Node {
    const node = this.or();
    if (this.position < this.tokens.length) {
      throw new ExpressionError("trailing text after the expression");
    }

    return node;
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

  private chain(operator: "&&" | "||", next: () => Node): Node {
    const operands = [next()];
    while (this.takePunct(operator)) operands.push(next());
    const [only] = operands;

    return operands.length === 1 && only !== undefined
      ? only
      : { kind: operator === "&&" ? "and" : "or", operands };
  }

  private or(): Node {
    return this.chain("||", () => this.and());
  }

  private and(): Node {
    return this.chain("&&", () => this.comparison());
  }

  private comparison(): Node {
    const left = this.unary();
    const negated = this.peekPunct("!=");
    if (this.takePunct("==") || this.takePunct("!=")) {
      return { kind: "compare", negated, left, right: this.unary() };
    }

    return left;
  }

  private unary(): Node {
    if (this.takePunct("!")) return { kind: "not", operand: this.unary() };

    return this.primary();
  }

  private primary(): Node {
    const token = this.tokens[this.position];
    if (token === undefined) throw new ExpressionError("an incomplete expression");
    this.position += 1;
    if (token.kind === "string") return { kind: "string", value: token.value };
    if (token.kind === "number") throw new ExpressionError("a number");
    if (token.kind === "punct") {
      if (token.value !== "(")
        throw new ExpressionError(`the token ${JSON.stringify(token.value)}`);
      const inner = this.or();
      if (!this.takePunct(")")) throw new ExpressionError("an unclosed parenthesis");

      return { kind: "group", inner };
    }
    if (token.value === "true" || token.value === "false") {
      return { kind: "boolean", value: token.value === "true" };
    }
    if (this.takePunct("(")) {
      if (!this.takePunct(")")) {
        throw new ExpressionError(`the function ${token.value} with arguments`);
      }

      return { kind: "call", name: token.value };
    }

    return { kind: "path", path: token.value };
  }
}

const MATRIX_PREFIX = "matrix.";
const AXIS = /^[A-Za-z][A-Za-z0-9_]*$/;

function operandOf(node: Node, allowMatrix: boolean): Operand {
  if (node.kind === "string") return { kind: "text", value: node.value };
  if (node.kind === "path") {
    const context = CONTEXT_OF_EXPRESSION.get(node.path);
    if (context !== undefined) return { kind: "context", key: context };
    if (node.path.startsWith(MATRIX_PREFIX) && AXIS.test(node.path.slice(MATRIX_PREFIX.length))) {
      if (!allowMatrix) {
        throw new ExpressionError("a matrix reference in a job-level condition");
      }

      return { kind: "matrix", name: node.path.slice(MATRIX_PREFIX.length) };
    }
    throw new ExpressionError(`the value ${node.path}`);
  }

  throw new ExpressionError("a comparison operand that is not a context value or a string");
}

/**
 * The model compares an event as its own kind name, where GitHub compares its event name, so a text operand set against the event is translated.
 */
function withEventKinds(left: Operand, right: Operand): [Operand, Operand] {
  const translate = (operand: Operand, other: Operand): Operand => {
    if (operand.kind !== "text" || other.kind !== "context" || other.key !== "event") {
      return operand;
    }
    const kind = EVENT_OF_NAME.get(operand.value);
    if (kind === undefined) {
      throw new ExpressionError(`the event value ${JSON.stringify(operand.value)}`);
    }

    return { kind: "text", value: kind };
  };

  return [translate(left, right), translate(right, left)];
}

function conditionOf(node: Node, allowMatrix: boolean): Condition {
  const child = (next: Node): Condition => conditionOf(next, allowMatrix);

  switch (node.kind) {
    case "boolean":
      return { kind: node.value ? "allOf" : "anyOf", operands: [] };
    case "group": {
      // A comparison and a chain write their own parentheses, so the group around one is that node. Any other group adds a layer of its own, which a single-operand disjunction renders as, so the text is read back exactly.
      const own = ["compare", "and", "or"].includes(node.inner.kind);

      return own ? child(node.inner) : { kind: "anyOf", operands: [child(node.inner)] };
    }
    case "not":
      return { kind: "not", operand: child(node.operand) };
    case "and":
      return { kind: "allOf", operands: node.operands.map(child) };
    case "or":
      return { kind: "anyOf", operands: node.operands.map(child) };
    case "compare": {
      const [left, right] = withEventKinds(
        operandOf(node.left, allowMatrix),
        operandOf(node.right, allowMatrix),
      );

      return { kind: "equals", left, right, negated: node.negated };
    }
    case "call":
      throw new ExpressionError(`the function ${node.name}()`);
    case "string":
    case "path":
      throw new ExpressionError("a value used as a condition");
  }

  return assertNever(node);
}

/**
 * What a `${{ }}`-free `if` expression means: whether it begins with the `always()` that a job writes to run regardless of its dependencies, and the condition that remains, if any.
 */
export interface ParsedIf {
  readonly always: boolean;
  readonly condition: PredicateNode | undefined;
}

function stripWrapper(text: string): string {
  const trimmed = text.trim();
  const wrapped = /^\$\{\{([\s\S]*)\}\}$/.exec(trimmed);

  return wrapped?.[1] ?? trimmed;
}

/**
 * Parses a GitHub `if` expression into the model's condition. `leadingAlways` allows a job's `always()` conjunct, which is returned as `always` and not as a condition, and `allowMatrix` whether `matrix.<axis>` may be compared.
 *
 * Throws `ExpressionError` for anything the model has no construct for (a status function other than a leading `always()`, a number, an ordering comparison, a context value outside the neutral vocabulary), naming it.
 */
export function parseIf(
  text: string,
  options: { readonly leadingAlways: boolean; readonly allowMatrix: boolean },
): ParsedIf {
  const root = new Parser(tokenise(stripWrapper(text))).parse();
  let remainder: Node | undefined = root;
  let always = false;
  if (options.leadingAlways) {
    if (root.kind === "call" && root.name === "always") {
      always = true;
      remainder = undefined;
    } else if (root.kind === "and") {
      const [first, ...rest] = root.operands;
      if (first?.kind === "call" && first.name === "always") {
        always = true;
        const [only] = rest;
        remainder =
          rest.length === 1 && only !== undefined ? only : { kind: "and", operands: rest };
      }
    }
  }

  return {
    always,
    condition:
      remainder === undefined
        ? undefined
        : predicateOf(conditionOf(remainder, options.allowMatrix)),
  };
}
