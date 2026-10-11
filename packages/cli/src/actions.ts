import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";

import type {
  ContextKey,
  JobExpansion,
  JobView,
  PreparedStep,
  RunContext,
  Step,
  StepHost,
  StepResolution,
  StepView,
} from "@pipewright/pipeline-contract";
import {
  ActionReferenceError,
  EVENT_NAME,
  PROVIDER,
  evaluateCondition,
  evaluateTemplate,
  evaluationContextSchema,
  expandAction,
  parseActionReference,
  type ActionResolver,
  type ActionTree,
  type EvaluationContext,
  type NodeRunner,
} from "@pipewright/pipeline-github-actions";

/** The shells the host's own executor runs as written; a workflow step naming another interpreter names a command this host cannot run faithfully. */
const POSIX_SHELLS = new Set(["bash", "sh"]);

/** The GitHub event name of each neutral event; a name outside the table passes through as written. */
const EVENT_NAMES: ReadonlyMap<string, string> = new Map(Object.entries(EVENT_NAME));

/**
 * The `github` context field each neutral context key maps onto. It mirrors the adapter's own expression table (`CONTEXT_EXPRESSION`), which the compiler writes and the importer reads, and a test holds the two to the same correspondence.
 */
export const GITHUB_FIELD: Readonly<Record<ContextKey, string>> = {
  event: "event_name",
  refName: "ref_name",
  baseRefName: "base_ref",
  sha: "sha",
  repository: "repository",
  workflow: "workflow",
  runId: "run_id",
};

/** A provider step of GitHub's, whatever its native mapping carries. */
type GitHubStep = Extract<Step, { kind: "provider" }> & { readonly provider: "github-actions" };

function isGitHubStep(step: Step): step is GitHubStep {
  return step.kind === "provider" && step.provider === PROVIDER;
}

/** The `uses` value a provider step carries, or undefined when it carries none or one that is not text. */
function usesOf(step: Step): string | undefined {
  return isGitHubStep(step) ? textOf(step.native, "uses") : undefined;
}

/** A string a provider's native mapping carried, or undefined when the key is absent or holds anything else. */
function textOf(native: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = native[key];

  return typeof value === "string" ? value : undefined;
}

/** Whether a value is a scalar a provider's expressions substitute, which every value an imported mapping carries is. */
function isScalar(value: unknown): value is string | number | boolean {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function scalarText(value: string | number | boolean): string {
  return typeof value === "string" ? value : String(value);
}

/** Resolves a local reference's path inside a root, rejecting one that climbs above it, because an action cannot name files outside the repository or workspace its own reference was resolved from. */
function within(root: string, path: string): string {
  const resolved: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (resolved.pop() === undefined) {
        throw new Error(`the local reference ./${path}, which climbs above the workspace`);
      }
      continue;
    }
    resolved.push(segment);
  }

  return resolve(root, resolved.join("/"));
}

/** A tree over a directory the host already holds: the workspace for a local reference, an extracted tarball for a remote one. */
function directoryTree(directory: string): ActionTree {
  const read = async (relative: string): Promise<string | undefined> => {
    try {
      return await readFile(join(directory, relative), "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
      throw error;
    }
  };

  return {
    path: directory,
    read,
    local: async (relative) => Promise.resolve(directoryTree(within(directory, relative))),
  };
}

/** The tar header's field offsets, in bytes, as the format fixes them. */
const NAME_END = 100;
const SIZE_AT = 124;
const SIZE_END = 136;
const TYPE_AT = 156;
const PREFIX_AT = 345;
const PREFIX_END = 500;
/** Every block of a tar stream, header and data alike, is this size. */
const BLOCK = 512;
/** The space that separates a pax record's length from its key. */
const SPACE = 0x20;

/** Reads a NUL- or space-padded string field of a tar header. */
function fieldOf(header: Uint8Array, from: number, to: number): string {
  const end = header.subarray(from, to).indexOf(0);
  const field = header.subarray(from, end === -1 ? to : from + end);

  return new TextDecoder().decode(field);
}

/** Reads a size field as the octal ASCII the format defines, rejecting the GNU base-256 form rather than misreading it. */
function sizeOf(header: Uint8Array): number {
  const text = fieldOf(header, SIZE_AT, SIZE_END).trim();
  if (!/^[0-7]*$/.test(text)) {
    throw new Error("a tar entry whose size is not octal text, which this reader does not carry");
  }

  return text === "" ? 0 : Number.parseInt(text, 8);
}

/** One entry of a tar stream: a file's bytes, or null for a directory. */
interface TarEntry {
  readonly name: string;
  readonly bytes: Uint8Array | null;
}

/**
 * Reads the entries of a tar stream, the container GitHub serves a repository tarball in. A repository tarball starts with a pax global header naming its commit and carries a path too long for the header's name field in a pax extended header, so both are read: the global header's records are ignored unless they rewrite a path, and an extended header's `path` names the entry that follows it. A size a header's octal field cannot carry never appears in a repository tarball, so a pax `size` record is read only to be rejected.
 */
function readTar(tar: Uint8Array): TarEntry[] {
  const entries: TarEntry[] = [];
  let offset = 0;
  let longName: string | undefined;
  while (offset + BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK);
    if (header.every((byte) => byte === 0)) break;
    const size = sizeOf(header);
    const data = tar.subarray(offset + BLOCK, offset + BLOCK + size);
    offset += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
    const prefix = fieldOf(header, PREFIX_AT, PREFIX_END);
    const name =
      longName ?? [...(prefix === "" ? [] : [prefix]), fieldOf(header, 0, NAME_END)].join("/");
    const type = String.fromCharCode(header[TYPE_AT] ?? 0);
    if (type === "x" || type === "g") {
      const records = paxRecords(data);
      if (records.has("size")) {
        throw new Error("a pax header that rewrites a size, which this reader does not carry");
      }
      const path = records.get("path");
      if (type === "g") {
        if (path !== undefined) {
          throw new Error(
            "a pax global header that rewrites a path, which this reader does not carry",
          );
        }
        continue;
      }
      if (path !== undefined) longName = path;
      continue;
    }
    if (type === "L") {
      longName = new TextDecoder().decode(data).replace(/\0+$/, "");
      continue;
    }

    longName = undefined;
    if (type === "5" || name.endsWith("/")) {
      entries.push({ name: name, bytes: null });
      continue;
    }

    entries.push({ name: name, bytes: data });
  }

  return entries;
}

/** Reads the key-value records of a pax header, each a length-prefixed `key=value` line. */
function paxRecords(data: Uint8Array): Map<string, string> {
  const records = new Map<string, string>();
  let offset = 0;
  while (offset < data.length) {
    const space = data.subarray(offset).indexOf(SPACE);
    if (space === -1) throw new Error("a pax header record with no key");
    const length = Number.parseInt(
      new TextDecoder().decode(data.subarray(offset, offset + space)),
      10,
    );
    if (!Number.isInteger(length) || length <= 0) {
      throw new Error("a pax header record whose length is not decimal text");
    }
    const record = new TextDecoder().decode(data.subarray(offset, offset + length));
    const equals = record.indexOf("=");
    const newline = record.lastIndexOf("\n");
    if (equals === -1 || newline === -1) {
      throw new Error("a pax header record that is not key=value");
    }
    records.set(record.slice(space + 1, equals), record.slice(equals + 1, newline));
    offset += length;
  }

  return records;
}

/** Writes a tarball's entries under a directory, stripping the repository root every entry name starts with. */
async function extractTarball(root: string, tarball: Uint8Array): Promise<void> {
  await readTar(gunzipSync(tarball)).reduce<Promise<void>>(async (previous, entry) => {
    await previous;
    // Every entry of a repository tarball starts with the repository's own root directory, whose name the action never sees.
    const segments = entry.name.split("/").slice(1);
    const climbs = segments.some(
      (segment) => segment === "" || segment === "." || segment === "..",
    );
    if (segments.length === 0 || climbs) {
      throw new Error(`a tarball entry outside its repository root: ${entry.name}`);
    }
    const target = join(root, ...segments);
    if (entry.bytes === null) {
      await mkdir(target, { recursive: true });

      return;
    }
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, entry.bytes);
  }, Promise.resolve());
}

/** The tarball endpoint a remote reference is fetched from, which answers a redirect to the download itself. */
const TARBALL = "https://api.github.com/repos";

/** What the host needs from the outside world to resolve and run actions. */
export interface HostOptions {
  /** The workspace a local `./` reference resolves against. */
  readonly cwd: string;
  readonly fetch: typeof fetch;
  /** The run's context, whose values the `github` context maps onto GitHub's own names. */
  readonly context: RunContext;
  /** The platform token, sent with action fetches and supplied to expressions as `secrets.GITHUB_TOKEN` and `github.token`; absent, both read as absent and only public repositories can be fetched. */
  readonly token: string | undefined;
  /** Secrets supplied for the run, by name. Held for the run's lifetime, passed only to the evaluator, and never written anywhere. */
  readonly secrets: Readonly<Record<string, string>>;
  /** Whether a provider step this host cannot run is reported skipped rather than failing the run. */
  readonly skipProviderSteps: boolean;
}

/**
 * Fetches a repository tarball, following the one redirect GitHub answers with and re-attaching the token, which a cross-origin redirect would otherwise drop and a private repository needs on the second hop.
 * @see https://docs.github.com/en/rest/repos/contents
 * @see https://web.archive.org/web/20261008201445/https://docs.github.com/en/rest/repos/contents
 */
async function fetchTarball(
  options: HostOptions,
  owner: string,
  repo: string,
  ref: string | undefined,
): Promise<Uint8Array> {
  const url = `${TARBALL}/${owner}/${repo}/tarball${ref === undefined ? "" : `/${encodeURIComponent(ref)}`}`;
  const headers: Record<string, string> = { Accept: "application/vnd.github+json" };
  if (options.token !== undefined) headers.Authorization = `Bearer ${options.token}`;
  let response = await options.fetch(url, { headers, redirect: "manual" });
  const location = response.headers.get("location");
  // GitHub answers a redirect to the download itself, one hop, and the token goes along: a cross-origin redirect would otherwise drop it and a private repository needs it there.
  if (location !== null && !response.ok && new URL(location, url).hostname.endsWith("github.com")) {
    response = await options.fetch(location, { headers, redirect: "manual" });
  }
  if (!response.ok) {
    throw new Error(
      `fetching ${owner}/${repo}${ref === undefined ? "" : `@${ref}`} answered ${String(response.status)}`,
    );
  }

  return new Uint8Array(await response.arrayBuffer());
}

/** The GitHub Actions host for a `run`: the resolver and node port the library's action expansion asks for, and the step host the runner calls. */
export interface ActionHost {
  readonly resolver: ActionResolver;
  readonly node: NodeRunner;
  readonly steps: StepHost;
  /** Removes what the run fetched; called when the run ends, so nothing a run downloaded outlives it. */
  readonly dispose: () => Promise<void>;
}

/** The `github` context under GitHub's own names: each neutral context key mapped onto its field, plus the token wherever the run holds one. A key the run did not supply is absent, so an expression reading it reads null, as GitHub's own absent fields do. */
function githubContext(context: RunContext, token: string | undefined): Record<string, string> {
  const github: Record<string, string> = {};
  if (context.event !== undefined) {
    // An event name this model does not know passes through as written, the same pass-through the importer's own event table applies.
    github.event_name = EVENT_NAMES.get(context.event) ?? context.event;
  }
  if (context.refName !== undefined) github.ref_name = context.refName;
  if (context.baseRefName !== undefined) github.base_ref = context.baseRefName;
  if (context.sha !== undefined) github.sha = context.sha;
  if (context.repository !== undefined) github.repository = context.repository;
  if (context.workflow !== undefined) github.workflow = context.workflow;
  if (context.runId !== undefined) github.run_id = context.runId;
  if (token !== undefined) github.token = token;

  return github;
}

/** The evaluation context for a view of the run: the neutral context mapped onto GitHub's names, the environment the next command inherits, and the steps and needed jobs as GitHub reports them. */
function evaluationContextOf(
  view: JobView | StepView,
  github: Readonly<Record<string, string>>,
  secrets: Readonly<Record<string, string>>,
): EvaluationContext {
  const steps: Record<string, { conclusion: string; outputs: Record<string, string> }> = {};
  const records = "steps" in view ? view.steps : [];
  for (const record of records) {
    // Only a step the workflow gave an id can be read by one, and an imported step with an id stays a provider step that carries it.
    const id = record.step.kind === "provider" ? textOf(record.step.native, "id") : undefined;
    if (id === undefined || id in steps) continue;
    steps[id] = { conclusion: record.outcome, outputs: { ...record.outputs } };
  }
  const failed = records.some((record) => record.outcome === "failure");

  return evaluationContextSchema.parse({
    github,
    env: { ...view.env },
    job: { status: failed ? "failure" : "success" },
    steps,
    needs: Object.fromEntries(
      Object.entries(view.needs).map(([id, result]) => [id, { result, outputs: {} }]),
    ),
    matrix: { ...view.matrix },
    // The token GitHub supplies to every run, wherever the host holds one, so the expressions a workflow writes against it work unchanged.
    secrets: { ...secrets, ...(github.token === undefined ? {} : { GITHUB_TOKEN: github.token }) },
    inputs: {},
  });
}

/** The environment a step's own mapping declares, evaluated against the view the step is reached with. */
function stepEnvironment(
  mapping: unknown,
  context: EvaluationContext,
  fail: (construct: string) => never,
): Record<string, string> {
  if (mapping === undefined) return {};
  if (typeof mapping !== "object" || mapping === null || Array.isArray(mapping)) {
    return fail("a step environment that is not a mapping");
  }
  const evaluated: Record<string, string> = {};
  for (const [key, value] of Object.entries(mapping)) {
    if (!isScalar(value)) {
      return fail(`the step environment "${key}" with a value that is not a scalar`);
    }
    evaluated[key] = evaluateTemplate(scalarText(value), context);
  }

  return evaluated;
}

/** Why a `uses` value names no tree this host can read, or undefined when it parses. */
function unparsable(uses: string): string | undefined {
  try {
    parseActionReference(uses);

    return undefined;
  } catch (error) {
    if (error instanceof ActionReferenceError) return error.construct;
    throw error;
  }
}

/** The name a resolved step reports under: the step's own name, else its command text, as the runner does for a neutral run step. */
function stepNameOf(step: Step, command: string): string {
  return step.name ?? command;
}

/**
 * Builds the host that runs a pipeline's GitHub Actions parts on the machine `run` executes on. Local `./` references resolve against the workspace; a remote `owner/repo@ref` is fetched as a tarball, extracted once per reference for the run's lifetime, and served as a tree. A node action's entry runs under the same node the CLI itself runs under.
 *
 * The step host the runner calls works in two moments. Before a job runs it expands every action the job's `uses` steps name, with the pre-run view, and places the pre and post phases the expansion returned around the job's own steps, which is the placement the library documents from the runner's own phases; the expanded steps themselves are discarded, because the same action expands again when the step is reached, against what the job's earlier steps by then produced, which is the view GitHub evaluates a `with:` mapping and a step condition with. A provider step that carries a `run` instead resolves through the evaluator directly: its condition decides whether it runs, and its command text, environment and working directory are evaluated as written.
 *
 * What this host cannot run it leaves to the runner's own stance: a `docker://` reference and a step of another provider are reported skipped when the run was told to skip provider steps and fail the run otherwise, and a workflow step naming a shell or a setting the model has no step form for fails the run naming it.
 */
export function createActionHost(options: HostOptions): ActionHost {
  const github = githubContext(options.context, options.token);
  /** Fetched references by identity, so one action used twice is downloaded once. */
  const fetched = new Map<string, Promise<string>>();
  let rootPromise: Promise<string> | undefined;
  const rootOf = async (): Promise<string> => {
    const created = rootPromise ?? mkdtemp(join(tmpdir(), "pipewright-actions-"));
    rootPromise = created;

    return created;
  };

  const materialise = async (
    owner: string,
    repo: string,
    ref: string | undefined,
  ): Promise<string> => {
    const directory = await rootOf();
    const target = join(directory, owner, repo, ref ?? "-");
    await mkdir(target, { recursive: true });
    await extractTarball(target, await fetchTarball(options, owner, repo, ref));

    return target;
  };

  const resolver: ActionResolver = async (reference) => {
    if (reference.kind === "local") {
      return Promise.resolve(directoryTree(within(options.cwd, reference.path)));
    }
    const identity = `${reference.owner}/${reference.repo}@${reference.ref ?? "-"}`;
    let directory = fetched.get(identity);
    if (directory === undefined) {
      directory = materialise(reference.owner, reference.repo, reference.ref);
      fetched.set(identity, directory);
    }

    return directoryTree(within(await directory, reference.subpath ?? "."));
  };

  const node: NodeRunner = async () =>
    // The entry runs under the node the CLI itself runs under, which is the one runtime the host knows is present.
    Promise.resolve({ command: process.execPath, args: [] });

  const steps: StepHost = {
    async expand(job, view): Promise<JobExpansion> {
      const raw = job.native?.[PROVIDER]?.env;
      // A run told to skip provider steps runs none of their actions, so it fetches nothing and places no phases; the job's own environment is still evaluated, because the steps that do run read it.
      const uses = options.skipProviderSteps
        ? []
        : job.steps.filter((step) => usesOf(step) !== undefined);
      // A job that carries no action and no environment of GitHub's own prepares nothing and fetches nothing.
      if (uses.length === 0 && raw === undefined) {
        return { steps: job.steps, env: {} };
      }
      const context = evaluationContextOf(view, github, options.secrets);
      const env = stepEnvironment(raw, context, (construct) => {
        throw new Error(`job ${JSON.stringify(job.name)} carries ${construct}`);
      });
      const pre: Step[] = [];
      const post: Step[] = [];
      // The phases are placed in the order the steps name their actions, because that is the order the runner's own phases run them in.
      const expansions = await uses.reduce<Promise<{ pre: Step[]; post: Step[] }>>(
        async (previous, step) => {
          const placed = await previous;
          const reference = usesOf(step);
          // A reference the library cannot parse names no tree to read, so it has no phases to place; the step stays in place for resolution to reject or skip.
          if (reference === undefined || unparsable(reference) !== undefined) return placed;
          // Only the phases are kept: the steps the expansion produced are derived again when the step is reached, against the view that moment holds.
          const expansion = await expandAction(step, { resolve: resolver, node, context });

          return {
            pre: [...placed.pre, ...expansion.pre],
            post: [...placed.post, ...expansion.post],
          };
        },
        Promise.resolve({ pre, post }),
      );
      pre.push(...expansions.pre);
      post.push(...expansions.post);

      return { steps: [...pre, ...job.steps, ...[...post].reverse()], env };
    },

    async resolve(step, view): Promise<StepResolution> {
      if (step.kind === "provider" && options.skipProviderSteps) {
        // The run was told its host has supplied the toolchain the provider's steps would install, so they are all skipped, an action's own included.
        return { kind: "skipped" };
      }
      if (step.kind === "provider" && step.provider !== PROVIDER) {
        return options.skipProviderSteps
          ? { kind: "skipped" }
          : { kind: "unhandled", construct: `a step owned by ${step.provider}` };
      }
      if (!isGitHubStep(step)) {
        throw new Error("asked to resolve a step that is not one of GitHub's provider steps");
      }
      const context = evaluationContextOf(view, github, options.secrets);
      const condition = textOf(step.native, "if");
      if (condition !== undefined && !evaluateCondition(condition, context)) {
        return { kind: "skipped" };
      }
      const uses = textOf(step.native, "uses");
      if (uses !== undefined) {
        const construct = unparsable(uses);
        if (construct !== undefined) {
          return options.skipProviderSteps
            ? { kind: "skipped" }
            : { kind: "unhandled", construct: `${uses}, ${construct}` };
        }
        const expansion = await expandAction(step, { resolve: resolver, node, context });
        const prepared = expansion.steps.map<PreparedStep>((inner) => {
          if (inner.kind !== "run") {
            throw new Error("the expansion produced a step the runner does not run");
          }

          return {
            name: inner.name ?? inner.run,
            command: inner.run,
            env: { ...inner.env },
            workingDirectory: inner.workingDirectory,
          };
        });

        return { kind: "steps", steps: prepared };
      }
      const run = textOf(step.native, "run");
      if (run === undefined) {
        return {
          kind: "unhandled",
          construct: "a provider step whose native carries neither run nor uses",
        };
      }
      const fail = (construct: string): never => {
        throw new Error(`the step ${JSON.stringify(stepNameOf(step, run))} carries ${construct}`);
      };
      const shell = textOf(step.native, "shell");
      if (shell !== undefined && !POSIX_SHELLS.has(shell)) {
        return {
          kind: "unhandled",
          construct: `the shell "${shell}", which names an interpreter the host's own shell would not run as written`,
        };
      }
      for (const key of ["continue-on-error", "timeout-minutes"]) {
        if (step.native[key] !== undefined) {
          return { kind: "unhandled", construct: `${key}, which the model has no step form for` };
        }
      }
      const env = stepEnvironment(step.native.env, context, fail);
      // The step's own environment is visible to the expressions of its command and condition, which is the view the library evaluates a composite step with.
      const own = { ...context, env: { ...context.env, ...env } };
      const directory = textOf(step.native, "working-directory");
      const workingDirectory =
        directory === undefined ? undefined : evaluateTemplate(directory, own);
      const command = evaluateTemplate(run, own);

      return {
        kind: "steps",
        steps: [{ name: stepNameOf(step, command), command, env, workingDirectory }],
      };
    },
  };

  return {
    resolver,
    node,
    steps,
    async dispose() {
      // A run that fetched nothing created no directory, so there is nothing to remove.
      if (rootPromise !== undefined) {
        await rm(await rootPromise, { recursive: true, force: true });
      }
    },
  };
}
