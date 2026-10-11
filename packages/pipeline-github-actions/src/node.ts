import type { Step } from "@pipewright/pipeline-contract";

import type { NodeAction } from "./action.ts";
import type { ActionExpansion } from "./composite.ts";
import { evaluateCondition, type EvaluationContext } from "./evaluation.ts";

/**
 * How the host invokes node for a node action's entry file: the command and the arguments that precede the entry's path. The library runs no binary of its own; the runner picks its bundled node per the declared `runs.using`, and this port stands in for that choice, so a host decides whether the entry runs under the `node` on `PATH`, a pinned install or an absolute path.
 * @see https://github.com/actions/runner/blob/main/src/Runner.Worker/Handlers/NodeScriptActionHandler.cs
 */
export interface NodeInvocation {
  readonly command: string;

  readonly args: readonly string[];
}

/** The host's node port, a peer of the action resolver: asked once per expanded action, never defaulted, so a host that never expands a node action is never asked. */
export type NodeRunner = (signal?: AbortSignal) => Promise<NodeInvocation>;

/**
 * The environment variable a supplied input arrives as: `INPUT_` before the input's name, with spaces replaced by underscores and the result upper-cased, which is the derivation GitHub's own runner applies to every input it passes. The name's other characters, a hyphen among them, keep their own shape.
 * @see https://github.com/actions/runner/blob/main/src/Runner.Worker/Handlers/Handler.cs, AddInputsToEnvironment
 * @see https://docs.github.com/en/actions/sharing-automations/creating-actions/metadata-syntax-for-github-actions
 * @see https://web.archive.org/web/20250615225859/https://docs.github.com/en/actions/sharing-automations/creating-actions/metadata-syntax-for-github-actions
 */
export function inputEnvironmentName(name: string): string {
  return `INPUT_${name.replaceAll(" ", "_").toUpperCase()}`;
}

/**
 * One word of the composed command, quoted so a POSIX shell reads it as one word whatever it contains. Every host of this tool runs a step's command through a POSIX shell of its own, and an entry path may hold a space, so no word is left to the shell's own reading.
 */
function shellWord(word: string): string {
  return `'${word.replaceAll("'", `'\\''`)}'`;
}

/** What the node branch of the expansion passes to build an action's steps. */
export interface NodeCall {
  readonly action: NodeAction;

  /** The directory the host materialised the action at, which is the base of the entry paths and the value of `GITHUB_ACTION_PATH`. */
  readonly path: string;

  /** The action's mapped inputs, one string per declared input, exactly what a composite action's steps would read as the `inputs` context. */
  readonly inputs: Readonly<Record<string, string>>;

  /** The workflow step's evaluated name, which the main step carries when the step wrote one. */
  readonly name: string | undefined;

  /** The step's `uses` text as written, which names the pre and post steps when the step carried no name, as GitHub's own display names do. */
  readonly uses: string;

  /**
   * The context the `pre-if` and `post-if` conditions evaluate against: the view the caller expanded with, which for a post condition is the pre-run view, so outcomes no expansion can know are not guessed at.
   */
  readonly ambient: EvaluationContext;

  readonly invocation: NodeInvocation;
}

/**
 * Builds the steps a node action's execution is represented as: the `main` entry as one neutral run step, and the `pre` and `post` entries as run steps the caller places around the job's own steps. Every phase runs the same command shape, the host's node invocation followed by the entry's path under the action's directory, with the inputs in the environment as the runner derives them and `GITHUB_ACTION_PATH` injected over any value the step itself wrote.
 *
 * Pre: `inputs` holds a string for every input the action declares, mapped and defaulted by the caller. Post: `steps` holds exactly the `main` step; `pre` and `post` hold their phase step when the action declares the entry and its condition allows, and are empty otherwise. The default condition is the documented `always()`, so a phase with no written condition always runs.
 */
export function nodeExpansionOf(call: NodeCall): ActionExpansion {
  const { action, path, name, uses, ambient, invocation } = call;
  const inputEnvironment: Record<string, string> = {};
  for (const [input, value] of Object.entries(call.inputs)) {
    inputEnvironment[inputEnvironmentName(input)] = value;
  }
  const environment: Record<string, string> = { ...inputEnvironment, GITHUB_ACTION_PATH: path };
  const commandOf = (entry: string): string =>
    [invocation.command, ...invocation.args, `${path}/${entry}`].map(shellWord).join(" ");
  const allows = (condition: string | undefined): boolean =>
    condition === undefined || evaluateCondition(condition, ambient);
  const phaseStep = (entry: string, prefix: string): Step => ({
    kind: "run",
    name: `${prefix} ${name ?? uses}`,
    run: commandOf(entry),
    env: environment,
  });

  return {
    steps: [
      {
        kind: "run",
        ...(name === undefined ? {} : { name }),
        run: commandOf(action.runs.main),
        env: environment,
      },
    ],
    pre:
      action.runs.pre !== undefined && allows(action.runs["pre-if"])
        ? [phaseStep(action.runs.pre, "Pre")]
        : [],
    post:
      action.runs.post !== undefined && allows(action.runs["post-if"])
        ? [phaseStep(action.runs.post, "Post")]
        : [],
  };
}
