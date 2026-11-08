import { knownWorkspaceSource, resolveWorkspace } from "./workspaces.ts";
import { integrations } from "./integrations.ts";
import { join } from "node:path";
import {
  atomicJson,
  type ExecutionChoice,
  loadJson,
  local,
  preset,
  resolveExecution,
  root,
  settings,
} from "./config.ts";
type State =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";
export type Job = {
  id: string;
  prompt: string;
  createdAt: string;
  queueOrder?: number;
  startedAt?: string;
  endedAt?: string;
  state: State;
  threadId?: string;
  resumeThread?: string;
  chatId?: string;
  workspace?: string;
  requestKey?: string;
  name?: string;
  model?: string;
  effort?: string;
  tier?: string;
  result?: string;
  error?: string;
  events: { at: string; kind: string; text: string }[];
  usage?: unknown;
  exitCode?: number;
  truncated?: boolean;
};
export type Chat = {
  workspace?: string;
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  archived: boolean;
  threadId?: string;
  execution?: ExecutionChoice;
};
export class Jobs {
  records: Job[] = [];
  chats: Chat[] = [];
  private chatSaves: Promise<void> = Promise.resolve();
  child?: Deno.ChildProcess;
  active?: Job;
  busy = false;
  stopping = false;
  timer?: ReturnType<typeof setTimeout>;
  private serial: Promise<unknown> = Promise.resolve();
  private queueSequence = 0;
  async init() {
    const legacyWorkspace = integrations.workspaceCanonical() ??
      settings.workspace;
    await Deno.mkdir(join(local, "jobs"), { recursive: true, mode: 0o700 });
    for await (const file of Deno.readDir(join(local, "jobs"))) {
      if (!file.isFile || !file.name.endsWith(".json")) continue;
      const job = await loadJson<Job | null>(
        join(local, "jobs", file.name),
        null,
      );
      if (!job) continue;
      if (job.queueOrder !== undefined) {
        if (!Number.isSafeInteger(job.queueOrder) || job.queueOrder < 1) {
          throw new Error("Invalid persisted queue order");
        }
        this.queueSequence = Math.max(this.queueSequence, job.queueOrder);
      }
      if (!job.workspace) {
        job.workspace = legacyWorkspace;
        await this.save(job);
      }
      if (job.state === "running") {
        job.state = "interrupted";
        job.error =
          "Server restarted; prior side effects may remain. Resume explicitly.";
        job.endedAt = new Date().toISOString();
        await this.save(job);
      }
      this.records.push(job);
    }
    this.records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    this.chats = await loadJson<Chat[]>(join(local, "chats.json"), []);
    for (const c of this.chats) c.workspace ??= legacyWorkspace;
    for (const j of [...this.records].reverse()) {
      let chat = this.chats.find((c) =>
        c.id === j.chatId ||
        (!!c.threadId && [j.threadId, j.resumeThread].includes(c.threadId))
      );
      if (!chat) {
        chat = {
          id: j.chatId ?? j.id,
          workspace: j.workspace,
          title: j.prompt.slice(0, 80),
          createdAt: j.createdAt,
          updatedAt: j.createdAt,
          archived: false,
          threadId: j.threadId,
        };
        this.chats.push(chat);
      }
      if (j.chatId !== chat.id) {
        j.chatId = chat.id;
        await this.save(j);
      }
    }
    await this.saveChats();
    queueMicrotask(() => this.pump());
  }
  private saveChats() {
    const next = this.chatSaves.then(() =>
      atomicJson(join(local, "chats.json"), this.chats)
    );
    this.chatSaves = next.catch(() => {});
    return next;
  }
  private enqueue<T>(fn: () => Promise<T>) {
    const next = this.serial.then(fn);
    this.serial = next.catch(() => {});
    return next;
  }
  private async ensureChatWorkspace(chat: Chat, target: string) {
    if (chat.workspace === target) return;
    if (
      chat.workspace === settings.workspace &&
      integrations.workspaceCanonical() === target
    ) {
      chat.workspace = target;
      await this.saveChats();
      return;
    }
    throw new Error("Chat belongs to a different workspace");
  }
  createChat(id: string, title = "", workspace?: string) {
    return this.enqueue(async () => {
      if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid chat ID");
      const existing = this.chats.find((c) => c.id === id);
      const target = await resolveWorkspace(workspace ?? existing?.workspace);
      if (existing) {
        await this.ensureChatWorkspace(existing, target);
        return existing;
      }
      const now = new Date().toISOString();
      const chat: Chat = {
        id,
        workspace: target,
        title: title.trim().slice(0, 80),
        createdAt: now,
        updatedAt: now,
        archived: false,
      };
      this.chats.unshift(chat);
      await this.saveChats();
      return chat;
    });
  }
  archiveChat(id: string, archived: boolean) {
    return this.enqueue(async () => {
      const chat = this.chats.find((c) => c.id === id);
      if (!chat) throw new Error("Unknown chat");
      if (
        this.records.some((j) =>
          j.chatId === id && ["queued", "running"].includes(j.state)
        )
      ) {
        throw new Error(
          "Wait for this chat's running work before archiving or restoring",
        );
      }
      // CLI archive is not idempotent. Check only filenames for this owned ID.
      let alreadyArchived = false;
      if (chat.threadId && archived && settings.sessionArchiveDirectory) {
        try {
          for await (
            const entry of Deno.readDir(settings.sessionArchiveDirectory)
          ) {
            if (
              entry.isFile && entry.name.endsWith(`-${chat.threadId}.jsonl`)
            ) {
              alreadyArchived = true;
              break;
            }
          }
        } catch (e) {
          if (!(e instanceof Deno.errors.NotFound)) throw e;
        }
      }
      if (chat.threadId && !alreadyArchived) {
        const child = new Deno.Command(settings.codexPath, {
          args: [archived ? "archive" : "unarchive", chat.threadId],
          cwd: settings.workspace,
          clearEnv: true,
          env: Object.fromEntries(
            [
              "HOME",
              "PATH",
              "TMPDIR",
              "CODEX_HOME",
              "HTTP_PROXY",
              "HTTPS_PROXY",
              "ALL_PROXY",
              "NO_PROXY",
              "http_proxy",
              "https_proxy",
              "all_proxy",
              "no_proxy",
            ].flatMap((key) => {
              const value = Deno.env.get(key);
              return value === undefined ? [] : [[key, value]];
            }),
          ),
          stdin: "null", // A service's inherited stdin may never reach EOF.
          stdout: "piped",
          stderr: "piped",
        }).spawn();
        let timedOut = false;
        const timeout = setTimeout(() => {
          timedOut = true;
          try {
            child.kill("SIGTERM");
          } catch { /* exited */ }
        }, settings.sessionOperationTimeoutMs ?? 45000);
        try {
          const out = await child.output();
          if (!out.success) {
            throw new Error(
              timedOut
                ? "Codex session update timed out. Try Restore chat or start a new chat."
                : (new TextDecoder().decode(out.stderr).trim() ||
                  new TextDecoder().decode(out.stdout).trim() ||
                  `Codex session update exited with code ${out.code}`).slice(
                    0,
                    2000,
                  ),
            );
          }
        } finally {
          clearTimeout(timeout);
        }
      }
      chat.archived = archived;
      chat.updatedAt = new Date().toISOString();
      await this.saveChats();
      return chat;
    });
  }
  chatList() {
    return this.chats.map((c) => ({
      ...c,
      turns: this.records.filter((j) => j.chatId === c.id).length,
      busy: this.records.some((j) =>
        j.chatId === c.id && ["queued", "running"].includes(j.state)
      ),
    })).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  private saves = new Map<string, Promise<void>>();
  async save(j: Job) {
    const next = (this.saves.get(j.id) ?? Promise.resolve()).then(async () => {
      await atomicJson(join(local, "jobs", j.id + ".json"), j);
      const chat = this.chats.find((c) => c.id === j.chatId);
      if (chat && j.threadId && chat.threadId !== j.threadId) {
        chat.threadId = j.threadId;
        await this.saveChats();
      }
    });
    this.saves.set(j.id, next.catch(() => {}));
    await next;
  }
  list() {
    return this.records.map(({ events, result, ...j }) => ({
      ...j,
      eventCount: events.length,
      preview: result?.slice(0, 200),
    }));
  }
  get(id: string) {
    return this.records.find((j) => j.id === id);
  }
  submit(
    id: string,
    prompt: string,
    resumeThread?: string,
    execution?: ExecutionChoice,
    chatId?: string,
    workspace?: string,
  ) {
    const action = this.serial.then(async () => {
      if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid request ID");
      if (!prompt.trim() || prompt.length > settings.maxPromptCharacters) {
        throw new Error("Empty or oversized instruction");
      }
      const existing = this.get(id);
      const requestKey = JSON.stringify([
        prompt,
        resumeThread ?? null,
        execution ?? null,
        chatId ?? null,
        ...(workspace === undefined ? [] : [workspace]),
      ]);
      if (existing) {
        if (
          existing.requestKey
            ? existing.requestKey !== requestKey
            : existing.prompt !== prompt ||
              existing.resumeThread !== resumeThread
        ) throw new Error("Request ID conflicts with existing content");
        return existing;
      }
      if (
        resumeThread && !this.records.some((j) => j.threadId === resumeThread)
      ) throw new Error("Unknown continuation thread");
      if (
        this.records.filter((j) => ["queued", "running"].includes(j.state))
          .length >= settings.maxQueuedJobs
      ) throw new Error("Queue full");
      if (this.queueSequence >= Number.MAX_SAFE_INTEGER) {
        throw new Error("Queue order exhausted");
      }
      const selected = await resolveExecution(execution);
      let chat = chatId
        ? this.chats.find((c) => c.id === chatId)
        : resumeThread
        ? this.chats.find((c) => c.threadId === resumeThread)
        : undefined;
      if (chatId && !chat) throw new Error("Unknown chat");
      const target = await resolveWorkspace(workspace ?? chat?.workspace);
      if (chat) await this.ensureChatWorkspace(chat, target);
      if (resumeThread && chat && chat.threadId !== resumeThread) {
        throw new Error("Thread does not belong to this chat");
      }
      if (chat?.archived) {
        throw new Error("Restore this archived chat, or start a new chat");
      }
      if (!chat) {
        const now = new Date().toISOString();
        chat = {
          id,
          workspace: target,
          title: prompt.slice(0, 80),
          createdAt: now,
          updatedAt: now,
          archived: false,
        };
        this.chats.unshift(chat);
      }
      if (!chat.title) chat.title = prompt.slice(0, 80);
      chat.updatedAt = new Date().toISOString();
      chat.execution = {
        preset: selected.name,
        effort: selected.effort,
        fast: selected.tier === "priority",
      };
      await this.saveChats();
      const j: Job = {
        id,
        prompt,
        createdAt: new Date().toISOString(),
        queueOrder: this.queueSequence + 1,
        state: "queued",
        events: [],
        resumeThread,
        ...selected,
        chatId: chat.id,
        workspace: target,
        requestKey,
      };
      await this.save(j);
      this.queueSequence = j.queueOrder!;
      this.records.unshift(j);
      queueMicrotask(() => this.pump());
      return j;
    });
    this.serial = action.catch(() => {});
    return action;
  }
  async cancel(id: string) {
    const j = this.get(id);
    if (!j) throw new Error("Unknown job");
    if (!["running", "queued"].includes(j.state)) return j;
    j.state = "cancelled";
    j.endedAt = new Date().toISOString();
    await this.save(j);
    if (this.active?.id === id && this.child) {
      try {
        this.child.kill("SIGTERM");
      } catch { /* Already exited. */ }
    }
    return j;
  }
  private event(j: Job, kind: string, text: string) {
    j.events.push({
      at: new Date().toISOString(),
      kind,
      text: text.slice(0, 12000),
    });
    if (j.events.length > 300) {
      j.events.splice(0, j.events.length - 300);
      j.truncated = true;
    }
  }
  private consume(j: Job, line: string) {
    try {
      const e = JSON.parse(line);
      if (e.type === "thread.started") j.threadId = e.thread_id;
      if (e.type === "turn.completed") j.usage = e.usage;
      if (e.type === "error" || e.type === "turn.failed") {
        j.error = e.message ?? e.error?.message ?? "Agent reported a failure";
        this.event(j, "error", j.error!);
      }
      const item = e.item;
      if (item && e.type === "item.completed") {
        if (item.type === "agent_message") {
          this.event(j, "message", item.text ?? "");
          j.result = item.text ?? "";
        } else if (item.type === "command_execution") {
          this.event(
            j,
            "command",
            `${item.command}\n${item.aggregated_output ?? ""}`,
          );
        } else if (item.type === "file_change") {
          this.event(j, "files", JSON.stringify(item.changes ?? []));
        } else if (item.type !== "reasoning") {
          this.event(j, item.type, JSON.stringify(item).slice(0, 3000));
        }
      }
    } catch { /* Non-JSON diagnostics stay in the local raw log. */ }
  }
  async pump() {
    if (this.busy || this.stopping) return;
    const j =
      this.records.filter((job) => job.state === "queued").sort((a, b) => {
        if (a.queueOrder !== undefined && b.queueOrder !== undefined) {
          return a.queueOrder - b.queueOrder || a.id.localeCompare(b.id);
        }
        if (a.queueOrder !== undefined) return 1;
        if (b.queueOrder !== undefined) return -1;
        // Old records have no sequence. Preserve their known time order; ties
        // have no recoverable original order and use an ID for stable replay.
        return a.createdAt.localeCompare(b.createdAt) ||
          a.id.localeCompare(b.id);
      })[0];
    if (!j) return;
    const source = knownWorkspaceSource(j.workspace ?? settings.workspace);
    if (
      (source && !integrations.connected(source)) ||
      (!source &&
        (!integrations.connected("workspace") ||
          !integrations.connected("projects")))
    ) {
      return; // Keep the oldest request queued until its source is available.
    }
    this.busy = true;
    this.active = j;
    let raw: Deno.FsFile | undefined;
    let count = 0;
    try {
      const p = j.model
        ? { name: j.name, model: j.model, effort: j.effort, tier: j.tier }
        : await preset();
      if (this.stopping || j.state !== "queued") return;
      Object.assign(j, p);
      const chat = this.chats.find((c) => c.id === j.chatId);
      j.resumeThread = chat?.threadId ?? j.resumeThread;
      j.state = "running";
      j.startedAt = new Date().toISOString();
      await this.save(j);
      const workspace = await resolveWorkspace(j.workspace);
      if (chat) await this.ensureChatWorkspace(chat, workspace);
      const finalPath = join(local, "jobs", j.id + ".txt");
      const args = [
        "exec",
        "--json",
        ...settings.approvalMode === "review"
          ? ["--approve-for-me"]
          : ["--sandbox", "workspace-write", "-c", 'approval_policy="never"'],
        "--cd",
        workspace,
        "--model",
        p.model,
        "-c",
        `model_reasoning_effort="${p.effort}"`,
        "-c",
        `service_tier="${p.tier}"`,
        "--output-last-message",
        finalPath,
      ];
      if (j.resumeThread) args.push("resume", j.resumeThread);
      args.push("-");
      const instructions = await Deno.readTextFile(
        join(root, "config/agent_instructions.md"),
      );
      // Cancellation can arrive while the preset, record or instructions load.
      if (this.stopping || (j.state as State) !== "running") return;
      this.child = new Deno.Command(settings.codexPath, {
        args,
        cwd: workspace,
        stdin: "piped",
        stdout: "piped",
        stderr: "piped",
      }).spawn();
      const writer = this.child.stdin.getWriter();
      await writer.write(
        new TextEncoder().encode(
          instructions + "\n\nVerified working directory: " + workspace +
            "\n\nUser request:\n" + j.prompt,
        ),
      );
      await writer.close();
      raw = await Deno.open(join(local, "jobs", j.id + ".jsonl"), {
        create: true,
        append: true,
        mode: 0o600,
      });
      this.timer = setTimeout(() => {
        if (j.state === "running") {
          j.error = "Job time limit reached";
          j.state = "failed";
          try {
            this.child?.kill("SIGTERM");
          } catch { /* exited */ }
        }
      }, settings.maxJobMinutes * 60000);
      let lastSave = 0;
      const stdout = (async () => {
        let pending = "";
        const decoder = new TextDecoder();
        for await (const data of this.child!.stdout) {
          count += data.length;
          if (count <= settings.maxOutputBytes) await raw!.write(data);
          else j.truncated = true;
          pending += decoder.decode(data, { stream: true });
          const lines = pending.split("\n");
          pending = lines.pop() ?? "";
          for (const line of lines) this.consume(j, line);
          if (pending.length > settings.maxOutputBytes) {
            pending = "";
            j.truncated = true;
          }
          if (Date.now() - lastSave > 750) {
            await this.save(j);
            lastSave = Date.now();
          }
        }
        if (pending) this.consume(j, pending);
      })();
      const stderr = (async () => {
        let size = 0;
        for await (const data of this.child!.stderr) {
          size += data.length;
          if (size < 16000) {
            this.event(j, "diagnostic", new TextDecoder().decode(data));
          }
        }
      })();
      const [status] = await Promise.all([this.child.status, stdout, stderr]);
      j.exitCode = status.code;
      if (j.state === "running") {
        j.state = status.success && !j.error ? "completed" : "failed";
      }
      if (!status.success && !j.error && (j.state as State) !== "cancelled") {
        j.error = "Codex exited with code " + status.code;
      }
      try {
        const stat = await Deno.stat(finalPath);
        if (stat.size <= settings.maxOutputBytes) {
          j.result = await Deno.readTextFile(finalPath);
        }
      } catch { /* No final response on cancellation or early failure. */ }
    } catch (e) {
      if (j.state !== "cancelled") {
        j.state = "failed";
        j.error = e instanceof Error ? e.message : String(e);
      }
    } finally {
      if (this.timer) clearTimeout(this.timer);
      raw?.close();
      j.endedAt = new Date().toISOString();
      await this.save(j);
      this.child = undefined;
      this.active = undefined;
      this.busy = false;
      queueMicrotask(() => this.pump());
    }
  }
  async shutdown() {
    this.stopping = true;
    if (this.active && this.child) {
      this.active.state = "interrupted";
      this.active.error = "Service stopped; resume explicitly";
      await this.save(this.active);
      try {
        this.child.kill("SIGTERM");
      } catch { /* exited */ }
    }
  }
}
