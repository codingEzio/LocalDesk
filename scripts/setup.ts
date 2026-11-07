import { dirname, join } from "node:path";
import { loadSettings, normalizeSettings } from "../backend/settings.ts";
import { dataDirectory, settingsOverride } from "../backend/runtime_paths.ts";

const root = dirname(import.meta.dirname!);
const names = new Set([
  "workspace",
  "projects",
  "model",
  "effort",
  "codex",
  "frontend-port",
  "backend-port",
]);
const args = new Map<string, string>();
if (Deno.args.includes("--help")) {
  console.log(
    "deno task setup [--workspace <existing-dir>] [--projects <existing-dir>] [--model <model> --effort <effort>] [--codex <executable>] [--frontend-port <port> --backend-port <port>]\nWrites private settings and empty default sources under the LocalDesk data directory outside source. Does not install, log in, scan private directories or run a model.",
  );
  Deno.exit(0);
}
for (let i = 0; i < Deno.args.length; i += 2) {
  const flag = Deno.args[i];
  const key = flag.startsWith("--") ? flag.slice(2) : "";
  const value = Deno.args[i + 1];
  if (!names.has(key) || !value || value.startsWith("--") || args.has(key)) {
    throw new Error(`Unknown, duplicate or missing argument: ${flag}`);
  }
  args.set(key, value);
}
const file = settingsOverride(root);
let existing: Record<string, unknown> = {};
try {
  existing = JSON.parse(await Deno.readTextFile(file));
} catch (e) {
  if (!(e instanceof Deno.errors.NotFound)) throw e;
}
const defaults = JSON.parse(
  await Deno.readTextFile(join(root, "config/settings.json")),
);
const next = { ...existing };
for (
  const [arg, setting] of [["workspace", "workspace"], [
    "projects",
    "projectsRoot",
  ], ["codex", "codexPath"]]
) {
  if (args.has(arg)) next[setting] = args.get(arg)!;
}
for (
  const [arg, setting] of [["frontend-port", "frontendPort"], [
    "backend-port",
    "backendPort",
  ]]
) {
  if (args.has(arg)) next[setting] = Number(args.get(arg));
}
if (args.has("model") !== args.has("effort")) {
  throw new Error("Specify --model and --effort together");
}
if (args.has("model")) {
  next.presets = [{
    name: "default",
    model: args.get("model"),
    effort: args.get("effort"),
    tier: "default",
  }];
  next.preset = "default";
}
const settings = await normalizeSettings({ ...defaults, ...next }, root);
for (
  const [key, fallback] of [["workspace", "workspace"], [
    "projectsRoot",
    "projects",
  ]] as const
) {
  const target = settings[key];
  if (target === join(dataDirectory(root), fallback)) {
    await Deno.mkdir(target, { recursive: true, mode: 0o700 });
  } else if (!(await Deno.stat(target)).isDirectory) {
    throw new Error(`${key} must be an existing directory`);
  }
}
// Create only the product's own blank workspace; never populate the user's selection.
if (settings.workspace === join(dataDirectory(root), "workspace")) {
  for (const name of ["config", "scripts", "skills", "services", "tools"]) {
    await Deno.mkdir(join(settings.workspace, name), {
      recursive: true,
      mode: 0o700,
    });
  }
  try {
    await Deno.writeTextFile(
      join(settings.workspace, "Brewfile"),
      "# Optional software declarations\n",
      { createNew: true, mode: 0o600 },
    );
  } catch (e) {
    if (!(e instanceof Deno.errors.AlreadyExists)) throw e;
  }
}
const temporary = file + ".tmp";
await Deno.mkdir(dirname(file), { recursive: true, mode: 0o700 });
await Deno.writeTextFile(temporary, JSON.stringify(next, null, 2) + "\n", {
  mode: 0o600,
});
await Deno.rename(temporary, file);
const readback = await loadSettings(root);
if (
  readback.workspace !== settings.workspace ||
  readback.frontendPort !== settings.frontendPort
) throw new Error("Settings readback mismatch");
console.log(
  `LocalDesk configured. Frontend ${settings.frontendPort}; API ${settings.backendPort}.`,
);
console.log(
  settings.presets.length
    ? "Configured model is checked against the local Codex catalog at startup."
    : "Browsing is ready. Model execution remains unavailable until explicitly configured.",
);
