import {
  assertNever,
  predicateOf,
  type Condition,
  type Operand,
  type PredicateNode,
} from "@pipewright/pipeline-contract";

import { CONTEXT_OF_VARIABLE, EVENT_OF_SOURCE, literalOfRegex } from "./vocabulary.ts";

/**
 * Raised for an expression the neutral model cannot express. The message names the construct; the importer decides whether that rejects the file or carries the rules verbatim.
 */
export class ExpressionError extends Error {
  constructor(construct: string) {
    super(construct);
    this.name = "ExpressionError";
  }
}

type Token =
  | { readonly kind: "variable"; readonly name: string }
  | { readonly kind: "string"; readonly value: string }
  | { readonly kind: "regex"; readonly body: string; readonly flags: string }
  | { readonly kind: "punct"; readonly value: string };

const VARIABLE = /[A-Za-z0-9_]/;
const OPERATORS = new Set(["&&", "||", "==", "!=", "=~", "!~"]);

function tokenise(text: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < text.length) {
    const char = text.charAt(index);
    if (/\s/.test(char)) {
      index += 1;
    } else if (char === "$") {
      const start = index + 1;
      index = start;
      while (index < text.length && VARIABLE.test(text.charAt(index))) index += 1;
      if (index === start) throw new ExpressionError("a bare $");
      tokens.push({ kind: "variable", name: text.slice(start, index) });
    } else if (char === '"' || char === "'") {
      const end = text.indexOf(char, index + 1);
      if (end === -1) throw new ExpressionError("an unterminated string");
      tokens.push({ kind: "string", value: text.slice(index + 1, end) });
      index = end + 1;
    } else if (char === "/") {
      let end = index + 1;
      while (end < text.length && text.charAt(end) !== "/")
        end += text.charAt(end) === "\\" ? 2 : 1;
      if (end >= text.length) throw new ExpressionError("an unterminated regular expression");
      const body = text.slice(index + 1, end);
      let flagsEnd = end + 1;
      while (flagsEnd < text.length && /[a-z]/.test(text.charAt(flagsEnd))) flagsEnd += 1;
      tokens.push({ kind: "regex", body, flags: text.slice(end + 1, flagsEnd) });
      index = flagsEnd;
    } else if (OPERATORS.has(text.slice(index, index + 2))) {
      tokens.push({ kind: "punct", value: text.slice(index, index + 2) });
      index += 2;
    } else if (char === "(" || char === ")") {
      tokens.push({ kind: "punct", value: char });
      index += 1;
    } else {
      throw new ExpressionError(`the character ${JSON.stringify(char)}`);
    }
  }

  return tokens;
}

type Value =
  | { readonly kind: "variable"; readonly name: string }
  | { readonly kind: "string"; readonly value: string }
  | { readonly kind: "regex"; readonly body: string; readonly flags: string };

type Node =
  | {
      readonly kind: "compare";
      readonly operator: string;
      readonly left: Value;
      readonly right: Value;
    }
  | { readonly kind: "and"; readonly operands: readonly Node[] }
  | { readonly kind: "or"; readonly operands: readonly Node[] }
  | { readonly kind: "group"; readonly inner: Node };

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

  private takePunct(value: string): boolean {
    const token = this.tokens[this.position];
    if (token?.kind !== "punct" || token.value !== value) return false;
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
    return this.chain("&&", () => this.primary());
  }

  private value(): Value {
    const token = this.tokens[this.position];
    if (token === undefined || token.kind === "punct") {
      throw new ExpressionError("an incomplete comparison");
    }
    this.position += 1;

    return token;
  }

  private primary(): Node {
    if (this.takePunct("(")) {
      const inner = this.or();
      if (!this.takePunct(")")) throw new ExpressionError("an unclosed parenthesis");

      return { kind: "group", inner };
    }
    const left = this.value();
    const token = this.tokens[this.position];
    if (token?.kind !== "punct" || !["==", "!=", "=~", "!~"].includes(token.value)) {
      throw new ExpressionError("a value used as a condition");
    }
    this.position += 1;

    return { kind: "compare", operator: token.value, left, right: this.value() };
  }
}

function contextOperand(value: Value): Operand {
  if (value.kind === "variable") {
    const key = CONTEXT_OF_VARIABLE.get(`$${value.name}`);
    if (key !== undefined) return { kind: "context", key };

    throw new ExpressionError(`the variable $${value.name}`);
  }

  throw new ExpressionError("a comparison with no variable");
}

/**
 * The text a context variable is compared with. The event is compared by its pipeline source in GitLab and by its kind in the model.
 */
function textOperand(value: Value, subject: Operand): Operand {
  if (value.kind !== "regex")
    throw new ExpressionError("a comparison that is not a regular expression");
  if (value.flags !== "i" || !value.body.startsWith("^") || !value.body.endsWith("$")) {
    throw new ExpressionError(
      "a regular expression that is not an anchored case-insensitive match",
    );
  }
  const literal = literalOfRegex(value.body.slice(1, -1));
  if (literal === undefined) {
    throw new ExpressionError("a regular expression that matches more than one value");
  }
  if (subject.kind === "context" && subject.key === "event") {
    const kind = EVENT_OF_SOURCE.get(literal);
    if (kind === undefined) {
      throw new ExpressionError(`the pipeline source ${JSON.stringify(literal)}`);
    }

    return { kind: "text", value: kind };
  }

  return { kind: "text", value: literal };
}

function conditionOf(node: Node): Condition {
  switch (node.kind) {
    case "and":
      return { kind: "allOf", operands: node.operands.map(conditionOf) };
    case "or":
      return { kind: "anyOf", operands: node.operands.map(conditionOf) };
    case "group": {
      // A chain writes its own parentheses, so the group around one is that node. A comparison writes none, so a group around it is a layer a single-operand disjunction renders as.
      const own = node.inner.kind === "and" || node.inner.kind === "or";

      return own ? conditionOf(node.inner) : { kind: "anyOf", operands: [conditionOf(node.inner)] };
    }
    case "compare": {
      const negated = node.operator === "!=" || node.operator === "!~";
      if (node.operator === "==" || node.operator === "!=") {
        // The compiler writes a comparison of two texts as the constant `"1" == "1"` or `"1" == "0"`. Any other `==` is case-sensitive, which the model's equality is not.
        const left = node.left.kind === "string" ? node.left.value : undefined;
        const right = node.right.kind === "string" ? node.right.value : undefined;
        if (node.operator === "==" && left === "1" && (right === "1" || right === "0")) {
          return {
            kind: "equals",
            left: { kind: "text", value: left },
            right: { kind: "text", value: right },
            negated: false,
          };
        }
        throw new ExpressionError("a case-sensitive comparison");
      }
      const subject = contextOperand(node.left);

      return { kind: "equals", left: subject, right: textOperand(node.right, subject), negated };
    }
  }

  return assertNever(node);
}

/**
 * Parses a GitLab `rules:if` expression into the model's predicate tree. Throws `ExpressionError` for anything the model has no construct for: a case-sensitive comparison, a variable outside the neutral context vocabulary, a regular expression that is not an anchored case-insensitive literal.
 */
export function parseRuleIf(text: string): PredicateNode {
  return predicateOf(conditionOf(new Parser(tokenise(text)).parse()));
}
