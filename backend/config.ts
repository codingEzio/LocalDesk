import { loadSettings } from "./settings.ts";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { dataDirectory } from "./runtime_paths.ts";
export const root = dirname(dirname(fileURLToPath(import.meta.url)));
export const settings = await loadSettings(root);
export const local = dataDirectory(root);
await Deno.mkdir(local, { recursive: true, mode: 0o700 });
export const ports = {
  frontend: settings.frontendPort,
  backend: settings.backendPort,
};
export const json = (body: unknown, status = 200) =>
  Response.json(body, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
export async function atomicJson(path: string, value: unknown) {
  const tmp = path + ".tmp";
  await Deno.writeTextFile(tmp, JSON.stringify(value, null, 2) + "\n", {
    mode: 0o600,
  });
  await Deno.rename(tmp, path);
}
export async function loadJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await Deno.readTextFile(path));
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return fallback;
    throw e;
  }
}
export async function capability() {
  const path = join(local, "capability");
  try {
    return (await Deno.readTextFile(path)).trim();
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }
  const token = crypto.randomUUID() + crypto.randomUUID();
  try {
    await Deno.writeTextFile(path, token, { createNew: true, mode: 0o600 });
    return token;
  } catch (e) {
    if (e instanceof Deno.errors.AlreadyExists) {
      return (await Deno.readTextFile(path)).trim();
    }
    throw e;
  }
}
export type ExecutionChoice = { preset: string; effort: string; fast: boolean };
export type Execution = {
  name: string;
  model: string;
  effort: string;
  tier: string;
};
export async function executionOptions() {
  if (!settings.presets.length) {
    throw new Error(
      "No model configured. Run deno task setup --model <model> --effort <effort> after signing in to Codex CLI.",
    );
  }
  const cache = JSON.parse(await Deno.readTextFile(settings.modelsFile));
  if (!Array.isArray(cache.models)) {
    throw new Error("Invalid Codex model catalog");
  }
  const presets = settings.presets.flatMap((m) => {
    const model = cache.models.find((x: { slug: string; visibility: string }) =>
      x.slug === m.model && x.visibility === "list"
    );
    if (!model) return [];
    return [{
      name: m.name,
      model: m.model,
      effort: m.effort,
      tier: m.tier,
      efforts: model.supported_reasoning_levels.map((x: { effort: string }) =>
        x.effort
      ),
      fastAvailable: model.service_tiers?.some((x: { id: string }) =>
        x.id === "priority"
      ) ?? false,
    }];
  });
  if (!presets.length) {
    throw new Error(
      "No configured presets match the signed-in Codex model catalog",
    );
  }
  return {
    presets,
    defaultPreset: settings.preset,
    catalogUpdatedAt: cache.fetched_at,
  };
}
export async function resolveExecution(
  choice?: ExecutionChoice,
): Promise<Execution> {
  const { presets } = await executionOptions();
  const p = presets.find((p) => p.name === (choice?.preset ?? settings.preset));
  if (!p) throw new Error("Unknown or unavailable model preset");
  const effort = choice?.effort ?? p.effort;
  if (!p.efforts.includes(effort)) {
    throw new Error("Reasoning effort is not supported by this model");
  }
  if (choice && typeof choice.fast !== "boolean") {
    throw new Error("Fast must be a boolean");
  }
  const fast = choice?.fast ?? p.tier === "priority";
  if (fast && !p.fastAvailable) {
    throw new Error("Fast is not available for this model");
  }
  return {
    name: p.name,
    model: p.model,
    effort,
    tier: fast ? "priority" : "default",
  };
}
export async function preset() {
  return await resolveExecution();
}
