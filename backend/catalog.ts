import { integrations } from "./integrations.ts";
import { Skills } from "./skills.ts";
import { join, relative, resolve } from "node:path";
import { atomicJson, loadJson, local, root, settings } from "./config.ts";
export type Item = {
  id: string;
  name: string;
  path: string;
  kind: string;
  detail: string;
  modified?: string;
};
export type Plugin = {
  id: string;
  version: number;
  order: number;
  kind: string;
  path: string;
  icon: string;
  title: Record<string, string>;
  enabled: boolean;
  items: Item[];
  error?: string;
};
export class Catalog {
  private skills = new Skills();
  plugins: Plugin[] = [];
  scannedAt: string | null = null;
  durationMs = 0;
  scanning = false;
  revision = 0;
  errors: string[] = [];
  preferences: Record<string, boolean> = {};
  private mutations: Promise<unknown> = Promise.resolve();
  async init() {
    this.preferences = await loadJson(join(local, "modules.json"), {});
    await this.scan();
  }
  enable(id: string, enabled: boolean) {
    const action = this.mutations.then(async () => {
      if (!this.plugins.some((p) => p.id === id)) {
        throw new Error("Unknown module");
      }
      const next = { ...this.preferences, [id]: enabled };
      await atomicJson(join(local, "modules.json"), next);
      this.preferences = next;
      const p = this.plugins.find((p) => p.id === id);
      if (p) p.enabled = enabled;
      this.revision++;
    });
    this.mutations = action.catch(() => {});
    return action;
  }
  view() {
    return {
      plugins: integrations.connected("workspace")
        ? this.plugins.filter((plugin) =>
          plugin.id !== "skills" || integrations.connected("projects")
        )
        : [],
      connected: integrations.connected("workspace"),
      scannedAt: this.scannedAt,
      durationMs: this.durationMs,
      scanning: this.scanning,
      revision: this.revision,
      errors: this.errors,
    };
  }
  async scan() {
    if (this.scanning || !integrations.connected("workspace")) return;
    this.scanning = true;
    const start = performance.now();
    try {
      await integrations.read("workspace", async () => {
        const next: Plugin[] = [];
        const errors: string[] = [];
        const ids = new Set<string>();
        for (const directory of settings.discoveryDirectories) {
          const dir = resolve(root, directory);
          if (relative(root, dir).startsWith("..")) {
            throw new Error("Plugin directory escapes project");
          }
          for await (const entry of Deno.readDir(dir)) {
            if (
              !entry.isFile || entry.isSymlink || !entry.name.endsWith(".json")
            ) continue;
            try {
              const raw = JSON.parse(
                await Deno.readTextFile(join(dir, entry.name)),
              );
              if (!/^[a-z][a-z0-9-]{0,40}$/.test(raw.id) || ids.has(raw.id)) {
                throw new Error("Invalid or duplicate module ID");
              }
              if (
                !["brewfile", "directories", "files"].includes(raw.kind) ||
                typeof raw.path !== "string" || !raw.title?.en ||
                raw.version !== 1
              ) throw new Error("Invalid module manifest");
              if (raw.id === "skills") {
                if (!integrations.connected("projects")) continue;
                const p: Plugin = {
                  ...raw,
                  enabled: this.preferences[raw.id] ?? raw.enabled !== false,
                  items: [],
                };
                ids.add(raw.id);
                try {
                  const view = await integrations.read(
                    "projects",
                    () => this.skills.list(true),
                  ) as {
                    source: string;
                    items: { folder: string; path: string; kind: string }[];
                  };
                  p.path = view.source;
                  p.items = view.items.map((item) => ({
                    id: "skills:" + item.folder,
                    name: item.folder,
                    path: item.path,
                    kind: item.kind === "link" ? "link" : "directory",
                    detail: item.path,
                  }));
                } catch (e) {
                  p.error = e instanceof Error ? e.message : String(e);
                }
                next.push(p);
                continue;
              }
              const target = resolve(settings.workspace, raw.path);
              const rel = relative(settings.workspace, target);
              if (
                rel.startsWith("..") || rel.startsWith("/") ||
                rel === "Local" ||
                rel.startsWith("Local/") || rel.startsWith(".git")
              ) {
                throw new Error(
                  "Source must stay in selected workspace configuration/source",
                );
              }
              const p: Plugin = {
                ...raw,
                enabled: this.preferences[raw.id] ?? raw.enabled !== false,
                items: [],
              };
              ids.add(raw.id);
              try {
                const real = await Deno.realPath(target);
                const resolved = relative(
                  await Deno.realPath(settings.workspace),
                  real,
                );
                if (
                  resolved.startsWith("..") || resolved === "Local" ||
                  resolved.startsWith("Local/") || resolved.startsWith(".git")
                ) {
                  throw new Error(
                    "Source symlink escapes the allowed workspace sources",
                  );
                }
                if (raw.kind === "brewfile") {
                  const text = await Deno.readTextFile(target);
                  for (const line of text.split("\n")) {
                    const m = line.match(/^\s*(brew|cask|tap|mas)\s+"([^"]+)"/);
                    if (m) {
                      p.items.push({
                        id: raw.id + ":" + m[1] + ":" + m[2],
                        name: m[2],
                        path: raw.path,
                        kind: m[1],
                        detail: "Brewfile",
                      });
                    }
                  }
                } else {
                  for await (const file of Deno.readDir(target)) {
                    if (
                      file.name.startsWith(".") || file.name === "AGENTS.md"
                    ) {
                      continue;
                    }
                    if (
                      raw.kind === "directories" && !file.isDirectory &&
                      !file.isSymlink
                    ) continue;
                    if (
                      raw.kind === "files" && !file.isFile && !file.isSymlink
                    ) {
                      continue;
                    }
                    const path = join(raw.path, file.name);
                    const stat = await Deno.lstat(
                      join(settings.workspace, path),
                    );
                    p.items.push({
                      id: raw.id + ":" + file.name,
                      name: file.name,
                      path,
                      kind: file.isSymlink
                        ? "link"
                        : file.isDirectory
                        ? "directory"
                        : "source",
                      detail: path,
                      modified: stat.mtime?.toISOString(),
                    });
                  }
                }
                p.items.sort((a, b) => a.name.localeCompare(b.name));
              } catch (e) {
                p.error = e instanceof Error ? e.message : String(e);
              }
              next.push(p);
            } catch (e) {
              errors.push(
                entry.name + ": " +
                  (e instanceof Error ? e.message : String(e)),
              );
            }
          }
        }
        for (const p of next) p.enabled = this.preferences[p.id] ?? p.enabled;
        this.plugins = next.sort((a, b) =>
          (a.order ?? 99) - (b.order ?? 99) || a.id.localeCompare(b.id)
        );
        this.errors = errors;
        this.scannedAt = new Date().toISOString();
        this.durationMs = performance.now() - start;
        this.revision++;
      });
    } catch (e) {
      this.errors = [e instanceof Error ? e.message : String(e)];
    } finally {
      this.scanning = false;
    }
  }
}
