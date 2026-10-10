import { parseArgs } from "node:util";

import { ZodError } from "zod";

import {
  deriveRequiredChecks,
  planRequiredChecks,
  type RequiredScope,
} from "@pipewright/check-names";
import {
  ImportedPipelineError,
  PipelineLoadError,
  UnsupportedNativeError,
  contextKeySchema,
  diffEmitted,
  jsonPointerOf,
  loadPipeline,
  pipelineSchema,
  type LoadedPipeline,
  pipelineAuthoringJsonSchema,
  pipelineJsonSchema,
  type CommandExecutor,
  type ContextKey,
  type FileReader,
  type MatrixCombination,
  type Pipeline,
  type PipelineCompiler,
  type PipelineImporter,
} from "@pipewright/pipeline-contract";
import {
  createBitbucketPipelinesCompiler,
  createBitbucketPipelinesImporter,
} from "@pipewright/pipeline-bitbucket";
import { createCircleCiCompiler, createCircleCiImporter } from "@pipewright/pipeline-circleci";
import {
  createGitHubActionsCompiler,
  createGitHubActionsImporter,
} from "@pipewright/pipeline-github-actions";
import { createGitLabCiCompiler, createGitLabCiImporter } from "@pipewright/pipeline-gitlab-ci";
import { createLocalRunner } from "@pipewright/pipeline-local";
import { createGitHubReader } from "@pipewright/platform-github";

import { resolveContext } from "./context.ts";

/**
 * Everything the CLI touches in the outside world, injected so each command is exercised under test with in-memory ports. The composition root in `bin.ts` supplies the real ones.
 */
export interface Io {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly reader: FileReader;
  readonly readOptional: (path: string) => Promise<string | undefined>;
  readonly writeFile: (path: string, content: string) => Promise<void>;
  readonly executor: CommandExecutor;
  /** Loads a TypeScript pipeline module and returns its exports. Injected because importing code is a runtime effect the CLI's tests must not perform. */
  readonly importModule: (path: string) => Promise<unknown>;
  readonly fetch: typeof fetch;
}

const COMPILERS: Readonly<Record<string, () => PipelineCompiler>> = {
  "bitbucket-pipelines": createBitbucketPipelinesCompiler,
  circleci: createCircleCiCompiler,
  "github-actions": createGitHubActionsCompiler,
  "gitlab-ci": createGitLabCiCompiler,
};

const IMPORTERS: Readonly<Record<string, () => PipelineImporter>> = {
  "bitbucket-pipelines": createBitbucketPipelinesImporter,
  circleci: createCircleCiImporter,
  "github-actions": createGitHubActionsImporter,
  "gitlab-ci": createGitLabCiImporter,
};

/** Where an exported document says its JSON Schema is, relative to the file it is written to. */
const DEFAULT_SCHEMA_REFERENCE =
  "https://unpkg.com/@pipewright/pipeline-contract/dist/pipeline.schema.json";

const USAGE = `pipewright <command> [options]

Commands
  emit         --pipeline <file> --provider <id> [--tool-command <cmd>]   write the provider's native files
  check        --pipeline <file> --provider <id> [--tool-command <cmd>]   fail when a written file has drifted
  run          --pipeline <file> [--job <id>]... [--steps <from>-<to>] [--matrix <axis>=<value>]... [--context <key>=<value>]...
               [--local] [--skip-provider-steps]
                                                                          execute the pipeline directly, no emitted files
  import       --provider <id> --file <native> [--output <file>]
               [--format ts|json] [--schema <reference>]                   read a provider's native file into a pipeline
  convert      --from <id> --file <native> --to <id> [--tool-command <cmd>]
                                                                          write another provider's files from a native file
  export       --pipeline <file> [--schema <reference>]                   print the resolved pipeline as a JSON document
  schema       [--authoring]                                              print the JSON Schema
  check-names  --pipeline <file> --provider <id> --scope gates|all
               [--repo <owner>/<repo> --branch <name>]                    derive required check names, and compare with the platform
  platform     runs|run|checks|logs|required --repo <owner>/<repo> [...]  read-only platform queries

Providers: ${Object.keys(COMPILERS).join(", ")}
`;

function compilerFor(name: string | undefined): PipelineCompiler {
  const make = name === undefined ? undefined : COMPILERS[name];
  if (make === undefined) {
    throw new Error(
      `unknown provider ${String(name)}; choose one of ${Object.keys(COMPILERS).join(", ")}`,
    );
  }

  return make();
}

function importerFor(name: string | undefined, flag: string): PipelineImporter {
  const make = name === undefined ? undefined : IMPORTERS[name];
  if (make === undefined) {
    throw new Error(
      `${flag} expects one of ${Object.keys(IMPORTERS).join(", ")}, got ${String(name)}`,
    );
  }

  return make();
}

/**
 * The TypeScript module an imported pipeline is written as: its default export is the model's own input, so it is edited and composed like any pipeline authored by hand.
 */
function moduleOf(pipeline: Pipeline): string {
  return `import { definePipeline } from "@pipewright/pipeline-contract";\n\nexport default definePipeline(${JSON.stringify(pipeline, null, 2)});\n`;
}

/**
 * Reads a native file through the provider's importer. A construct the model cannot express is reported with the file and the JSON pointer of the node in it, as a load error is. A value that read but is not a valid model is reported against the imported pipeline, whose job ids are not always keys in the file.
 */
async function importNative(
  io: Io,
  provider: string,
  flag: string,
  path: string,
): Promise<Pipeline> {
  const importer = importerFor(provider, flag);
  const content = await io.reader.read(path);
  try {
    return await importer.import({ path, content });
  } catch (error) {
    if (error instanceof UnsupportedNativeError) {
      throw new PipelineLoadError([
        { file: path, pointer: error.pointer, message: `${error.provider} ${error.construct}` },
      ]);
    }
    if (error instanceof ImportedPipelineError) {
      throw new Error(
        `${path} does not map to a valid pipeline: ${error.issues
          .map((issue) => `${issue.pointer} in the imported pipeline ${issue.message}`)
          .join("; ")}`,
        { cause: error },
      );
    }
    throw error;
  }
}

/**
 * The settings, by job and key, that a pipeline carries for `provider` and that another provider's compiler ignores. Converting such a pipeline would drop them without a word, so it is refused instead.
 */
function providerOwnedSettings(pipeline: Pipeline, provider: string): string[] {
  return Object.entries(pipeline.jobs).flatMap(([id, job]) =>
    Object.entries(job.native ?? {}).flatMap(([owner, settings]) =>
      owner === provider ? [`job ${JSON.stringify(id)}: ${Object.keys(settings).join(", ")}`] : [],
    ),
  );
}

function required(value: string | undefined, flag: string): string {
  if (value === undefined) throw new Error(`${flag} is required`);

  return value;
}

function keyValues(entries: readonly string[] | undefined, flag: string): [string, string][] {
  return (entries ?? []).map((entry) => {
    const separator = entry.indexOf("=");
    if (separator <= 0) throw new Error(`${flag} expects <name>=<value>, got "${entry}"`);

    return [entry.slice(0, separator), entry.slice(separator + 1)];
  });
}

function contextOverrides(
  entries: readonly string[] | undefined,
): Partial<Record<ContextKey, string>> {
  const overrides: Partial<Record<ContextKey, string>> = {};
  for (const [key, value] of keyValues(entries, "--context")) {
    overrides[contextKeySchema.parse(key)] = value;
  }

  return overrides;
}

/**
 * The context of a developer running the pipeline on their own machine: a manual run on a branch called `local`. Explicit `--context` values still win, so a condition can be exercised against any other value.
 */
function localContext(workflow: string): Partial<Record<ContextKey, string>> {
  return {
    event: "manual",
    refName: "local",
    baseRefName: "",
    sha: "local",
    repository: "local",
    workflow,
    runId: "0",
  };
}

function parseRange(text: string): { from: number; to: number } {
  const match = /^(\d+)-(\d+)$/.exec(text);
  if (match?.[1] === undefined || match[2] === undefined) {
    throw new Error(`--steps expects <from>-<to>, got "${text}"`);
  }

  return { from: Number(match[1]), to: Number(match[2]) };
}

function repository(text: string | undefined): { owner: string; repo: string } {
  const [owner, repo, extra] = required(text, "--repo").split("/");
  if (
    owner === undefined ||
    repo === undefined ||
    extra !== undefined ||
    owner === "" ||
    repo === ""
  ) {
    throw new Error("--repo expects <owner>/<repo>");
  }

  return { owner, repo };
}

function token(io: Io): () => Promise<string> {
  const name = io.env.CI_ADAPTERS_TOKEN_VARIABLE ?? "GH_TOKEN";

  return async () => {
    const value = io.env[name];
    if (value === undefined || value === "") {
      return Promise.reject(new Error(`${name} is not set`));
    }

    return Promise.resolve(value);
  };
}

function loadErrorFrom(path: string, error: ZodError): PipelineLoadError {
  return new PipelineLoadError(
    error.issues.map((issue) => ({
      message: issue.message,
      file: path,
      pointer: jsonPointerOf(issue.path),
    })),
  );
}

function isTypeScript(path: string): boolean {
  return path.endsWith(".ts") || path.endsWith(".mts");
}

/**
 * Loads a pipeline from either authoring format. A `.json` document goes through the composing loader; a `.ts` module's default export is validated against the same schema, with each violation located by file and JSON pointer into the resolved pipeline.
 */
async function load(io: Io, path: string): Promise<LoadedPipeline> {
  if (!isTypeScript(path)) return loadPipeline(path, io.reader);

  let exports: unknown;
  try {
    exports = await io.importModule(path);
  } catch (error) {
    // definePipeline validates while the module is evaluated, so a violation surfaces here rather than at the parse below.
    if (error instanceof ZodError) throw loadErrorFrom(path, error);
    throw error;
  }
  const candidate =
    typeof exports === "object" && exports !== null && "default" in exports
      ? exports.default
      : undefined;
  const result = pipelineSchema.safeParse(candidate);
  if (!result.success) throw loadErrorFrom(path, result.error);

  return { pipeline: result.data, files: [path] };
}

/**
 * Runs one CLI invocation and returns its exit code. Output goes only through `io`, so nothing here prints or exits on its own.
 */
export async function main(argv: readonly string[], io: Io): Promise<number> {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case "emit":
      case "check": {
        const { values } = parseArgs({
          args: [...rest],
          options: {
            pipeline: { type: "string" },
            provider: { type: "string" },
            "tool-command": { type: "string" },
          },
        });
        const source = required(values.pipeline, "--pipeline");
        const { pipeline } = await load(io, source);
        const files = await compilerFor(values.provider).compile(pipeline, {
          source,
          ...(values["tool-command"] === undefined ? {} : { toolCommand: values["tool-command"] }),
        });
        if (command === "emit") {
          await Promise.all(files.map(async (file) => io.writeFile(file.path, file.content)));
          for (const file of files) io.stdout(`wrote ${file.path}\n`);

          return 0;
        }
        const drift = await diffEmitted(files, io.readOptional);
        for (const entry of drift) io.stderr(`${entry.kind}: ${entry.path}\n`);
        if (drift.length === 0) io.stdout("no drift\n");

        return drift.length === 0 ? 0 : 1;
      }

      case "run": {
        const { values } = parseArgs({
          args: [...rest],
          options: {
            pipeline: { type: "string" },
            job: { type: "string", multiple: true },
            steps: { type: "string" },
            matrix: { type: "string", multiple: true },
            context: { type: "string", multiple: true },
            local: { type: "boolean" },
            "skip-provider-steps": { type: "boolean" },
          },
        });
        const { pipeline } = await load(io, required(values.pipeline, "--pipeline"));
        const matrix: MatrixCombination = Object.fromEntries(keyValues(values.matrix, "--matrix"));
        const report = await createLocalRunner().run(pipeline, {
          executor: io.executor,
          context: resolveContext(io.env, {
            ...(values.local === true ? localContext(pipeline.name) : {}),
            ...contextOverrides(values.context),
          }),
          ...(values.job === undefined ? {} : { only: values.job }),
          ...(values["skip-provider-steps"] === true ? { skipProviderSteps: true } : {}),
          ...(values.steps === undefined ? {} : { steps: parseRange(values.steps) }),
          ...(Object.keys(matrix).length === 0 ? {} : { matrix }),
        });
        for (const job of report.jobs) {
          const label =
            Object.keys(job.matrix).length === 0 ? "" : ` ${JSON.stringify(job.matrix)}`;
          io.stdout(`${job.outcome}: ${job.name}${label}\n`);
        }

        return report.ok ? 0 : 1;
      }

      case "import": {
        const { values } = parseArgs({
          args: [...rest],
          options: {
            provider: { type: "string" },
            file: { type: "string" },
            output: { type: "string" },
            format: { type: "string" },
            schema: { type: "string" },
          },
        });
        const format = values.format ?? "ts";
        if (format !== "ts" && format !== "json") throw new Error("--format expects ts or json");
        const pipeline = await importNative(
          io,
          required(values.provider, "--provider"),
          "--provider",
          required(values.file, "--file"),
        );
        const text =
          format === "json"
            ? `${JSON.stringify({ ...pipeline, $schema: values.schema ?? DEFAULT_SCHEMA_REFERENCE }, null, 2)}\n`
            : moduleOf(pipeline);
        if (values.output === undefined) {
          io.stdout(text);
        } else {
          await io.writeFile(values.output, text);
          io.stdout(`wrote ${values.output}\n`);
        }

        return 0;
      }

      case "convert": {
        const { values } = parseArgs({
          args: [...rest],
          options: {
            from: { type: "string" },
            file: { type: "string" },
            to: { type: "string" },
            "tool-command": { type: "string" },
          },
        });
        const from = required(values.from, "--from");
        const source = required(values.file, "--file");
        const compiler = compilerFor(required(values.to, "--to"));
        const pipeline = await importNative(io, from, "--from", source);
        const owned = from === compiler.provider ? [] : providerOwnedSettings(pipeline, from);
        if (owned.length > 0) {
          throw new Error(
            `${source} carries ${from} settings that ${compiler.provider} would drop, so it is not converted: ${owned.join("; ")}`,
          );
        }
        const files = await compiler.compile(pipeline, {
          source,
          ...(values["tool-command"] === undefined ? {} : { toolCommand: values["tool-command"] }),
        });
        await Promise.all(files.map(async (file) => io.writeFile(file.path, file.content)));
        for (const file of files) io.stdout(`wrote ${file.path}\n`);

        return 0;
      }

      case "export": {
        const { values } = parseArgs({
          args: [...rest],
          options: { pipeline: { type: "string" }, schema: { type: "string" } },
        });
        const { pipeline } = await load(io, required(values.pipeline, "--pipeline"));
        const document = { ...pipeline, $schema: values.schema ?? DEFAULT_SCHEMA_REFERENCE };
        io.stdout(`${JSON.stringify(document, null, 2)}\n`);

        return 0;
      }

      case "schema": {
        const { values } = parseArgs({
          args: [...rest],
          options: { authoring: { type: "boolean" } },
        });
        const schema =
          values.authoring === true ? pipelineAuthoringJsonSchema() : pipelineJsonSchema();
        io.stdout(`${JSON.stringify(schema, null, 2)}\n`);

        return 0;
      }

      case "check-names": {
        const { values } = parseArgs({
          args: [...rest],
          options: {
            pipeline: { type: "string" },
            provider: { type: "string" },
            scope: { type: "string" },
            repo: { type: "string" },
            branch: { type: "string" },
          },
        });
        const scope = required(values.scope, "--scope");
        if (scope !== "gates" && scope !== "all") throw new Error("--scope expects gates or all");
        const { pipeline } = await load(io, required(values.pipeline, "--pipeline"));
        const derived = deriveRequiredChecks(
          pipeline,
          compilerFor(values.provider),
          scope satisfies RequiredScope,
        );
        if (values.repo === undefined) {
          for (const name of derived) io.stdout(`${name}\n`);

          return 0;
        }
        const reader = createGitHubReader({
          ...repository(values.repo),
          fetch: io.fetch,
          token: token(io),
        });
        const current = await reader.requiredChecks(required(values.branch, "--branch"));
        const plan = planRequiredChecks(derived, current);
        for (const name of plan.add) io.stdout(`add: ${name}\n`);
        for (const name of plan.remove) io.stdout(`remove: ${name}\n`);
        for (const name of plan.unchanged) io.stdout(`unchanged: ${name}\n`);
        io.stdout(
          "This is a plan. Applying it changes a ruleset and is done by a person after reading the ruleset in full.\n",
        );

        return plan.add.length === 0 && plan.remove.length === 0 ? 0 : 1;
      }

      case "platform": {
        const [operation, ...flags] = rest;
        const { values } = parseArgs({
          args: flags,
          options: {
            repo: { type: "string" },
            ref: { type: "string" },
            sha: { type: "string" },
            run: { type: "string" },
            branch: { type: "string" },
            limit: { type: "string" },
          },
        });
        const reader = createGitHubReader({
          ...repository(values.repo),
          fetch: io.fetch,
          token: token(io),
        });
        switch (operation) {
          case "runs": {
            const runs = await reader.listRuns({
              ...(values.ref === undefined ? {} : { ref: values.ref }),
              ...(values.sha === undefined ? {} : { sha: values.sha }),
              ...(values.limit === undefined ? {} : { limit: Number(values.limit) }),
            });
            for (const run of runs) {
              const result =
                run.status === "completed" ? `${run.status}/${run.conclusion}` : run.status;
              io.stdout(`${run.id}\t${result}\t${run.ref}\t${run.name}\n`);
            }

            return 0;
          }
          case "run": {
            const run = await reader.getRun(required(values.run, "--run"));
            const result =
              run.status === "completed" ? `${run.status}/${run.conclusion}` : run.status;
            io.stdout(`${run.id}\t${result}\t${run.ref}\t${run.name}\n`);

            return 0;
          }
          case "checks": {
            const checks = await reader.listChecks(required(values.sha, "--sha"));
            for (const check of checks) {
              const result =
                check.status === "completed" ? `${check.status}/${check.conclusion}` : check.status;
              io.stdout(`${result}\t${check.name}\n`);
            }

            return 0;
          }
          case "logs":
            io.stdout(`${await reader.getLogs(required(values.run, "--run"))}\n`);

            return 0;
          case "required":
            for (const name of await reader.requiredChecks(required(values.branch, "--branch"))) {
              io.stdout(`${name}\n`);
            }

            return 0;
          case undefined:
          default:
            throw new Error(`unknown platform operation ${String(operation)}`);
        }
      }

      case undefined:
      case "help":
      case "--help":
        io.stdout(USAGE);

        return command === undefined ? 2 : 0;

      default:
        io.stderr(`unknown command ${command}\n\n${USAGE}`);

        return 2;
    }
  } catch (error) {
    if (error instanceof PipelineLoadError) {
      for (const issue of error.issues) {
        io.stderr(`${issue.file}#${issue.pointer}: ${issue.message}\n`);
      }
    } else {
      io.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    }

    return 1;
  }
}
