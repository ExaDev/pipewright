import type { Pipeline } from "./schema.ts";

/**
 * The longest `needs` chain below each job: a job with no needs is level 0, and every other job sits one level above its highest need. Providers whose graph is a sequence of parallel groups schedule by level.
 */
export function dependencyLevels(jobs: Pipeline["jobs"]): Map<string, number> {
  const levels = new Map<string, number>();
  const levelOf = (id: string): number => {
    const known = levels.get(id);
    if (known !== undefined) return known;
    const needs = jobs[id]?.needs ?? [];
    const level = needs.length === 0 ? 0 : Math.max(...needs.map(levelOf)) + 1;
    levels.set(id, level);

    return level;
  };
  for (const id of Object.keys(jobs)) levelOf(id);

  return levels;
}

/**
 * Every job `id` depends on, directly or through other jobs.
 */
export function ancestorsOf(jobs: Pipeline["jobs"], id: string): Set<string> {
  const found = new Set<string>();
  const visit = (current: string): void => {
    for (const needed of jobs[current]?.needs ?? []) {
      if (!found.has(needed)) {
        found.add(needed);
        visit(needed);
      }
    }
  };
  visit(id);

  return found;
}

/**
 * A file-name-safe lower-case form of a name, used where a provider needs an identifier derived from the pipeline's name.
 */
export function slugOf(text: string): string {
  return text
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "");
}
