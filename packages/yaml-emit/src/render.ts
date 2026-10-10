import { Document, isMap, isScalar, isSeq } from "yaml";

/**
 * Comments to attach, keyed by the path of the node they precede. A path is the mapping keys and sequence indexes from the document root, joined by `/` (for example `jobs/lint` or `jobs/lint/steps/0`).
 */
export type CommentTable = ReadonlyMap<string, string>;

/**
 * Builds a comment path from segments, escaping `~` and `/` inside a segment the way a JSON pointer does, so a mapping key that contains a slash (a branch name such as `feature/foo`) is one segment and not two.
 */
export function commentPath(...segments: readonly string[]): string {
  return segments.map((segment) => segment.replaceAll("~", "~0").replaceAll("/", "~1")).join("/");
}

function segmentsOf(path: string): string[] {
  return path.split("/").map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"));
}

function commentable(node: unknown): node is { commentBefore?: string | null } {
  return typeof node === "object" && node !== null;
}

/**
 * Finds the node a comment at `segments` should precede: the key of a mapping entry, or the item of a sequence.
 */
function target(
  root: unknown,
  segments: readonly string[],
): { commentBefore?: string | null } | undefined {
  let current: unknown = root;
  for (const [position, segment] of segments.entries()) {
    const last = position === segments.length - 1;
    if (isMap(current)) {
      const pair = current.items.find(
        (candidate) => isScalar(candidate.key) && String(candidate.key.value) === segment,
      );
      if (pair === undefined) return undefined;
      if (last) return commentable(pair.key) ? pair.key : undefined;
      current = pair.value;
    } else if (isSeq(current)) {
      const item: unknown = current.items[Number(segment)];
      if (item === undefined) return undefined;
      if (last) return commentable(item) ? item : undefined;
      current = item;
    } else {
      return undefined;
    }
  }

  return undefined;
}

function asComment(text: string): string {
  return text
    .split("\n")
    .map((line) => ` ${line}`)
    .join("\n");
}

/**
 * Renders `value` as block-style YAML with deterministic key order (insertion order), no line folding, a leading comment header and the given node comments.
 *
 * A comment whose path matches no node is a defect in the caller, so it throws rather than being dropped.
 */
export function renderYaml(
  value: unknown,
  comments: CommentTable,
  headerLines: readonly string[],
): string {
  const document = new Document(value, { aliasDuplicateObjects: false });
  document.commentBefore = asComment(headerLines.join("\n"));
  for (const [path, text] of comments) {
    const node = target(document.contents, segmentsOf(path));
    if (node === undefined) throw new Error(`no node at ${path} to carry a comment`);
    node.commentBefore = asComment(text);
  }

  return document.toString({ lineWidth: 0 });
}
