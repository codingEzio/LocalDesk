import { isAbsolute, join, resolve } from "node:path";
import { dataDirectory, settingsOverride } from "./runtime_paths.ts";

/** Invalid or absent interface choices never enable network access. */
export function normalizeLanInterfaces(value: unknown): string[] {
  if (value === undefined) return [];
  if (
    !Array.isArray(value) || value.length > 32 ||
    value.some((name) =>
      typeof name !== "string" || !/^[A-Za-z0-9_.-]{1,64}$/.test(name)
    ) || new Set(value).size !== value.length
  ) throw new Error("Invalid lanInterfaces");
  return value;
}

export const LOC_PROFILES = [
  "skip",
  "web-svelte",
  "deno-vanilla",
  "python-tool",
  "python-blog",
  "swift-spm",
  "safari-ext",
  "dual-extension",
  "sitekit",
  "hwstatus",
  "rust",
  "ios",
  "vscode-ext",
] as const;
export type LocProfileId = typeof LOC_PROFILES[number];
export type LocPolicy = {
  profiles: Record<string, LocProfileId>;
  skipProjects: string[];
  skipPrefixes: string[];
  excludePaths: Record<string, string[]>;
};
const emptyLocPolicy = (): LocPolicy => ({
  profiles: {},
  skipProjects: [],
  skipPrefixes: [],
  excludePaths: {},
});

export type ModelPreset = {
  name: string;
  model: string;
  effort: string;
  tier: "default" | "priority";
};
export type Settings = {
  workspace: string;
  projectsRoot: string;
  frontendPort: number;
  backendPort: number;
  frontendHost: string;
  shareCatalogOnLan: boolean;
  lanInterfaces: string[];
  sourcePaths: Record<string, string>;
  runtimeRegistry: string | null;
  codexPath: string;
  modelsFile: string;
  sessionArchiveDirectory: string;
  preset: string;
  presets: ModelPreset[];
  approvalMode: "sandbox" | "review";
  sessionOperationTimeoutMs: number;
  scanIntervalMs: number;
  maxQueuedJobs: number;
  maxPromptCharacters: number;
  maxJobMinutes: number;
  maxOutputBytes: number;
  discoveryDirectories: string[];
  projectScanIntervalMs: number;
  loc: LocPolicy;
};

function normalizeLocPolicy(input: unknown): LocPolicy {
  if (input === undefined) return emptyLocPolicy();
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Invalid loc settings");
  }
  const raw = input as Record<string, unknown>;
  const allowed = ["profiles", "skipProjects", "skipPrefixes", "excludePaths"];
  if (Object.keys(raw).some((key) => !allowed.includes(key))) {
    throw new Error("Invalid loc setting");
  }
  const record = (value: unknown): Record<string, unknown> => {
    if (value === undefined) return {};
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Invalid loc map");
    }
    return value as Record<string, unknown>;
  };
  const printable = (value: string) =>
    [...value].every((character) =>
      character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127
    );
  const validName = (value: unknown) =>
    typeof value === "string" && value.trim().length > 0 &&
    value.length <= 200 && !value.includes("/") && !value.includes("\\") &&
    printable(value) &&
    value !== "." && value !== "..";
  const list = (
    value: unknown,
    valid: (value: unknown) => boolean,
  ): string[] => {
    if (value === undefined) return [];
    if (
      !Array.isArray(value) || value.length > 1000 ||
      value.some((item) => !valid(item))
    ) {
      throw new Error("Invalid loc list");
    }
    return value as string[];
  };
  const profiles = record(raw.profiles);
  const paths = record(raw.excludePaths);
  if (Object.keys(profiles).length > 1000 || Object.keys(paths).length > 1000) {
    throw new Error("Invalid loc map");
  }
  for (const [name, profile] of Object.entries(profiles)) {
    if (
      !validName(name) || typeof profile !== "string" ||
      !(LOC_PROFILES as readonly string[]).includes(profile)
    ) {
      throw new Error("Invalid loc profile");
    }
  }
  const validPath = (value: unknown) =>
    typeof value === "string" && value.length <= 1024 &&
    value.length > 0 && !value.includes("\\") && printable(value) &&
    !value.startsWith("/") &&
    value.split("/").every((part) =>
      part !== "" && part !== "." && part !== ".."
    );
  for (const [name, prefixes] of Object.entries(paths)) {
    if (!validName(name)) throw new Error("Invalid loc project");
    list(prefixes, validPath);
  }
  return {
    profiles: profiles as LocPolicy["profiles"],
    skipProjects: list(raw.skipProjects, validName),
    skipPrefixes: list(raw.skipPrefixes, validName),
    excludePaths: paths as LocPolicy["excludePaths"],
  };
}

/** Relative paths, including an explicit override, are relative to this checkout. */
export async function loadSettings(root: string): Promise<Settings> {
  const defaults = JSON.parse(
    await Deno.readTextFile(join(root, "config/settings.json")),
  );
  const explicit = Deno.env.get("LOCALDESK_CONFIG");
  const override = settingsOverride(root);
  let local = {};
  try {
    local = JSON.parse(await Deno.readTextFile(override));
  } catch (error) {
    if (explicit || !(error instanceof Deno.errors.NotFound)) throw error;
  }
  return await normalizeSettings({ ...defaults, ...local }, root);
}

export async function normalizeSettings(
  input: Record<string, unknown>,
  root: string,
): Promise<Settings> {
  const value = { ...input };
  value.loc = normalizeLocPolicy(value.loc);
  value.lanInterfaces = normalizeLanInterfaces(value.lanInterfaces);
  if (value.sourcePaths === undefined) value.sourcePaths = {};
  if (
    !value.sourcePaths || typeof value.sourcePaths !== "object" ||
    Array.isArray(value.sourcePaths) ||
    Object.keys(value.sourcePaths).length > 100 ||
    Object.entries(value.sourcePaths).some(([id, path]) =>
      !/^[a-z][a-z0-9-]{0,40}$/.test(id) || id === "skills" ||
      typeof path !== "string" || !path || path.length > 1024 ||
      isAbsolute(path) || path.includes("\\") ||
      path.split("/").some((part) => part === ".." || part === "") ||
      [...path].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
    )
  ) throw new Error("Invalid sourcePaths: expected workspace-relative paths");
  function text(key: string): string {
    const result = value[key];
    if (typeof result !== "string" || !result.trim()) {
      throw new Error(`Invalid ${key}: expected nonempty text`);
    }
    return result;
  }
  for (
    const [key, max] of [
      ["frontendPort", 65535],
      ["backendPort", 65535],
      ["sessionOperationTimeoutMs", 300000],
      ["scanIntervalMs", 86400000],
      ["projectScanIntervalMs", 86400000],
      ["maxQueuedJobs", 100],
      ["maxPromptCharacters", 1000000],
      ["maxJobMinutes", 1440],
      ["maxOutputBytes", 16777216],
    ] as const
  ) {
    const n = value[key];
    if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 1 || n > max) {
      throw new Error(`Invalid ${key}: expected integer 1..${max}`);
    }
  }
  if (value.frontendPort === value.backendPort) {
    throw new Error("Frontend and backend ports must differ");
  }
  if (typeof value.shareCatalogOnLan !== "boolean") {
    throw new Error("Invalid shareCatalogOnLan");
  }
  if (!["sandbox", "review"].includes(text("approvalMode"))) {
    throw new Error("Invalid approvalMode");
  }
  if (!/^[a-zA-Z0-9:.%-]+$/.test(text("frontendHost"))) {
    throw new Error("Invalid frontendHost");
  }
  const home = Deno.env.get("HOME") || Deno.env.get("USERPROFILE");
  const codexHome = Deno.env.get("CODEX_HOME") ||
    (home ? join(home, ".codex") : null);
  function path(raw: string): string {
    if (raw.startsWith("~/")) {
      if (!home) {
        throw new Error("HOME or USERPROFILE is required for ~/ paths");
      }
      return resolve(home, raw.slice(2));
    }
    return resolve(root, raw);
  }
  for (const key of ["workspace", "projectsRoot"] as const) {
    value[key] = value[key] === null
      ? join(
        dataDirectory(root),
        key === "workspace" ? "workspace" : "projects",
      )
      : path(text(key));
  }
  for (
    const [key, suffix] of [["modelsFile", "models_cache.json"], [
      "sessionArchiveDirectory",
      "archived_sessions",
    ]] as const
  ) {
    if (value[key] === null) {
      if (!codexHome) {
        throw new Error(
          `Configure ${key} when the home directory is unavailable`,
        );
      }
      value[key] = path(join(codexHome, suffix));
    } else value[key] = path(text(key));
  }
  if (value.runtimeRegistry !== null) {
    value.runtimeRegistry = path(text("runtimeRegistry"));
  }
  const executable = text("codexPath");
  if (
    isAbsolute(executable) || executable.includes("/") ||
    executable.includes("\\")
  ) {
    value.codexPath = path(executable);
  } else {
    // An absent executable leaves browsing available; runner readiness reports the error.
    const directories = (Deno.env.get("PATH") || "").split(
      Deno.build.os === "windows" ? ";" : ":",
    );
    for (const directory of directories.filter(Boolean)) {
      const candidate = join(directory, executable);
      try {
        if ((await Deno.stat(candidate)).isFile) {
          value.codexPath = candidate;
          break;
        }
      } catch (e) {
        if (!(e instanceof Deno.errors.NotFound)) throw e;
      }
    }
  }
  if (!Array.isArray(value.presets)) {
    throw new Error("Invalid presets: expected an array");
  }
  const names = new Set<string>();
  for (const item of value.presets) {
    if (
      !item || typeof item !== "object" || typeof item.name !== "string" ||
      !/^[a-zA-Z0-9_-]+$/.test(item.name) || names.has(item.name) ||
      typeof item.model !== "string" ||
      !/^[a-zA-Z0-9_.:/-]+$/.test(item.model) ||
      typeof item.effort !== "string" ||
      !/^[a-zA-Z0-9_-]+$/.test(item.effort) ||
      !["default", "priority"].includes(item.tier)
    ) throw new Error("Invalid or duplicate model preset");
    names.add(item.name);
  }
  text("preset");
  if (value.presets.length && !names.has(value.preset as string)) {
    throw new Error("Default preset is missing from presets");
  }
  if (
    !Array.isArray(value.discoveryDirectories) ||
    value.discoveryDirectories.some((p) =>
      typeof p !== "string" || !p || isAbsolute(p) ||
      p.split(/[\\/]/).includes("..")
    )
  ) {
    throw new Error("Discovery directories must stay inside the checkout");
  }
  return value as unknown as Settings;
}
