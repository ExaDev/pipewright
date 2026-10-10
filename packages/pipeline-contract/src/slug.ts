/**
 * A file-name-safe lower-case form of a name, used where a provider needs an identifier derived from the pipeline's name.
 */
export function slugOf(text: string): string {
  return text
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "");
}

const JOB_ID_START = /^[a-z]/;
const FALLBACK_JOB_ID = "job";

/**
 * One job id per name, in order, for a provider whose file keys jobs by display name and so has no id to read back. Each id is the name's slug, made to start with a letter, and a repeated slug takes a numeric suffix so every id is unique.
 */
export function uniqueJobIds(names: readonly string[]): string[] {
  const taken = new Set<string>();

  return names.map((name) => {
    const slug = slugOf(name);
    const base =
      slug === "" ? FALLBACK_JOB_ID : JOB_ID_START.test(slug) ? slug : `${FALLBACK_JOB_ID}-${slug}`;
    let id = base;
    for (let counter = 2; taken.has(id); counter += 1) id = `${base}-${String(counter)}`;
    taken.add(id);

    return id;
  });
}
