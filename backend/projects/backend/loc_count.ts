import { basename, join } from "node:path";
import {
  classifyPart,
  classifyPath,
  detectProfile,
  emptyLocPolicy,
  isIgnoredDirName,
  type LocPartId,
  type LocPolicy,
  type LocProfileId,
  posixPath,
  skipProject,
} from "./loc_profile.ts";

export type LocPart = { id: LocPartId; core: number };

export type LocCount = {
  name: string;
  profile: LocProfileId;
  core: number;
  test: number;
  counted_at: string;
  fingerprint: string;
  parts?: LocPart[];
  files: string[];
};

const HINT_CANDIDATES = [
  "frontend/src",
  "backend",
  "db",
  "Cargo.toml",
  "Package.swift",
  "Mac/Package.swift",
  "main",
  "bloglib",
  "pyproject.toml",
  "src",
  "src/sites.js",
  "src/sites",
  "scripts/build.js",
  "extension_chrome",
  "extension_safari",
  "native",
  "project.yml",
  "Atlas.xcodeproj",
  "worker.js",
  "public",
  "package.json",
] as const;

const MAX_FILE_BYTES = 2_000_000;

export async function collectHints(root: string): Promise<string[]> {
  const found: string[] = [];
  for (const candidate of HINT_CANDIDATES) {
    try {
      await Deno.stat(join(root, candidate));
      found.push(candidate);
    } catch {
      // Candidate is absent.
    }
  }
  try {
    for await (const entry of Deno.readDir(root)) {
      if (entry.isDirectory && entry.name.includes("Extension")) {
        found.push(entry.name);
      }
    }
  } catch {
    // Root disappeared.
  }
  return found;
}

export function countSourceLines(
  text: string,
  style: "c" | "hash" | "plain",
): { code: number; comment: number; blank: number } {
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  let block = false;
  let code = 0;
  let comment = 0;
  let blank = 0;
  for (const raw of lines) {
    if (raw.trim() === "") {
      blank += 1;
      continue;
    }
    if (style === "plain") {
      code += 1;
      continue;
    }
    if (style === "hash") {
      if (raw.trim().startsWith("#")) comment += 1;
      else code += 1;
      continue;
    }
    let line = raw;
    if (block) {
      const end = line.indexOf("*/");
      if (end === -1) {
        comment += 1;
        continue;
      }
      block = false;
      line = line.slice(end + 2);
      if (line.trim() === "") {
        comment += 1;
        continue;
      }
    }
    const trimmed = line.trim();
    if (trimmed.startsWith("//")) {
      comment += 1;
      continue;
    }
    if (trimmed.startsWith("/*")) {
      const end = trimmed.indexOf("*/");
      if (end === -1) {
        block = true;
        comment += 1;
        continue;
      }
      const rest = trimmed.slice(end + 2).trim();
      if (rest === "" || rest.startsWith("//")) {
        comment += 1;
        continue;
      }
      code += 1;
      continue;
    }
    code += 1;
    const start = line.indexOf("/*");
    if (start >= 0 && line.indexOf("*/", start + 2) === -1) block = true;
  }
  return { code, comment, blank };
}

export function formatLocCompact(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0";
  if (n < 1000) return String(n);
  if (n < 10000) {
    const tenths = Math.round(n / 100) / 10;
    return `${tenths}k`;
  }
  return `${Math.round(n / 1000)}k`;
}

function sourceStyle(relativePath: string): "c" | "hash" | "plain" {
  const path = posixPath(relativePath);
  const dot = path.lastIndexOf(".");
  const ext = dot >= 0 ? path.slice(dot).toLowerCase() : "";
  if (ext === ".py") return "hash";
  if (ext === ".json") return "plain";
  return "c";
}

function skipWalkDir(profile: LocProfileId, relativeDir: string): boolean {
  const path = posixPath(relativeDir);
  const name = basename(path);
  if (isIgnoredDirName(name)) return true;
  if (profile === "sitekit") {
    if (path === "extension_chrome" || path.startsWith("extension_chrome/")) {
      return true;
    }
    if (
      path === "extension_safari/web-extension" ||
      path.startsWith("extension_safari/web-extension/")
    ) {
      return true;
    }
  }
  if (profile === "web-svelte") {
    if (path === "frontend/public" || path.startsWith("frontend/public/")) {
      return true;
    }
    if (path === "deploy" || path === "scripts") return true;
  }
  if (profile === "python-blog") {
    if (path === "public" || path === "data") return true;
  }
  if (profile === "rust") {
    if (path === "unprocessed" || path === "native") return true;
  }
  if (profile === "deno-vanilla" && path === "scripts") return true;
  return false;
}

type CountedFile = {
  relative: string;
  kind: "core" | "test";
  part: LocPartId | null;
  size: number;
  mtime: number;
  absolute: string;
};

async function listCountedFiles(
  root: string,
  profile: LocProfileId,
  excluded: readonly string[],
): Promise<CountedFile[]> {
  const files: CountedFile[] = [];
  const walk = async (relativeDir: string) => {
    const dirPath = relativeDir ? join(root, relativeDir) : root;
    const entries: Deno.DirEntry[] = [];
    try {
      for await (const entry of Deno.readDir(dirPath)) entries.push(entry);
    } catch {
      return;
    }
    for (const entry of entries) {
      const relative = relativeDir
        ? `${relativeDir}/${entry.name}`
        : entry.name;
      if (
        excluded.some((path) =>
          relative === path || relative.startsWith(`${path}/`)
        )
      ) continue;
      if (entry.isDirectory) {
        if (skipWalkDir(profile, relative)) continue;
        await walk(relative);
        continue;
      }
      if (!entry.isFile) continue;
      const kind = classifyPath(profile, relative);
      if (kind === "ignore") continue;
      try {
        const absolute = join(root, relative);
        const stat = await Deno.stat(absolute);
        if (!stat.isFile || (stat.size ?? 0) > MAX_FILE_BYTES) continue;
        files.push({
          relative: posixPath(relative),
          kind,
          part: classifyPart(profile, relative),
          size: stat.size ?? 0,
          mtime: stat.mtime?.getTime() ?? 0,
          absolute,
        });
      } catch {
        // File vanished while walking.
      }
    }
  };
  await walk("");
  files.sort((a, b) => a.relative.localeCompare(b.relative));
  return files;
}

function fingerprint(
  profile: LocProfileId,
  files: CountedFile[],
): string {
  let bytes = 0;
  let mtime = 0;
  for (const file of files) {
    bytes += file.size;
    if (file.mtime > mtime) mtime = file.mtime;
  }
  return `${profile}:${files.length}:${bytes}:${mtime}`;
}

function partsFrom(
  files: CountedFile[],
  cores: Map<string, number>,
): LocPart[] | undefined {
  const mac = cores.get("mac") ?? 0;
  const firmware = cores.get("firmware") ?? 0;
  if (mac === 0 && firmware === 0 && !files.some((file) => file.part)) {
    return undefined;
  }
  const parts: LocPart[] = [];
  if (mac > 0) parts.push({ id: "mac", core: mac });
  if (firmware > 0) parts.push({ id: "firmware", core: firmware });
  return parts.length > 0 ? parts : undefined;
}

export async function countProject(
  name: string,
  root: string,
  previous?: LocCount,
  now: () => string = () => new Date().toISOString(),
  policy: LocPolicy = emptyLocPolicy(),
): Promise<LocCount | null> {
  if (skipProject(name, policy)) return null;
  const hints = await collectHints(root);
  const profile = detectProfile(name, hints, policy);
  if (profile === "skip") return null;
  const excluded = Object.hasOwn(policy.excludePaths, name)
    ? policy.excludePaths[name]
    : [];
  const files = await listCountedFiles(root, profile, excluded);
  const stamp = fingerprint(profile, files);
  if (
    previous &&
    previous.profile === profile &&
    previous.fingerprint === stamp
  ) {
    return previous;
  }
  let core = 0;
  let test = 0;
  const partCores = new Map<string, number>();
  for (const file of files) {
    let text = "";
    try {
      text = await Deno.readTextFile(file.absolute);
    } catch {
      continue;
    }
    const lines = countSourceLines(text, sourceStyle(file.relative));
    if (file.kind === "test") test += lines.code;
    else {
      core += lines.code;
      if (file.part) {
        partCores.set(file.part, (partCores.get(file.part) ?? 0) + lines.code);
      }
    }
  }
  return {
    name,
    profile,
    core,
    test,
    counted_at: now(),
    fingerprint: stamp,
    parts: partsFrom(files, partCores),
    files: files.map((file) => file.relative),
  };
}

export async function refreshLocCounts(
  projects: { name: string; path: string }[],
  previous: Map<string, LocCount>,
  options: { concurrency?: number; now?: () => string; policy?: LocPolicy } =
    {},
): Promise<{ counts: LocCount[]; drop: string[] }> {
  const concurrency = options.concurrency ?? 2;
  const now = options.now ?? (() => new Date().toISOString());
  const keep = new Set(projects.map((project) => project.name));
  const drop = [...previous.keys()].filter((name) => !keep.has(name));
  const counts: LocCount[] = [];
  await mapPool(projects, concurrency, async (project) => {
    try {
      const counted = await countProject(
        project.name,
        project.path,
        previous.get(project.name),
        now,
        options.policy,
      );
      if (counted) counts.push(counted);
      else drop.push(project.name);
    } catch {
      // Keep the last good count when a walk fails.
      const last = previous.get(project.name);
      if (last) counts.push(last);
    }
  });
  return { counts, drop };
}

async function mapPool<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  let next = 0;
  const worker = async () => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      await fn(items[index]);
    }
  };
  const workers = Math.min(Math.max(1, limit), items.length);
  await Promise.all(Array.from({ length: workers }, () => worker()));
}
