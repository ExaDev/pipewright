import { isMap, isScalar, isSeq, parseDocument } from "yaml";

import { commentPath } from "./render.ts";

/**
 * A parsed YAML document: its plain value, and the comment that precedes each mapping key or sequence item, keyed by the same path scheme `renderYaml` takes, so what the emitter wrote can be read back.
 */
export interface ReadYaml {
  readonly value: unknown;
  readonly comments: ReadonlyMap<string, string>;
}

/**
 * The inverse of the emitter's comment formatting: it writes each line after one leading space.
 */
function stripComment(text: string): string {
  return text
    .split("\n")
    .map((line) => (line.startsWith(" ") ? line.slice(1) : line))
    .join("\n");
}

/**
 * Removes the generated header from the comment on a document's first key. The emitter writes the header, a blank line, then the key's own comment, and the parser merges them into one block; a block whose first paragraph is followed by a blank line is read that way.
 */
function withoutHeader(text: string): string | undefined {
  const separator = text.indexOf("\n\n");
  if (separator === -1) return text;
  const own = text.slice(separator + 2);

  return own === "" ? undefined : own;
}

function commentOf(node: unknown): string | undefined {
  if (typeof node !== "object" || node === null || !("commentBefore" in node)) return undefined;

  return typeof node.commentBefore === "string" ? node.commentBefore : undefined;
}

/**
 * Where a node sits, which decides whose comment it carries: the document's root mapping (whose first key's comment may include the generated header), a sequence item (whose comment is the item's own), or any other value.
 */
type Position = "root" | "item" | "value";

function collect(
  node: unknown,
  segments: readonly string[],
  into: Map<string, string>,
  position: Position,
): void {
  const record = (at: readonly string[], text: string | undefined): void => {
    if (text === undefined || at.length === 0) return;
    const cleaned = stripComment(text);
    const own = position === "root" && at.length === 1 ? withoutHeader(cleaned) : cleaned;
    if (own !== undefined && own !== "") into.set(commentPath(...at), own);
  };

  if (isMap(node)) {
    for (const [index, pair] of node.items.entries()) {
      if (!isScalar(pair.key)) continue;
      const key = String(pair.key.value);
      const at = [...segments, key];
      // The parser hangs the comment before a mapping's first key on the mapping itself, not on the key, unless the mapping is a sequence item, whose own comment it already is.
      const text =
        commentOf(pair.key) ?? (index === 0 && position !== "item" ? commentOf(node) : undefined);
      record(at, text);
      collect(pair.value, at, into, "value");
    }
  } else if (isSeq(node)) {
    for (const [index, item] of node.items.entries()) {
      const at = [...segments, String(index)];
      const own = commentOf(item);
      record(at, own ?? (index === 0 ? commentOf(node) : undefined));
      // A mapping that is a sequence item carries the item's comment itself, which is not also its first key's.
      collect(item, at, into, "item");
    }
  }
}

/**
 * Parses YAML text, throwing on any syntax error. Comments that precede a mapping key or a sequence item are returned keyed by the path of that node.
 */
export function readYaml(text: string): ReadYaml {
  // Merge keys (`<<`) are expanded, because GitLab files use them to share job settings.
  const document = parseDocument(text, { prettyErrors: false, merge: true });
  const [first] = document.errors;
  if (first !== undefined) throw new Error(first.message);

  const comments = new Map<string, string>();
  collect(document.contents, [], comments, "root");

  return { value: document.toJS(), comments };
}
