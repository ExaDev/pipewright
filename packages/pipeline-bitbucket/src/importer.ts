import {
  UnsupportedNativeError,
  jsonPointerOf,
  uniqueJobIds,
  validateImported,
  type EmittedFile,
  type Pipeline,
  type PipelineImporter,
  splitShellEntry,
} from "@pipewright/pipeline-contract";
import { commentPath, readYaml } from "@pipewright/yaml-emit";

import {
  FILE,
  MANUAL_PIPELINE,
  MAX_TIME_RANGE,
  PROVIDER,
  SELF_HOSTED_LABEL,
} from "./vocabulary.ts";

type Pointer = readonly (string | number)[];

function fail(pointer: Pointer, construct: string): never {
  throw new UnsupportedNativeError(PROVIDER, jsonPointerOf(pointer), construct);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordAt(value: unknown, pointer: Pointer, what: string): Record<string, unknown> {
  if (!isRecord(value)) return fail(pointer, `${what} that is not a mapping`);

  return value;
}

function arrayAt(value: unknown, pointer: Pointer, what: string): unknown[] {
  if (!Array.isArray(value)) return fail(pointer, `${what} that is not a list`);

  return value;
}

/**
 * A call of this tool's runner, which is what a wrapper-form file contains where steps were. It carries none of the steps, so there is nothing to import from it.
 */
const WRAPPER_CALL = /\srun --pipeline \S+ --job \S+ --steps \d+-\d+/;

/**
 * The steps of one trigger's pipeline, each with where it sits so its comment can be found.
 */
interface Placed {
  readonly body: Record<string, unknown>;
  readonly pointer: Pointer;
  /** The comment path of the item that holds the step. */
  readonly commentSegments: readonly string[];
  readonly final: boolean;
}

/**
 * Reads a pipeline's items into groups of steps that run together, in order.
 */
function groupsOf(
  items: readonly unknown[],
  at: Pointer,
  commentBase: readonly string[],
): Placed[][] {
  const groups: Placed[][] = [];
  for (const [index, item] of items.entries()) {
    const pointer: Pointer = [...at, index];
    const entry = recordAt(item, pointer, "a pipeline item");
    const segment = String(index);
    const keys = Object.keys(entry);
    const only = keys.length === 1 ? keys[0] : undefined;
    if (only === "step" || only === "final") {
      const body = recordAt(entry[only], [...pointer, only], "a step");
      groups.push([
        {
          body,
          pointer: [...pointer, only],
          commentSegments: [...commentBase, segment],
          final: only === "final",
        },
      ]);
    } else if (only === "parallel") {
      const members = arrayAt(entry.parallel, [...pointer, "parallel"], "a parallel group");
      groups.push(
        members.map((member, position) => {
          const memberPointer: Pointer = [...pointer, "parallel", position];
          const wrapper = recordAt(member, memberPointer, "a parallel member");
          if (Object.keys(wrapper).length !== 1 || !("step" in wrapper)) {
            return fail(memberPointer, "a parallel member that is not a step");
          }

          return {
            body: recordAt(wrapper.step, [...memberPointer, "step"], "a step"),
            pointer: [...memberPointer, "step"],
            commentSegments: [...commentBase, segment, "parallel", String(position)],
            final: false,
          };
        }),
      );
    } else {
      return fail(pointer, `a pipeline item ${JSON.stringify(only ?? keys.join(", "))}`);
    }
  }

  return groups;
}

/** A shell reference to a variable Bitbucket defines, which another provider's runner does not. */
const RUNTIME_VARIABLE = /\$\{?BITBUCKET_[A-Z0-9_]+/;

const STEP_KEYS = new Set(["name", "runs-on", "max-time", "deployment", "clone", "script"]);

function stepOf(
  placed: Placed,
  name: string,
  comments: ReadonlyMap<string, string>,
): Record<string, unknown> {
  const { body, pointer } = placed;
  // A step that carries settings of Bitbucket's own (a trigger, a condition, an image, services, caches, an after-script) is Bitbucket's as a whole, because another provider would run its script without them.
  const own = Object.keys(body).filter((key) => !STEP_KEYS.has(key));
  const script = arrayAt(body.script, [...pointer, "script"], "a script");
  if (script.length === 0) return fail([...pointer, "script"], "a step with an empty script");

  const native: Record<string, unknown> = {};
  const runsOn = body["runs-on"];
  const labels =
    typeof runsOn === "string"
      ? [runsOn]
      : Array.isArray(runsOn) && runsOn.every((label) => typeof label === "string")
        ? runsOn
        : undefined;
  const selfHosted = labels?.includes(SELF_HOSTED_LABEL) === true;
  if (runsOn !== undefined && !selfHosted) native["runs-on"] = runsOn;

  const maxTime = body["max-time"];
  const timeoutPortable =
    typeof maxTime === "number" &&
    Number.isInteger(maxTime) &&
    maxTime >= MAX_TIME_RANGE.min &&
    maxTime <= MAX_TIME_RANGE.max;
  if (maxTime !== undefined && !timeoutPortable) native["max-time"] = maxTime;
  if (body.deployment !== undefined && typeof body.deployment !== "string") {
    native.deployment = body.deployment;
  }

  // A clone that is only a depth is the model's checkout. Any other clone setting stays Bitbucket's, and disabling the clone leaves no checkout.
  const clone = body.clone;
  const depthOnly =
    isRecord(clone) &&
    Object.keys(clone).length === 1 &&
    (clone.depth === "full" || (typeof clone.depth === "number" && clone.depth > 0));
  if (clone !== undefined && !depthOnly) native.clone = clone;
  const checksOut = !(isRecord(clone) && clone.enabled === false);

  const steps: Record<string, unknown>[] = [];
  if (checksOut) {
    steps.push({
      kind: "checkout",
      ...(depthOnly && isRecord(clone) ? { fetchDepth: clone.depth } : {}),
    });
  }
  // Consecutive command lines run in one shell, so they are one step, and a pipe between two runs of them is its own step.
  let commands: string[] = [];
  const flush = (): void => {
    if (commands.length === 0) return;
    const lines = commands;
    commands = [];
    // GitHub evaluates `${{ }}` in a command before the shell, so a command carrying one must not reach a GitHub workflow as portable text.
    if (
      own.length > 0 ||
      Object.keys(native).length > 0 ||
      lines.some((line) => RUNTIME_VARIABLE.test(line) || line.includes("${{"))
    ) {
      steps.push({ kind: "provider", provider: PROVIDER, native: { script: lines } });
    } else {
      for (const run of splitShellEntry(lines.join("\n"))) steps.push({ kind: "run", run });
    }
  };
  for (const [index, item] of script.entries()) {
    const at: Pointer = [...pointer, "script", index];
    if (typeof item === "string") {
      if (WRAPPER_CALL.test(item)) {
        return fail(
          at,
          "a call to this tool's runner, which stands for steps held in the pipeline file it names; import that file",
        );
      }
      commands.push(item);
    } else if (isRecord(item) && "pipe" in item) {
      flush();
      steps.push({ kind: "provider", provider: PROVIDER, native: item });
    } else {
      return fail(at, "a script item that is neither a command nor a pipe");
    }
  }
  flush();

  for (const [key, entry] of Object.entries(body)) {
    if (!STEP_KEYS.has(key)) native[key] = entry;
  }

  const description = comments.get(commentPath(...placed.commentSegments));

  return {
    name,
    ...(description === undefined ? {} : { description }),
    runsOn: selfHosted ? labels : [],
    ...(placed.final ? { needsPolicy: "always" } : {}),
    ...(timeoutPortable ? { timeoutMinutes: maxTime } : {}),
    ...(typeof body.deployment === "string" ? { environment: body.deployment } : {}),
    steps,
    ...(Object.keys(native).length === 0 ? {} : { native: { [PROVIDER]: native } }),
  };
}

/**
 * A pipeline the file declares for a trigger, with where it sits so its steps' comments can be found.
 */
interface Source {
  readonly items: readonly unknown[];
  readonly pointer: Pointer;
}

interface Triggers {
  /** What the file's sections mean as triggers, each once. */
  readonly triggers: Record<string, unknown>[];
  /** Every pipeline the file declares, which must all run the same steps. */
  readonly sources: Source[];
}

function triggersOf(pipelines: Record<string, unknown>): Triggers {
  const triggers: Record<string, unknown>[] = [];
  const sources: Source[] = [];
  const declare = (trigger: Record<string, unknown>, pointer: Pointer, what: string): void => {
    sources.push({ items: arrayAt(readAt(pipelines, pointer.slice(1)), pointer, what), pointer });
    if (
      trigger.branches === undefined ||
      !triggers.some((t) => t.kind === "push" && t.branches !== undefined)
    ) {
      triggers.push(trigger);
    }
  };
  const allowed = new Set(["default", "branches", "pull-requests", "custom"]);
  for (const key of Object.keys(pipelines)) {
    if (!allowed.has(key)) fail(["pipelines", key], `the ${key} pipelines`);
  }

  if (pipelines.default !== undefined) {
    declare({ kind: "push" }, ["pipelines", "default"], "the default pipeline");
  }
  if (pipelines.branches !== undefined) {
    const branches = recordAt(pipelines.branches, ["pipelines", "branches"], "the branches");
    const names = Object.keys(branches);
    for (const name of names) {
      // A branch key is a glob in Bitbucket, which the model's branch names are not, so another provider would take it literally.
      if (/[*?+[\]{}!]/.test(name)) {
        fail(["pipelines", "branches", name], "a branch pattern, which the model has no form for");
      }
      declare(
        { kind: "push", branches: names },
        ["pipelines", "branches", name],
        "a branch pipeline",
      );
    }
  }
  if (pipelines["pull-requests"] !== undefined) {
    const requests = recordAt(
      pipelines["pull-requests"],
      ["pipelines", "pull-requests"],
      "the pull-request pipelines",
    );
    for (const pattern of Object.keys(requests)) {
      if (pattern !== "**") {
        fail(
          ["pipelines", "pull-requests", pattern],
          "a pull-request pipeline for a branch pattern, because the model has one for every pull request",
        );
      }
    }
    declare(
      { kind: "pullRequest" },
      ["pipelines", "pull-requests", "**"],
      "a pull-request pipeline",
    );
  }
  if (pipelines.custom !== undefined) {
    const custom = recordAt(pipelines.custom, ["pipelines", "custom"], "the custom pipelines");
    for (const name of Object.keys(custom)) {
      if (name !== MANUAL_PIPELINE) {
        fail(["pipelines", "custom", name], `a custom pipeline named ${JSON.stringify(name)}`);
      }
    }
    declare({ kind: "manual" }, ["pipelines", "custom", MANUAL_PIPELINE], "a custom pipeline");
  }

  return { triggers, sources };
}

function readAt(root: Record<string, unknown>, path: Pointer): unknown {
  let current: unknown = root;
  for (const segment of path) {
    current = isRecord(current) ? current[String(segment)] : undefined;
  }

  return current;
}

function importConfiguration(file: EmittedFile): Pipeline {
  const { value, comments } = readYaml(file.content);
  const document = recordAt(value, [], "the configuration");
  for (const key of Object.keys(document)) {
    if (key !== "pipelines") fail([key], `the ${key} setting, which has no place in the model`);
  }
  const { triggers, sources } = triggersOf(
    recordAt(document.pipelines, ["pipelines"], "the pipelines"),
  );
  const [first] = sources;
  if (first === undefined) return fail(["pipelines"], "a configuration with no pipeline");

  // One job graph is read, so every trigger must run the same steps; the compiler writes one set under every trigger.
  const serialised = JSON.stringify(first.items);
  for (const other of sources) {
    if (JSON.stringify(other.items) !== serialised) {
      return fail(
        other.pointer,
        "a trigger whose steps differ from another trigger's, because the model has one job graph for every trigger",
      );
    }
  }

  const groups = groupsOf(first.items, first.pointer, first.pointer.map(String));
  if (groups.length === 0) return fail(first.pointer, "a pipeline with no steps");
  const placed = groups.flat();
  const lastGroup = groups.at(-1) ?? [];
  for (const entry of placed) {
    if (entry.final && !lastGroup.includes(entry))
      fail(entry.pointer, "a final step that is not last");
  }

  const names = placed.map((entry, position) =>
    typeof entry.body.name === "string" ? entry.body.name : `Step ${String(position + 1)}`,
  );
  const ids = uniqueJobIds(names);
  let position = 0;
  const idGroups = groups.map((group) =>
    group.map((entry) => {
      const index = position;
      position += 1;

      return { entry, id: ids[index] ?? "job", name: names[index] ?? "" };
    }),
  );

  const jobs: [string, Record<string, unknown>][] = [];
  for (const [level, group] of idGroups.entries()) {
    const previous = level === 0 ? [] : (idGroups[level - 1] ?? []).map((member) => member.id);
    for (const { entry, id, name } of group) {
      const job = stepOf(entry, name, comments);
      jobs.push([id, { ...job, ...(previous.length === 0 ? {} : { needs: previous }) }]);
    }
  }

  const description = comments.get("pipelines");

  return validateImported(PROVIDER, {
    name: FILE.replace(/\.ya?ml$/, ""),
    ...(description === undefined ? {} : { description }),
    triggers,
    jobs: Object.fromEntries(jobs),
  });
}

/**
 * Reads a `bitbucket-pipelines.yml` into the neutral model: the inverse of `createBitbucketPipelinesCompiler`.
 *
 * Read: the default, branch, pull-request and manual pipelines as triggers, provided every one runs the same steps; the sequence of steps and parallel groups as the job graph, each step depending on the whole group before it; a trailing `final` step as an always-running job; names, timeouts, deployment environments, self-hosted runner labels, clone depth, and script lines and pipes. A matrix the compiler expanded reads back as the separate steps it was written as. What Bitbucket owns and the model carries verbatim is kept on the job's `native` mapping (any other step key, runner labels that name no self-hosted runner, a clone with settings beyond depth). What has nowhere to be carried is rejected with its JSON pointer: top-level settings such as `image` and `definitions`, tag and bookmark pipelines, custom pipelines other than the manual one, a pull-request pipeline for a branch pattern, triggers that run different steps, stages, and a call to this tool's runner. A step with no name is named for its position, and the pipeline for its file.
 */
export function createBitbucketPipelinesImporter(): PipelineImporter {
  return {
    provider: PROVIDER,
    async import(file, options): Promise<Pipeline> {
      options?.signal?.throwIfAborted();

      return Promise.resolve(importConfiguration(file));
    },
  };
}
