import { parseArgs } from "node:util";

import {
  deriveRequiredChecks,
  planRequiredChecks,
  type RequiredScope,
} from "@ci-adapters/check-names";
import {
  PipelineLoadError,
  contextKeySchema,
  diffEmitted,
  loadPipeline,
  pipelineAuthoringJsonSchema,
  pipelineJsonSchema,
  type CommandExecutor,
  type ContextKey,
  type FileReader,
  type MatrixCombination,
  type PipelineCompiler,
} from "@ci-adapters/pipeline-contract";
import { createGitHubActionsCompiler } from "@ci-adapters/pipeline-github-actions";
import { createGitLabCiCompiler } from "@ci-adapters/pipeline-gitlab-ci";
import { createLocalRunner } from "@ci-adapters/pipeline-local";
import { createGitHubReader } from "@ci-adapters/platform-github";

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
  readonly fetch: typeof fetch;
}

const COMPILERS: Readonly<Record<string, () => PipelineCompiler>> = {
  "github-actions": createGitHubActionsCompiler,
  "gitlab-ci": createGitLabCiCompiler,
};

const USAGE = `ci-adapters <command> [options]

Commands
  emit         --pipeline <file> --provider <id> [--tool-command <cmd>]   write the provider's native files
  check        --pipeline <file> --provider <id> [--tool-command <cmd>]   fail when a written file has drifted
  run          --pipeline <file> [--job <id>]... [--steps <from>-<to>] [--matrix <axis>=<value>]... [--context <key>=<value>]...
               [--local] [--skip-provider-steps]
                                                                          execute the pipeline directly, no emitted files
  schema       [--authoring]                                              print the JSON Schema
  check-names  --pipeline <file> --provider <id> --scope gates|all
               [--repo <owner>/<repo> --branch <name>]                    derive required check names, and compare with the platform
  platform     runs|checks|logs|required --repo <owner>/<repo> [...]      read-only platform queries

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

async function load(io: Io, path: string): ReturnType<typeof loadPipeline> {
  return loadPipeline(path, io.reader);
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
