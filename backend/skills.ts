import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { parse, stringify } from "@std/yaml";
import { local, root, settings } from "./config.ts";
type Dict = Record<string, unknown>;
type Category = { id: string; title: Record<string, string> };
type Categories = {
  version: number;
  categories: Category[];
  assignments: Record<string, string>;
};
type Edit = {
  path: string;
  before: string;
  after: string;
  hash: string;
  mode: number;
  required: boolean;
  matches: number;
  existed?: boolean;
  kind?: "link";
  group?: string;
  selected?: boolean;
};
type Plan = {
  id: string;
  at: number;
  folder: string;
  name: string;
  source: string;
  destination: string;
  edits: Edit[];
  status: string;
  refs: string[];
  fingerprint?: string;
};
const validName = (s: unknown): s is string =>
  typeof s === "string" && s.length <= 64 &&
  /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s);
const digest = async (s: string) =>
  [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)),
    ),
  ].map((b) => b.toString(16).padStart(2, "0")).join("");
const exists = async (p: string) => {
  try {
    await Deno.lstat(p);
    return true;
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return false;
    throw e;
  }
};
const inside = (base: string, p: string) => {
  const r = relative(base, p);
  return r === "" || (!r.startsWith("..") && !isAbsolute(r));
};
async function readJson<T>(p: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await Deno.readTextFile(p));
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return fallback;
    throw e;
  }
}
async function atomic(p: string, s: string, mode = 0o600) {
  const tmp = p + ".skill-" + crypto.randomUUID();
  try {
    await Deno.writeTextFile(tmp, s, { createNew: true, mode });
    await Deno.chmod(tmp, mode & 0o777);
    const f = await Deno.open(tmp, { write: true });
    try {
      await f.sync();
    } finally {
      f.close();
    }
    await Deno.rename(tmp, p);
  } finally {
    if (await exists(tmp)) await Deno.remove(tmp);
  }
}
function document(s: string) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(s);
  if (!m) throw Error("Missing YAML frontmatter");
  const data = parse(m[1]) as Dict;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw Error("Invalid skill frontmatter");
  }
  return { data, body: s.slice(m[0].length) };
}
function replaceName(text: string, old: string, name: string) {
  return text.replace(
    new RegExp(`(?<![A-Za-z0-9-])${old}(?![A-Za-z0-9-])`, "g"),
    name,
  );
}
const skip = new Set([
  ".git",
  ".worktrees",
  ".runtime",
  "Local",
  "Data",
  "data",
  "Archived",
  "_abandoned",
  "node_modules",
  "dist",
  "build",
  "vendor",
  ".cache",
  ".skill-manager.lock",
]);
const extensions =
  /\.(md|yaml|yml|json|toml|ts|tsx|svelte|sh|zsh|swift|py|rb)$/;
export class Skills {
  private busy = false;
  private cache: { at: number; value: unknown } | null = null;
  async config() {
    const limits = JSON.parse(
      await Deno.readTextFile(join(root, "config/skill_management.json")),
    );
    const limitKeys = [
      "maxScanFiles",
      "maxScanBytes",
      "maxFileBytes",
      "maxChangedFiles",
      "maxPlanBytes",
      "maxRetainedPlans",
      "previewTtlMs",
    ];
    if (
      !limits || typeof limits !== "object" ||
      Object.keys(limits).length !== limitKeys.length ||
      limitKeys.some((key) =>
        !Number.isSafeInteger(limits[key]) || limits[key] < 1
      )
    ) throw Error("Invalid skill management limits");
    const plugin = await readJson(join(root, "plugins/skills.json"), {
      path: "skills",
    });
    const override = await readJson<
      { skillsRoot?: string; referenceRoots?: string[] }
    >(join(local, "skills.local.json"), {});
    const source = resolve(
      settings.workspace,
      override.skillsRoot ?? plugin.path,
    );
    const refs = override.referenceRoots ?? [settings.workspace];
    if (
      !Array.isArray(refs) || refs.length > 16 ||
      refs.some((p) => typeof p !== "string" || !isAbsolute(p))
    ) throw Error("Invalid skill reference roots");
    return {
      source,
      limits,
      refs: [...new Set([...refs, source])].map((p) => resolve(p)),
    };
  }
  async categories(source: string) {
    const defaults = await readJson<Categories>(
      join(root, "config/skill_categories.json"),
      { version: 1, categories: [], assignments: {} },
    );
    const path = join(source, ".skill-categories.json");
    const text = await exists(path) ? await Deno.readTextFile(path) : "";
    const value: Categories = text ? JSON.parse(text) : defaults;
    if (
      value.version !== 1 || !Array.isArray(value.categories) ||
      !value.assignments
    ) throw Error("Invalid category store");
    return { path, text, value, revision: await digest(text) };
  }
  async list(fresh = false) {
    if (!fresh && this.cache && Date.now() - this.cache.at < 4000) {
      return this.cache.value;
    }
    const config = await this.config();
    const state = await this.categories(config.source);
    const items = [];
    if (await exists(config.source)) {
      for await (const entry of Deno.readDir(config.source)) {
        if (
          entry.name.startsWith(".") || (!entry.isDirectory && !entry.isSymlink)
        ) {
          continue;
        }
        const dir = join(config.source, entry.name);
        try {
          const text = await Deno.readTextFile(join(dir, "SKILL.md"));
          if (text.length > 262144) throw Error("SKILL.md exceeds 256 KiB");
          const doc = document(text);
          const ui = await exists(join(dir, "agents/openai.yaml"))
            ? parse(await Deno.readTextFile(join(dir, "agents/openai.yaml")))
            : null;
          const editable = !entry.isSymlink && doc.data.name === entry.name &&
            validName(doc.data.name);
          items.push({
            folder: entry.name,
            name: doc.data.name,
            description: typeof doc.data.description === "string"
              ? doc.data.description
              : "",
            revision: await digest(text),
            category: state.value.assignments[entry.name] ?? "uncategorized",
            path: dir,
            target: await Deno.realPath(dir),
            editable,
            kind: entry.isSymlink ? "link" : "source",
            ui,
          });
        } catch (e) {
          items.push({
            folder: entry.name,
            name: entry.name,
            description: "",
            category: state.value.assignments[entry.name] ?? "uncategorized",
            path: dir,
            editable: false,
            kind: "error",
            error: String(e),
          });
        }
      }
    }
    const pending = await readJson<Plan | null>(
      join(local, "skill-management/pending.json"),
      null,
    );
    const lockOwner = await readJson<{ id: string; app: string } | null>(
      join(config.source, ".skill-manager.lock"),
      null,
    );
    const value = {
      source: config.source,
      referenceRoots: config.refs,
      categories: state.value.categories,
      revision: state.revision,
      items: items.sort((a, b) => a.folder.localeCompare(b.folder)),
      pending: lockOwner
        ? { id: lockOwner.id, status: "locked", app: lockOwner.app }
        : pending && !["committed", "rolled_back"].includes(pending.status)
        ? { id: pending.id, status: pending.status }
        : null,
    };
    this.cache = { at: Date.now(), value };
    return value;
  }
  private async putPlan(plan: Plan) {
    await Deno.mkdir(join(local, "skill-management"), {
      recursive: true,
      mode: 0o700,
    });
    const path = join(local, "skill-management", plan.id + ".json");
    if (!await exists(path)) {
      const records = [];
      const pending = await readJson<Plan | null>(
        join(local, "skill-management/pending.json"),
        null,
      );
      for await (const e of Deno.readDir(join(local, "skill-management"))) {
        if (
          /^[a-f0-9-]{36}\.json$/.test(e.name) &&
          !(pending && !["committed", "rolled_back"].includes(pending.status) &&
            e.name === pending.id + ".json")
        ) {
          const p = join(local, "skill-management", e.name);
          const st = await Deno.lstat(p);
          if (st.isFile && !st.isSymlink) {
            records.push({ p, time: st.mtime?.getTime() ?? 0 });
          }
        }
      }
      records.sort((a, b) => a.time - b.time);
      while (records.length >= (await this.config()).limits.maxRetainedPlans) {
        await Deno.remove(records.shift()!.p);
      }
    }
    await atomic(path, JSON.stringify(plan));
  }
  private async edit(
    path: string,
    after: string,
    required = true,
    matches = 1,
  ): Promise<Edit> {
    const before = await exists(path) ? await Deno.readTextFile(path) : "";
    const st = await exists(path) ? await Deno.lstat(path) : null;
    if (st?.isSymlink) throw Error("Refusing symlink file: " + path);
    return {
      path,
      before,
      after,
      hash: await digest(before),
      mode: st?.mode ?? 0o600,
      required,
      matches,
      existed: !!st,
    };
  }
  async preview(input: Dict) {
    const config = await this.config();
    const { folder, name, description, category } = input;
    if (
      !validName(folder) || !validName(name) ||
      typeof description !== "string" || !description.trim() ||
      description.length > 4096 || typeof category !== "string"
    ) throw Error("Invalid skill fields");
    const source = await Deno.realPath(config.source);
    const from = join(source, folder);
    const to = join(source, name);
    const stat = await Deno.lstat(from);
    if (!stat.isDirectory || stat.isSymlink) {
      throw Error("Linked skills are read-only");
    }
    if (name !== folder && await exists(to)) {
      throw Error("Destination already exists");
    }
    for await (const e of Deno.readDir(source)) {
      if (e.name.toLowerCase() === name.toLowerCase() && e.name !== folder) {
        throw Error("Case-insensitive name collision");
      }
    }
    const file = join(from, "SKILL.md");
    const text = await Deno.readTextFile(file);
    const doc = document(text);
    if (input.expected !== await digest(text)) {
      throw Error("Skill changed since opening; refresh and select it again");
    }
    if (doc.data.name !== folder) {
      throw Error("Folder and YAML name differ; resolve before editing");
    }
    const state = await this.categories(source);
    if (!state.value.categories.some((c) => c.id === category)) {
      throw Error("Unknown category");
    }
    doc.data.name = name;
    doc.data.description = description.trim();
    const next =
      folder === name && document(text).data.description === description.trim()
        ? text
        : "---\n" + stringify(doc.data) + "---\n" +
          replaceName(doc.body, folder, name);
    const edits = [await this.edit(file, next)];
    const uiPath = join(from, "agents/openai.yaml");
    if (await exists(uiPath)) {
      const uiText = await Deno.readTextFile(uiPath);
      const ui = parse(uiText) as Dict;
      const uiBefore = JSON.stringify(ui);
      if (ui.interface && typeof ui.interface === "object") {
        const iface = ui.interface as Dict;
        if (typeof iface.default_prompt === "string") {
          iface.default_prompt = replaceName(
            iface.default_prompt,
            folder,
            name,
          );
        }
      }
      if (JSON.stringify(ui) !== uiBefore) {
        edits.push(await this.edit(uiPath, stringify(ui)));
      }
    }
    delete state.value.assignments[folder];
    state.value.assignments[name] = category;
    edits.push(
      await this.edit(state.path, JSON.stringify(state.value, null, 2) + "\n"),
    );
    const fingerprint = name !== folder
      ? await this.referenceFingerprint(config.refs, config.limits.maxScanFiles)
      : undefined;
    if (name !== folder) {
      const seen = new Set<string>();
      const locks = new Set<string>();
      let files = 0, bytes = 0;
      const visit = async (dir: string): Promise<void> => {
        for await (const e of Deno.readDir(dir)) {
          if (
            skip.has(e.name) || e.name.startsWith(".") ||
            e.name.endsWith("-frontend-release")
          ) continue;
          const p = join(dir, e.name);
          if (e.isSymlink) continue;
          if (e.isDirectory) {
            await visit(p);
            continue;
          }
          if (e.name === "dependencies.lock.json") locks.add(p);
          if (
            !e.isFile || !extensions.test(e.name) || seen.has(p) ||
            /credential|secret|token|password/i.test(e.name)
          ) continue;
          seen.add(p);
          if (++files > config.limits.maxScanFiles) {
            throw Error(
              "Reference scan exceeds 30,000 files; narrow reference roots",
            );
          }
          const st = await Deno.lstat(p);
          if (st.size > config.limits.maxFileBytes) continue;
          bytes += st.size;
          if (bytes > config.limits.maxScanBytes) {
            throw Error(
              "Reference scan exceeds 128 MiB; narrow reference roots",
            );
          }
          if (edits.some((x) => x.path === p)) continue;
          const before = await Deno.readTextFile(p);
          if (before.includes("\0")) continue;
          const after = replaceName(before, folder, name);
          if (after === before) continue;
          // Bare product IDs remain visible, but are not selected as skill references.
          const recognized = inside(from, p) ||
            (!["TASKS.md", "PROJECT_RECORD.md", "CHANGELOG.md"].includes(
              e.name,
            ) &&
              (before.includes("$" + folder) ||
                before.includes("`" + folder + "`") ||
                before.includes("/" + folder + "/SKILL.md") ||
                before.split("\n").some((line) =>
                  line.includes(folder) &&
                  /skill|技能/i.test(replaceName(line, folder, ""))
                )));
          const edit = await this.edit(p, after, inside(from, p));
          edit.matches = before.split(folder).length - 1;
          edits.push({
            ...edit,
            required: inside(from, p),
            ...{ selected: recognized },
          });
          if (edits.length > config.limits.maxChangedFiles) {
            throw Error(
              "Reference plan exceeds 256 files; narrow reference roots",
            );
          }
        }
      };
      for (const dir of config.refs) {
        if (await exists(dir)) await visit(await Deno.realPath(dir));
      }
      // Generated documentation and its pinned hashes form one selectable group.
      for (const path of locks) {
        const before = await Deno.readTextFile(path);
        let lock: {
          files?: {
            path: string;
            sha256: string;
            owner?: string;
            source?: string;
          }[];
        };
        try {
          lock = JSON.parse(before);
        } catch {
          continue;
        }
        if (!Array.isArray(lock.files)) continue;
        let changed = false;
        for (const f of lock.files) {
          if (typeof f.path !== "string" || typeof f.sha256 !== "string") {
            continue;
          }
          const target = resolve(dirname(path), f.path);
          if (!inside(dirname(path), target)) {
            throw Error("Pinned path escapes repository");
          }
          const edit = edits.find((e) => e.path === target);
          if (!edit) continue;
          if (await digest(edit.before) !== f.sha256) {
            throw Error(
              "Pinned document drift; synchronize before rename: " + target,
            );
          }
          if (f.owner && f.source) {
            const siblingOwner = resolve(dirname(dirname(path)), f.owner);
            const ownerRoot = config.refs.find((p) =>
              basename(p) === f.owner
            ) ?? (config.refs.some((p) => inside(p, siblingOwner))
              ? siblingOwner
              : undefined);
            if (!ownerRoot) {
              throw Error(
                "Include the generated document owner in reference roots: " +
                  f.owner,
              );
            }
            const ownerPath = resolve(ownerRoot, f.source);
            if (!inside(ownerRoot, ownerPath)) {
              throw Error("Pinned source escapes its owner");
            }
            const ownerEdit = edits.find((e) => e.path === ownerPath);
            if (
              !ownerEdit || ownerEdit.before !== edit.before ||
              ownerEdit.after !== edit.after
            ) {
              throw Error(
                "Generated document differs from its owner; synchronize before rename: " +
                  edit.path,
              );
            }
            ownerEdit.group = "pinned-documents";
          }
          f.sha256 = await digest(edit.after);
          edit.group = "pinned-documents";
          changed = true;
        }
        if (changed) {
          if (edits.some((e) => e.path === path)) {
            throw Error(
              "Pinned path changes require the owning project's dependency sync: " +
                path,
            );
          }
          const edit = await this.edit(
            path,
            JSON.stringify(lock, null, 2) + "\n",
            false,
          );
          edit.group = "pinned-documents";
          edit.selected = true;
          edits.push(edit);
        }
      }
      // Rewrite directory aliases as part of the same recoverable operation.
      for await (const e of Deno.readDir(source)) {
        if (e.isSymlink) {
          const p = join(source, e.name);
          const target = await Deno.readLink(p);
          if (inside(from, resolve(source, target))) {
            edits.push({
              path: p,
              before: target,
              after: relative(
                dirname(p),
                join(to, relative(from, resolve(source, target))),
              ),
              hash: await digest(target),
              mode: 0o777,
              required: true,
              matches: 1,
              existed: true,
              kind: "link",
            });
          }
        }
      }
    }
    if (
      fingerprint &&
      fingerprint !==
        await this.referenceFingerprint(config.refs, config.limits.maxScanFiles)
    ) throw Error("Reference scope changed during preview; preview again");
    const grouped = edits.filter((e) => e.group === "pinned-documents");
    if (grouped.some((e) => e.selected !== false)) {
      for (const e of grouped) e.selected = true;
    }
    if (name !== folder) {
      for (const edit of edits) {
        if (edit.kind || !edit.path.endsWith(".md")) continue;
        const original = new Set(
          [...edit.before.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)].map((m) => m[1]),
        );
        for (const match of edit.after.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
          let target = match[1];
          if (original.has(target)) continue;
          target = target.replace(/^<|>$/g, "").split("#")[0];
          if (
            !target || /^[a-z]+:/i.test(target) || target.includes("<") ||
            target.includes(" ")
          ) continue;
          const parent = inside(from, edit.path)
            ? join(to, relative(from, dirname(edit.path)))
            : dirname(edit.path);
          let path = resolve(parent, decodeURIComponent(target));
          if (inside(to, path)) path = join(from, relative(to, path));
          if (!await exists(path)) {
            throw Error("Updated local link would be missing: " + target);
          }
        }
      }
    }
    const plan: Plan = {
      id: crypto.randomUUID(),
      at: Date.now(),
      folder,
      name,
      source,
      destination: to,
      edits: edits.filter((e) => e.before !== e.after),
      status: "preview",
      refs: config.refs,
      fingerprint,
    };
    if (plan.edits.length > config.limits.maxChangedFiles) {
      throw Error("Reference plan exceeds configured file limit");
    }
    if (
      plan.edits.reduce((n, e) => n + e.before.length + e.after.length, 0) >
        16 * 1024 * 1024
    ) throw Error("Preview exceeds 16 MiB");
    await this.putPlan(plan);
    return {
      id: plan.id,
      folder,
      name,
      renamed: name !== folder,
      files: plan.edits.map((e, i) => ({
        index: i,
        path: e.path,
        required: e.required,
        selected: e.required ||
          (e as Edit & { selected?: boolean }).selected !== false,
        matches: e.matches,
        group: e.group,
        before: e.before,
        after: e.after,
      })),
      expiresAt: plan.at + config.limits.previewTtlMs,
    };
  }
  private async lock(source: string, id: string, fn: () => Promise<unknown>) {
    if (this.busy) throw Error("Another skill operation is running");
    this.busy = true;
    const path = join(source, ".skill-manager.lock");
    let owned = false;
    try {
      await Deno.writeTextFile(
        path,
        JSON.stringify({ pid: Deno.pid, app: root, id }),
        { createNew: true, mode: 0o600 },
      );
      owned = true;
      return await fn();
    } finally {
      try {
        if (owned) {
          const pending = await readJson<Plan | null>(
            join(local, "skill-management/pending.json"),
            null,
          );
          if (
            !pending || pending.id !== id ||
            ["committed", "rolled_back"].includes(pending.status)
          ) await Deno.remove(path);
        }
      } finally {
        this.busy = false;
        this.cache = null;
      }
    }
  }
  private mapped(plan: Plan, path: string) {
    const old = join(plan.source, plan.folder);
    return inside(old, path)
      ? join(plan.destination, relative(old, path))
      : path;
  }
  private async persistPending(plan: Plan) {
    await atomic(
      join(local, "skill-management/pending.json"),
      JSON.stringify(plan),
    );
  }
  async apply(id: unknown, selection: unknown) {
    if (
      typeof id !== "string" || !validName(id) || !Array.isArray(selection) ||
      selection.some((n) => !Number.isInteger(n))
    ) throw Error("Invalid preview selection");
    const plan = await readJson<Plan | null>(
      join(local, "skill-management", id + ".json"),
      null,
    );
    const policy = (await this.config()).limits;
    if (
      !plan || plan.status !== "preview" ||
      Date.now() - plan.at > policy.previewTtlMs
    ) {
      throw Error("Preview expired; preview again");
    }
    const conf = await this.config();
    if (await Deno.realPath(conf.source) !== plan.source) {
      throw Error("Skill source changed");
    }
    if (JSON.stringify(conf.refs) !== JSON.stringify(plan.refs)) {
      throw Error("Reference roots changed; preview again");
    }
    const selected = new Set(selection);
    const linked = plan.edits.map((e, i) => ({ e, i })).filter((x) =>
      x.e.group === "pinned-documents"
    );
    if (
      linked.some((x) => selected.has(x.i)) &&
      !linked.every((x) => selected.has(x.i))
    ) throw Error("Select or exclude the complete pinned-document group");
    if (selection.some((n) => n < 0 || n >= plan.edits.length)) {
      throw Error("Invalid file selection");
    }
    plan.edits = plan.edits.filter((e, i) => e.required || selected.has(i));
    return await this.lock(plan.source, plan.id, async () => {
      const pending = await readJson<Plan | null>(
        join(local, "skill-management/pending.json"),
        null,
      );
      if (pending && !["committed", "rolled_back"].includes(pending.status)) {
        throw Error("Recover the pending skill operation first");
      }
      if (
        plan.fingerprint &&
        plan.fingerprint !==
          await this.referenceFingerprint(conf.refs, conf.limits.maxScanFiles)
      ) throw Error("Reference scope changed; preview again");
      const old = join(plan.source, plan.folder);
      if ((await Deno.lstat(old)).isSymlink) {
        throw Error("Source became a link");
      }
      if (plan.folder !== plan.name && await exists(plan.destination)) {
        throw Error("Destination already exists");
      }
      for await (const entry of Deno.readDir(plan.source)) {
        if (
          plan.folder !== plan.name && entry.name !== plan.folder &&
          entry.name.toLowerCase() === plan.name.toLowerCase()
        ) throw Error("Case-insensitive destination conflict");
      }
      for (const e of plan.edits) {
        const st = await exists(e.path) ? await Deno.lstat(e.path) : null;
        if (!!st !== !!e.existed) {
          throw Error("Reference existence changed; preview again");
        }
        if (st?.isSymlink && e.kind !== "link") {
          throw Error("Reference became a link");
        }
        if (await Deno.realPath(dirname(e.path)) !== dirname(e.path)) {
          throw Error("Reference parent became a link");
        }
        const current = st
          ? e.kind === "link"
            ? await Deno.readLink(e.path)
            : await Deno.readTextFile(e.path)
          : "";
        if (await digest(current) !== e.hash) {
          throw Error("File changed; preview again: " + e.path);
        }
      }
      plan.status = "writing";
      await this.putPlan(plan);
      await this.persistPending(plan);
      try {
        if (plan.folder !== plan.name) await Deno.rename(old, plan.destination);
        for (const e of plan.edits) {
          const path = this.mapped(plan, e.path);
          const current = await exists(path)
            ? await this.readEdit(e, path)
            : "";
          if (await digest(current) !== e.hash) {
            throw Error("File changed during apply; recovery required");
          }
          if (await Deno.realPath(dirname(path)) !== dirname(path)) {
            throw Error("Reference parent changed");
          }
          await this.writeEdit(e, path, e.after);
        }
        for (const e of plan.edits) {
          if (await this.readEdit(e, this.mapped(plan, e.path)) !== e.after) {
            throw Error("Readback mismatch");
          }
        }
        plan.status = "committed";
        await this.persistPending(plan);
        await this.putPlan(plan);
        return {
          ok: true,
          id: plan.id,
          name: plan.name,
          files: plan.edits.length,
          status: plan.status,
        };
      } catch (e) {
        try {
          await this.rollback(plan);
        } catch (recovery) {
          throw Error(String(e) + "; recovery required: " + String(recovery));
        }
        throw e;
      }
    });
  }
  private async readEdit(edit: Edit, path: string) {
    return edit.kind === "link"
      ? await Deno.readLink(path)
      : await Deno.readTextFile(path);
  }
  private async writeEdit(edit: Edit, path: string, text: string) {
    if (edit.kind !== "link") return await atomic(path, text, edit.mode);
    const tmp = path + ".skill-" + crypto.randomUUID();
    try {
      await Deno.symlink(text, tmp);
      await Deno.rename(tmp, path);
    } finally {
      if (await exists(tmp)) await Deno.remove(tmp);
    }
  }
  private async rollback(plan: Plan) {
    if (
      plan.folder !== plan.name && await exists(plan.destination) &&
      await exists(join(plan.source, plan.folder))
    ) {
      throw Error(
        "Both rename paths exist; resolve the conflict before recovery",
      );
    }
    const moved = plan.folder !== plan.name && await exists(plan.destination) &&
      !await exists(join(plan.source, plan.folder));
    for (const e of [...plan.edits].reverse()) {
      const p = moved ? this.mapped(plan, e.path) : e.path;
      const current = await exists(p) ? await this.readEdit(e, p) : "";
      if (current === e.before) continue;
      if (current !== e.after) {
        throw Error("Concurrent edit preserved; manual recovery: " + p);
      }
      if (!e.existed) await Deno.remove(p);
      else await this.writeEdit(e, p, e.before);
    }
    if (moved) {
      await Deno.rename(plan.destination, join(plan.source, plan.folder));
    }
    plan.status = "rolled_back";
    await this.persistPending(plan);
    await this.putPlan(plan);
  }
  async recover() {
    if (this.busy) throw Error("Operation still running");
    const conf = await this.config();
    const source = await Deno.realPath(conf.source);
    const lock = join(source, ".skill-manager.lock");
    const owner = await readJson<
      { pid: number; app: string; id: string } | null
    >(lock, null);
    let plan = await readJson<Plan | null>(
      join(local, "skill-management/pending.json"),
      null,
    );
    if (owner) {
      if (
        owner.app !== root || !validName(owner.id) ||
        !Number.isSafeInteger(owner.pid) || owner.pid < 1
      ) throw Error("Lock belongs to another application; recover there");
      let alive = true;
      try {
        Deno.kill(owner.pid, 0);
      } catch (e) {
        if (e instanceof Deno.errors.NotFound) alive = false;
        else throw e;
      }
      if (alive && owner.pid !== Deno.pid) {
        throw Error("Lock owner is still running");
      }
      plan = await readJson<Plan | null>(
        join(local, "skill-management", owner.id + ".json"),
        null,
      );
      // No plan means failure before preparation; a completed plan only needs its stale lock cleared.
      if (!plan || ["committed", "rolled_back"].includes(plan.status)) {
        await Deno.remove(lock);
        this.cache = null;
        return { ok: true, status: "lock_recovered" };
      }
      if (plan.source !== source) throw Error("Recovery source differs");
      await Deno.remove(lock);
    }
    if (!plan || ["committed", "rolled_back"].includes(plan.status)) {
      throw Error("No pending recovery");
    }
    if (plan.source !== source) throw Error("Recovery source differs");
    const recoverPlan = plan;
    return await this.lock(source, plan.id, async () => {
      await this.rollback(recoverPlan);
      return { ok: true, status: recoverPlan.status };
    });
  }
  private async referenceFingerprint(roots: string[], maxFiles: number) {
    const records: string[] = [];
    const seen = new Set<string>();
    const visit = async (dir: string): Promise<void> => {
      for await (const e of Deno.readDir(dir)) {
        if (
          skip.has(e.name) || e.name.startsWith(".") ||
          e.name.endsWith("-frontend-release")
        ) continue;
        const p = join(dir, e.name);
        if (e.isSymlink) {
          if (!seen.has(p)) {
            seen.add(p);
            if (seen.size > maxFiles) {
              throw Error("Reference scope too large; narrow reference roots");
            }
            records.push(p + ":link:" + await Deno.readLink(p));
          }
          continue;
        }
        if (e.isDirectory) {
          await visit(p);
          continue;
        }
        if (
          !e.isFile || !extensions.test(e.name) || seen.has(p) ||
          /credential|secret|token|password/i.test(e.name)
        ) continue;
        seen.add(p);
        if (seen.size > maxFiles) {
          throw Error("Reference scope too large; narrow reference roots");
        }
        const st = await Deno.lstat(p);
        records.push(p + ":" + st.size + ":" + st.mtime?.getTime());
      }
    };
    for (const path of roots) {
      if (await exists(path)) await visit(await Deno.realPath(path));
    }
    return await digest(records.sort().join("\n"));
  }
  async assign(input: Dict) {
    if (!validName(input.folder) || typeof input.category !== "string") {
      throw Error("Invalid category assignment");
    }
    const conf = await this.config();
    const state = await this.categories(conf.source);
    if (input.revision !== state.revision) {
      throw Error("Categories changed; refresh first");
    }
    if (!state.value.categories.some((c) => c.id === input.category)) {
      throw Error("Unknown category");
    }
    await Deno.lstat(join(conf.source, input.folder));
    return await this.lock(conf.source, crypto.randomUUID(), async () => {
      const pending = await readJson<Plan | null>(
        join(local, "skill-management/pending.json"),
        null,
      );
      if (pending && !(["committed", "rolled_back"].includes(pending.status))) {
        throw Error("Recover pending changes first");
      }
      const current = await this.categories(conf.source);
      if (current.revision !== state.revision) {
        throw Error("Categories changed; refresh first");
      }
      state.value.assignments[input.folder as string] = input
        .category as string;
      const text = JSON.stringify(state.value, null, 2) + "\n";
      await atomic(state.path, text);
      if (await Deno.readTextFile(state.path) !== text) {
        throw Error("Category readback mismatch");
      }
      return { ok: true };
    });
  }
  async saveCategories(input: Dict) {
    const conf = await this.config();
    const state = await this.categories(conf.source);
    if (input.revision !== state.revision) {
      throw Error("Categories changed; refresh first");
    }
    const cats = input.categories as Category[];
    if (
      !Array.isArray(cats) || !cats.length || cats.length > 64 ||
      cats.some((c) =>
        !validName(c.id) || !c.title ||
        ["en", "zh-CN", "zh-TW"].some((l) =>
          typeof c.title[l] !== "string" || !c.title[l].trim() ||
          c.title[l].length > 100
        )
      ) || new Set(cats.map((c) => c.id)).size !== cats.length ||
      !cats.some((c) => c.id === "uncategorized")
    ) throw Error("Invalid categories");
    const listing = await this.list(true) as { items: { category: string }[] };
    if (listing.items.some((i) => !cats.some((c) => c.id === i.category))) {
      throw Error("Move skills out of a category before removing it");
    }
    return await this.lock(conf.source, crypto.randomUUID(), async () => {
      const pending = await readJson<Plan | null>(
        join(local, "skill-management/pending.json"),
        null,
      );
      if (pending && !(["committed", "rolled_back"].includes(pending.status))) {
        throw Error("Recover the pending operation first");
      }
      const current = await this.categories(conf.source);
      if (current.revision !== state.revision) {
        throw Error("Categories changed; refresh first");
      }
      const value = {
        ...state.value,
        categories: cats,
        assignments: Object.fromEntries(
          Object.entries(state.value.assignments).map((
            [name, id],
          ) => [name, cats.some((c) => c.id === id) ? id : "uncategorized"]),
        ),
      };
      const text = JSON.stringify(value, null, 2) + "\n";
      await atomic(state.path, text);
      if (await Deno.readTextFile(state.path) !== text) {
        throw Error("Category readback mismatch");
      }
      return { ok: true };
    });
  }
}
