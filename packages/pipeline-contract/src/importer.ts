import type { EmittedFile } from "./compiler.ts";
import { ImportedPipelineError } from "./errors.ts";
import { jsonPointerOf } from "./load.ts";
import { pipelineSchema, type Pipeline, type ProviderId } from "./schema.ts";

export interface ImportOptions {
  readonly signal?: AbortSignal;
}

/**
 * Reads a provider's native configuration file into the neutral pipeline model. It is the inverse of that provider's `PipelineCompiler` and takes the same stance: what the model cannot express is rejected, never approximated or dropped.
 *
 * Pre: `file.content` is the text of one native file; `file.path` is its repository-relative path, which supplies a name only where the provider lets a file omit one. Post: the result has passed `pipelineSchema`, and compiling it with the same provider's compiler emits what the compiler would have written for the original pipeline. Errors: throws `UnsupportedNativeError` naming the construct and its JSON pointer in the native document, and `ImportedPipelineError` when what was read is not a valid model. Anything the provider owns and the model carries verbatim (a job's `native` mapping, a `provider` step) is carried, not rejected.
 */
export interface PipelineImporter {
  readonly provider: ProviderId;
  import: (file: EmittedFile, options?: ImportOptions) => Promise<Pipeline>;
}

/**
 * Validates what an importer built against the model. A value that fails is reported with its location in the imported pipeline rather than as a bare schema error, so an importer can hand it straight to the caller.
 */
export function validateImported(provider: ProviderId, candidate: unknown): Pipeline {
  const result = pipelineSchema.safeParse(candidate);
  if (result.success) return result.data;

  throw new ImportedPipelineError(
    provider,
    result.error.issues.map((issue) => ({
      pointer: jsonPointerOf(issue.path),
      message: issue.message,
    })),
  );
}
