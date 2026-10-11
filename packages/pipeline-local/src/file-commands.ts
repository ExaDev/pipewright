import type { Annotation } from "@pipewright/pipeline-contract";

/** One `key=value`, or heredoc, entry a step wrote to its output or environment file. */
export interface FileEntry {
  readonly key: string;
  readonly value: string;
}

/**
 * The lines of a command file. A trailing newline terminates the last entry rather than starting an empty one; an interior blank line carries no entry, as the provider's own runner skips it.
 */
function fileLines(content: string): string[] {
  const lines = content.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();

  return lines;
}

/**
 * Parses an output or environment file: `key=value` lines, and multi-line values as `key<<delimiter` ... `delimiter`, the form actions/toolkit writes. A line that is neither, a heredoc that never closes, or an empty key is an error naming the file and the line. This mirrors the provider's own parser: a `=` before any `<<` makes the line a plain entry whose value may contain `<<`, and anything else that opens no heredoc is malformed.
 */
export function parseKeyValueFile(fileName: string, content: string): FileEntry[] {
  const lines = fileLines(content);
  const entries: FileEntry[] = [];
  let consumed = 0;
  for (const [offset, line] of lines.entries()) {
    if (offset < consumed || line === "") continue;
    const at = `${fileName} line ${String(offset + 1)}`;
    const equals = line.indexOf("=");
    const heredoc = line.indexOf("<<");
    if (equals >= 0 && (heredoc < 0 || equals < heredoc)) {
      const key = line.slice(0, equals);
      // The line's text is never in the message, because a malformed line can carry a value a step masked.
      if (key === "") throw new Error(`${at} has an empty key`);

      entries.push({ key, value: line.slice(equals + 1) });
      continue;
    }
    if (heredoc >= 0 && (equals < 0 || heredoc < equals)) {
      const key = line.slice(0, heredoc);
      const delimiter = line.slice(heredoc + 2);
      if (key === "" || delimiter === "") {
        throw new Error(`${at} opens a heredoc with an empty key or delimiter`);
      }
      const end = lines.indexOf(delimiter, offset + 1);
      if (end === -1) {
        throw new Error(`${at} opens a heredoc that no later line closes`);
      }
      entries.push({ key, value: lines.slice(offset + 1, end).join("\n") });
      consumed = end + 1;
      continue;
    }

    throw new Error(`${at} is neither key=value nor a heredoc`);
  }

  return entries;
}

/**
 * Parses a path file: each non-blank line is one directory. No line is malformed, because any line of text can name a directory; the runner never checks the host's filesystem.
 */
export function parsePathFile(content: string): string[] {
  return fileLines(content).filter((line) => line !== "");
}

/**
 * The path entries a step wrote, most preferred first. Each line the step wrote takes precedence over the lines before it and over every entry an earlier step wrote, and a repeated entry moves rather than duplicates, which is the order the provider's own runner joins onto `PATH`.
 */
export function preferredPaths(written: readonly string[], previous: readonly string[]): string[] {
  const ordered = [...new Set(written.toReversed())];

  return [...ordered, ...previous.filter((entry) => !ordered.includes(entry))];
}

/** A workflow command parsed from a step's stdout. */
export type WorkflowCommand =
  | { readonly kind: "mask"; readonly value: string }
  | {
      readonly kind: "level";
      readonly level: "debug" | "warning" | "error" | "notice";
      readonly message: string;
      readonly annotation: Annotation | undefined;
    };

/** One line of a step's stdout: a workflow command, or text the run echoes. */
export type StdoutLine =
  | { readonly kind: "command"; readonly command: WorkflowCommand }
  | { readonly kind: "text"; readonly text: string };

/** The codes a command writer escapes to, as actions/toolkit writes them: data is `%`, CR and LF; a property value additionally escapes the `:` and `,` its own syntax uses as separators. */
const DATA_CODES: Readonly<Record<string, string>> = {
  "%25": "%",
  "%0D": "\r",
  "%0A": "\n",
};

const PROPERTY_CODES: Readonly<Record<string, string>> = {
  ...DATA_CODES,
  "%3A": ":",
  "%2C": ",",
};

/**
 * Reverses the toolkit's escaping in one pass, so a `%25` that stands for a literal percent is not itself read as the start of another code. A percent sequence the writer did not escape stays as written.
 */
function unescape(text: string, codes: Readonly<Record<string, string>>): string {
  return text.replace(/%[0-9A-F]{2}/g, (code) => codes[code] ?? code);
}

const LOG_LEVELS = ["debug", "warning", "error", "notice"] as const;

/**
 * The properties a log command carries: `file`, `line`, `endLine` and `title`, exactly the set the provider documents. A property outside that set, or a line number that is not one, is an error naming the command and the property.
 */
function parseAnnotation(command: string, properties: string): Annotation | undefined {
  if (properties === "") return undefined;

  const annotation: { file?: string; line?: number; endLine?: number; title?: string } = {};
  for (const part of properties.split(",")) {
    const separator = part.indexOf("=");
    // The property's text is never quoted in the message, because a malformed property can carry a value a step masked.
    if (separator <= 0) {
      throw new Error(`::${command}:: carries a property that is not name=value`);
    }
    const name = part.slice(0, separator);
    const value = unescape(part.slice(separator + 1), PROPERTY_CODES);
    if (name === "file") {
      annotation.file = value;
    } else if (name === "title") {
      annotation.title = value;
    } else if (name === "line" || name === "endLine") {
      // The value is never quoted in the message, because a property's value can carry a value a step masked.
      if (!/^\d+$/.test(value)) {
        throw new Error(`::${command}:: property ${name} is not a line number`);
      }
      annotation[name] = Number(value);
    } else {
      throw new Error(`::${command}:: carries the unknown property ${name}`);
    }
  }

  return annotation;
}

/** A command head: a name, optionally followed by a space and the command's `property=value` list, as actions/toolkit writes it. */
const COMMAND_HEAD = /^([a-z][a-z0-9-]*)(?:[ ](.*))?$/;

/**
 * Parses one line of a step's stdout as a workflow command: `::name::message` or `::name property=value,...::message`. A line that starts with `::` and closes a second `::` is a command, and a name outside the implemented set is an error naming it, never a silent pass; a line that does not parse as one is ordinary text.
 */
export function parseStdoutLine(line: string): StdoutLine {
  if (!line.startsWith("::")) return { kind: "text", text: line };
  const closing = line.indexOf("::", 2);
  if (closing === -1) return { kind: "text", text: line };

  const head = COMMAND_HEAD.exec(line.slice(2, closing));
  if (head?.[1] === undefined) return { kind: "text", text: line };
  const name = head[1];
  const properties = head[2] ?? "";
  const message = unescape(line.slice(closing + 2), DATA_CODES);

  if (name === "add-mask") {
    if (properties !== "") {
      throw new Error(
        `::add-mask:: carries the unknown property ${properties.split("=")[0] ?? ""}`,
      );
    }
    if (message === "") throw new Error("::add-mask:: masks an empty value");

    return { kind: "command", command: { kind: "mask", value: message } };
  }
  const level = LOG_LEVELS.find((candidate) => candidate === name);
  if (level === undefined) throw new Error(`unknown workflow command ::${name}::`);

  return {
    kind: "command",
    command: { kind: "level", level, message, annotation: parseAnnotation(name, properties) },
  };
}

/**
 * Replaces every occurrence of each masked value with `***`, longer values first so a mask that contains another does not leave fragments of it behind.
 */
export function applyMasks(text: string, masks: readonly string[]): string {
  return masks
    .toSorted((left, right) => right.length - left.length)
    .reduce((result, mask) => result.replaceAll(mask, "***"), text);
}
