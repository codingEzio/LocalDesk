import { isAbsolute, join, resolve } from "node:path";
import { dataDirectory, settingsOverride } from "./runtime_paths.ts";

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
};

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
