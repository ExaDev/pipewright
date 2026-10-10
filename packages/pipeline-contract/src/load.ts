import { JsonValueSchema, type JsonValue } from "trilean";
import { z } from "zod";

import { pipelineSchema, type Pipeline } from "./schema.ts";

/**
 * The only I/O the loader performs, injected so it runs in any runtime. `path` is a normalised POSIX path relative to whatever root the caller chose.
 */
export interface FileReader {
  read(path: string): Promise<string>;
}

export interface LoadIssue {
  readonly message: string;
  /** The file the offending node was authored in, which may be a fragment reached through `extends`. */
  readonly file: string;
  /** JSON pointer to the node within that file. */
  readonly pointer: string;
}

/**
 * Raised for every defect in a pipeline document: unreadable or malformed JSON, an unresolved or cyclic `extends`, a bad parameter, or a schema violation. Each issue names the source file and JSON pointer of the node as authored, including across `extends` boundaries.
 */
export class PipelineLoadError extends Error {
  readonly issues: readonly LoadIssue[];

  constructor(issues: readonly LoadIssue[]) {
    super(
      issues.map((issue) => `${issue.file}#${issue.pointer}: ${issue.message}`).join("\n"),
    );
    this.name = "PipelineLoadError";
    this.issues = issues;
  }
}

export interface LoadedPipeline {
  readonly pipeline: Pipeline;
  /** Every file read, entry first, in the order they were first reached. */
  readonly files: readonly string[];
}

interface Origin {
  readonly file: string;
  readonly pointer: string;
}

type TreeNode = { readonly origin: Origin } & (
  | { readonly kind: "leaf"; readonly value: string | number | boolean | null }
  | { readonly kind: "object"; readonly entries: ReadonlyMap<string, TreeNode> }
  | { readonly kind: "array"; readonly items: readonly TreeNode[] }
);

const REPLACE_KEY = "$replace";
const PARAM_KEY = "$param";
/** Arrays under these keys concatenate across `extends`; every other array is replaced by the overriding file's. */
const CONCATENATED_KEYS: ReadonlySet<string> = new Set(["steps"]);

const scalarSchema = z.union([z.string(), z.number(), z.boolean()]);
type Scalar = z.infer<typeof scalarSchema>;

const parameterDeclarationSchema = z.strictObject({
  type: z.enum(["string", "number", "boolean"]),
  default: scalarSchema.optional(),
  description: z.string().optional(),
});

const extendsEntrySchema = z.union([
  z.string().min(1),
  z.strictObject({
    path: z.string().min(1),
    with: z.record(z.string(), scalarSchema).optional(),
  }),
]);

const documentHeaderSchema = z.object({
  extends: z.union([extendsEntrySchema, z.array(extendsEntrySchema)]).optional(),
  parameters: z.record(z.string(), parameterDeclarationSchema).optional(),
});

function escapePointer(segment: string): string {
  return segment.replaceAll("~", "~0").replaceAll("/", "~1");
}

function pointerOf(path: readonly PropertyKey[]): string {
  return path.map((segment) => `/${escapePointer(String(segment))}`).join("");
}

/**
 * Resolves `relative` against the directory of `from`, normalising `.` and `..` segments.
 */
export function resolveRelative(from: string, relative: string): string {
  const segments = from.split("/").slice(0, -1);
  for (const segment of relative.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  return segments.join("/");
}

function buildTree(value: JsonValue, origin: Origin): TreeNode {
  if (Array.isArray(value)) {
    return {
      origin,
      kind: "array",
      items: value.map((item, index) =>
        buildTree(item, { file: origin.file, pointer: `${origin.pointer}/${index}` }),
      ),
    };
  }
  if (typeof value === "object" && value !== null) {
    const entries = new Map<string, TreeNode>();
    for (const [key, child] of Object.entries(value)) {
      entries.set(
        key,
        buildTree(child, {
          file: origin.file,
          pointer: `${origin.pointer}/${escapePointer(key)}`,
        }),
      );
    }
    return { origin, kind: "object", entries };
  }
  return { origin, kind: "leaf", value };
}

function toJson(node: TreeNode): JsonValue {
  switch (node.kind) {
    case "leaf":
      return node.value;
    case "array":
      return node.items.map(toJson);
    case "object":
      return Object.fromEntries(
        [...node.entries].map(([key, child]) => [key, toJson(child)]),
      );
  }
}

function replaceMarkerTarget(node: TreeNode): TreeNode | undefined {
  if (node.kind === "object" && node.entries.size === 1) {
    return node.entries.get(REPLACE_KEY);
  }
  return undefined;
}

function merge(base: TreeNode | undefined, over: TreeNode, key: string): TreeNode {
  const replacement = replaceMarkerTarget(over);
  if (replacement !== undefined) return replacement;
  if (base === undefined) return over;
  if (base.kind === "object" && over.kind === "object") {
    const entries = new Map(base.entries);
    for (const [childKey, child] of over.entries) {
      entries.set(childKey, merge(base.entries.get(childKey), child, childKey));
    }
    return { origin: over.origin, kind: "object", entries };
  }
  if (base.kind === "array" && over.kind === "array" && CONCATENATED_KEYS.has(key)) {
    return { origin: over.origin, kind: "array", items: [...base.items, ...over.items] };
  }
  return over;
}

/** Removes every `$replace` wrapper that survived because it had no base to replace. */
function unwrapReplace(node: TreeNode): TreeNode {
  const replacement = replaceMarkerTarget(node);
  if (replacement !== undefined) return unwrapReplace(replacement);
  if (node.kind === "object") {
    return {
      origin: node.origin,
      kind: "object",
      entries: new Map([...node.entries].map(([key, child]) => [key, unwrapReplace(child)])),
    };
  }
  if (node.kind === "array") {
    return { origin: node.origin, kind: "array", items: node.items.map(unwrapReplace) };
  }
  return node;
}

class Loader {
  readonly files: string[] = [];
  readonly #reader: FileReader;

  constructor(reader: FileReader) {
    this.#reader = reader;
  }

  async load(
    file: string,
    supplied: Readonly<Record<string, Scalar>>,
    stack: readonly string[],
  ): Promise<TreeNode> {
    if (stack.includes(file)) {
      throw new PipelineLoadError([
        {
          message: `extends forms a cycle: ${[...stack, file].join(" -> ")}`,
          file: stack[stack.length - 1] ?? file,
          pointer: "/extends",
        },
      ]);
    }
    if (!this.files.includes(file)) this.files.push(file);

    let text: string;
    try {
      text = await this.#reader.read(file);
    } catch (error) {
      throw new PipelineLoadError([
        {
          message: `cannot read file: ${error instanceof Error ? error.message : String(error)}`,
          file: stack[stack.length - 1] ?? file,
          pointer: "/extends",
        },
      ]);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new PipelineLoadError([
        {
          message: `invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
          file,
          pointer: "",
        },
      ]);
    }
    const json = JsonValueSchema.parse(parsed);
    if (typeof json !== "object" || json === null || Array.isArray(json)) {
      throw new PipelineLoadError([
        { message: "a pipeline document must be a JSON object", file, pointer: "" },
      ]);
    }

    const header = documentHeaderSchema.safeParse(json);
    if (!header.success) {
      throw new PipelineLoadError(
        header.error.issues.map((issue) => ({
          message: issue.message,
          file,
          pointer: pointerOf(issue.path),
        })),
      );
    }

    const body = Object.fromEntries(
      Object.entries(json).filter(([key]) => key !== "extends" && key !== "parameters"),
    );
    const resolved = this.#resolveParameters(file, header.data.parameters ?? {}, supplied);

    let merged: TreeNode | undefined;
    const entries = Array.isArray(header.data.extends)
      ? header.data.extends
      : header.data.extends === undefined
        ? []
        : [header.data.extends];
    for (const entry of entries) {
      const path = typeof entry === "string" ? entry : entry.path;
      const parentWith = typeof entry === "string" ? {} : (entry.with ?? {});
      const parent = await this.load(resolveRelative(file, path), parentWith, [
        ...stack,
        file,
      ]);
      merged = merge(merged, parent, "");
    }

    const own = this.#substitute(buildTree(body, { file, pointer: "" }), resolved, file);
    return merge(merged, own, "");
  }

  #resolveParameters(
    file: string,
    declared: Readonly<Record<string, z.infer<typeof parameterDeclarationSchema>>>,
    supplied: Readonly<Record<string, Scalar>>,
  ): Record<string, Scalar> {
    const issues: LoadIssue[] = [];
    const values: Record<string, Scalar> = {};
    for (const name of Object.keys(supplied)) {
      if (!(name in declared)) {
        issues.push({
          message: `the extending file supplies "${name}", which this file does not declare`,
          file,
          pointer: "/parameters",
        });
      }
    }
    for (const [name, declaration] of Object.entries(declared)) {
      const value = supplied[name] ?? declaration.default;
      if (value === undefined) {
        issues.push({
          message: `parameter "${name}" has no value and no default`,
          file,
          pointer: `/parameters/${escapePointer(name)}`,
        });
      } else if (typeof value !== declaration.type) {
        issues.push({
          message: `parameter "${name}" must be a ${declaration.type}`,
          file,
          pointer: `/parameters/${escapePointer(name)}`,
        });
      } else {
        values[name] = value;
      }
    }
    if (issues.length > 0) throw new PipelineLoadError(issues);
    return values;
  }

  #substitute(
    node: TreeNode,
    values: Readonly<Record<string, Scalar>>,
    file: string,
  ): TreeNode {
    if (node.kind === "object") {
      const reference = node.entries.get(PARAM_KEY);
      if (reference !== undefined && node.entries.size === 1) {
        const name = reference.kind === "leaf" ? reference.value : undefined;
        const value = typeof name === "string" ? values[name] : undefined;
        if (value === undefined) {
          throw new PipelineLoadError([
            {
              message: `${PARAM_KEY} names a parameter this file does not declare`,
              file,
              pointer: reference.origin.pointer,
            },
          ]);
        }
        return { origin: node.origin, kind: "leaf", value };
      }
      return {
        origin: node.origin,
        kind: "object",
        entries: new Map(
          [...node.entries].map(([key, child]) => [key, this.#substitute(child, values, file)]),
        ),
      };
    }
    if (node.kind === "array") {
      return {
        origin: node.origin,
        kind: "array",
        items: node.items.map((item) => this.#substitute(item, values, file)),
      };
    }
    return node;
  }
}

function nodeAt(root: TreeNode, path: readonly PropertyKey[]): TreeNode {
  let current = root;
  for (const segment of path) {
    if (current.kind === "object") {
      const next = current.entries.get(String(segment));
      if (next === undefined) return current;
      current = next;
    } else if (current.kind === "array") {
      const next = current.items[Number(segment)];
      if (next === undefined) return current;
      current = next;
    } else {
      return current;
    }
  }
  return current;
}

/**
 * Reads a `*.pipeline.json` document and everything it `extends`, resolves parameters and composition, and validates the result against `pipelineSchema`.
 *
 * Composition: parents are merged in order and the file's own body is applied last. Objects deep-merge; `steps` arrays concatenate; every other array and every scalar is replaced by the overriding file. A `{"$replace": <value>}` wrapper replaces the inherited value outright. A `{"$param": "<name>"}` object is replaced by the parameter's value, supplied by the extending file's `with` or the declaration's default. Cycles, unreadable or unresolved files, unknown or mistyped parameters and schema violations all raise `PipelineLoadError`, each issue located at the node's source file and JSON pointer.
 */
export async function loadPipeline(
  entry: string,
  reader: FileReader,
): Promise<LoadedPipeline> {
  const loader = new Loader(reader);
  const merged = unwrapReplace(await loader.load(entry, {}, []));

  const result = pipelineSchema.safeParse(toJson(merged));
  if (!result.success) {
    throw new PipelineLoadError(
      result.error.issues.flatMap((issue) => {
        if (issue.code === "unrecognized_keys") {
          return issue.keys.map((key) => {
            const origin = nodeAt(merged, [...issue.path, key]).origin;
            return {
              message: `unrecognised key "${key}"`,
              file: origin.file,
              pointer: origin.pointer,
            };
          });
        }
        const origin = nodeAt(merged, issue.path).origin;
        return [{ message: issue.message, file: origin.file, pointer: origin.pointer }];
      }),
    );
  }
  return { pipeline: result.data, files: loader.files };
}
