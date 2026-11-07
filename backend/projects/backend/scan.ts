import { join } from "node:path";
import type { ProjectSnapshot } from "../db/store.ts";
import { shouldSkipDir } from "./exclude.ts";
import { inspectRepo } from "./git.ts";

export const DEFAULT_CONCURRENCY = 8;

export async function scanRoot(
  root: string,
  options: { concurrency?: number; timeoutMs?: number } = {},
): Promise<ProjectSnapshot[]> {
  const dirs: { name: string; path: string }[] = [];
  for await (const entry of Deno.readDir(root)) {
    if (!entry.isDirectory) continue;
    if (shouldSkipDir(entry.name)) continue;
    const path = join(root, entry.name);
    try {
      const marker = await Deno.stat(join(path, ".project-status-ignore"));
      if (marker.isFile) continue;
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    dirs.push({ name: entry.name, path });
  }
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  return await mapPool(
    dirs,
    concurrency,
    (dir) => inspectRepo(dir.name, dir.path, options.timeoutMs),
  );
}

async function mapPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index]);
    }
  };
  const workers = Math.min(Math.max(1, limit), items.length);
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return results;
}
