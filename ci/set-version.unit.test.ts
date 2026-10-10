import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const script = resolve(import.meta.dirname, "../scripts/set-version.ts");

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), "pipewright-version-"));
  for (const [name, dependencies] of [
    ["a", {}],
    ["b", { "@pipewright/a": "0.0.0", yaml: "2.9.1" }],
  ] as const) {
    mkdirSync(join(root, "packages", name), { recursive: true });
    writeFileSync(
      join(root, "packages", name, "package.json"),
      JSON.stringify({ name: `@pipewright/${name}`, version: "0.0.0", dependencies }),
    );
  }

  return root;
}

function manifest(
  root: string,
  name: string,
): { readonly version: unknown; readonly dependencies: unknown } {
  const parsed: unknown = JSON.parse(
    readFileSync(join(root, "packages", name, "package.json"), "utf8"),
  );
  if (typeof parsed !== "object" || parsed === null) throw new Error("not an object");
  if (!("version" in parsed) || !("dependencies" in parsed)) throw new Error("missing fields");

  return { version: parsed.version, dependencies: parsed.dependencies };
}

describe("set-version", () => {
  it("stamps every package and each dependency on a sibling, and leaves third-party ranges", () => {
    const root = workspace();
    execFileSync("node", [script, "1.2.3", root]);

    expect(manifest(root, "a").version).toBe("1.2.3");
    expect(manifest(root, "b").version).toBe("1.2.3");
    expect(manifest(root, "b").dependencies).toEqual({ "@pipewright/a": "1.2.3", yaml: "2.9.1" });
  });

  it("refuses a version that is not semantic", () => {
    expect(() => execFileSync("node", [script, "v1.2", workspace()], { stdio: "pipe" })).toThrow();
  });
});
