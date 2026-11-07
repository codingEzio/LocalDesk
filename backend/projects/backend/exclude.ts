export const ARCHIVE_NAMES = new Set([
  "_abandoned",
]);

export function shouldSkipDir(name: string): boolean {
  return name.startsWith(".") || ARCHIVE_NAMES.has(name);
}
