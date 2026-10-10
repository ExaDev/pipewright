/**
 * A file-name-safe lower-case form of a name, used where a provider needs an identifier derived from the pipeline's name.
 */
export function slugOf(text: string): string {
  return text
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "");
}
