import {
  CompositionError,
  composeJson,
  type ComposedJson,
  type FileReader,
  type JsonObject,
  type LoadIssue,
} from "@exadev/json-compose";

import { pipelineSchema, type Pipeline } from "./schema.ts";

/**
 * Raised for every defect in a pipeline document: unreadable or malformed JSON, an unresolved or cyclic `extends`, a bad parameter, or a schema violation. Each issue names the source file and JSON pointer of the node as authored, including across `extends` boundaries.
 */
export class PipelineLoadError extends Error {
  readonly issues: readonly LoadIssue[];

  constructor(issues: readonly LoadIssue[]) {
    super(issues.map((issue) => `${issue.file}#${issue.pointer}: ${issue.message}`).join("\n"));
    this.name = "PipelineLoadError";
    this.issues = issues;
  }
}

export interface LoadedPipeline {
  readonly pipeline: Pipeline;
  /** Every file read, entry first, in the order they were first reached. */
  readonly files: readonly string[];
}

/** Arrays under these keys concatenate across `extends`; every other array is replaced by the overriding file's. */
const CONCATENATED_KEYS: readonly string[] = ["steps"];

function escapePointer(segment: string): string {
  return segment.replaceAll("~", "~0").replaceAll("/", "~1");
}

/**
 * Builds an RFC 6901 JSON pointer from path segments, escaping `~` and `/` inside each.
 */
export function jsonPointerOf(path: readonly PropertyKey[]): string {
  return path.map((segment) => `/${escapePointer(String(segment))}`).join("");
}

function requireSchemaMember(json: JsonObject, file: string): readonly LoadIssue[] {
  if (typeof json.$schema === "string") return [];

  return [
    {
      message:
        "a pipeline document must declare $schema, which is what gives an editor completion and validation",
      file,
      pointer: "/$schema",
    },
  ];
}

async function compose(entry: string, reader: Readonly<FileReader>): Promise<ComposedJson> {
  try {
    return await composeJson(entry, reader, {
      concatenate: CONCATENATED_KEYS,
      onDocument: requireSchemaMember,
    });
  } catch (error) {
    if (error instanceof CompositionError) throw new PipelineLoadError(error.issues);
    throw error;
  }
}

/**
 * Reads a `*.pipeline.json` document and everything it `extends`, resolves parameters and composition, and validates the result against `pipelineSchema`.
 *
 * Composition is `@exadev/json-compose`: parents are merged in order and the file's own body is applied last; objects deep-merge, `steps` arrays concatenate, and every other array and scalar is replaced. Cycles, unreadable or unresolved files, a missing `$schema`, unknown or mistyped parameters and schema violations all raise `PipelineLoadError`, each issue located at the node's source file and JSON pointer.
 */
export async function loadPipeline(
  entry: string,
  reader: Readonly<FileReader>,
): Promise<LoadedPipeline> {
  const composed = await compose(entry, reader);

  const result = pipelineSchema.safeParse(composed.value);
  if (!result.success) {
    throw new PipelineLoadError(
      result.error.issues.flatMap((issue) => {
        if (issue.code === "unrecognized_keys") {
          return issue.keys.map((key) => ({
            message: `unrecognised key "${key}"`,
            ...composed.originOf(jsonPointerOf([...issue.path, key])),
          }));
        }

        return [{ message: issue.message, ...composed.originOf(jsonPointerOf(issue.path)) }];
      }),
    );
  }

  return { pipeline: result.data, files: composed.files };
}
