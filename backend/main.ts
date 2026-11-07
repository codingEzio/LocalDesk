import { integrations } from "./integrations.ts";
import { join } from "node:path";
import { localOriginPolicy } from "./origin.ts";
import {
  capability,
  executionOptions,
  json,
  ports,
  preset,
  root,
  settings,
} from "./config.ts";
import { Catalog } from "./catalog.ts";
import { Skills } from "./skills.ts";
const skills = new Skills();
import { Jobs } from "./jobs.ts";
import { Workbench } from "./workbench.ts";
const token = await capability();
const catalog = new Catalog();
const jobs = new Jobs();
const workbench = new Workbench();
void workbench.start();
let jobsReady = false;
const allowedOrigin = localOriginPolicy(ports.frontend, [
  "127.0.0.1",
  "::1",
  "::ffff:127.0.0.1",
  ...Deno.networkInterfaces().map((n) => n.address),
]);
let runner: unknown = { name: settings.preset, ready: false };
async function refreshRunner() {
  try {
    runner = {
      ...await preset(),
      ...await executionOptions(),
      ready: (await Deno.stat(settings.codexPath)).isFile,
    };
  } catch (e) {
    runner = {
      name: settings.preset,
      ready: false,
      errorCode: settings.presets.length
        ? "runner_unavailable"
        : "model_unconfigured",
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
await refreshRunner();
async function body(req: Request) {
  const stream = req.body?.getReader();
  if (!stream) throw new Error("Missing request body");
  let size = 0;
  const chunks = [];
  while (true) {
    const { done, value } = await stream.read();
    if (done) break;
    size += value.length;
    if (size > 64000) {
      await stream.cancel();
      throw new Error("Request too large");
    }
    chunks.push(value);
  }
  return JSON.parse(await new Blob(chunks).text());
}
const server = Deno.serve(
  { hostname: "127.0.0.1", port: ports.backend },
  async (req) => {
    const url = new URL(req.url);
    const path = url.pathname;
    const trusted = req.headers.get("authorization") === `Bearer ${token}`;
    if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
      return json({ error: "Unknown host" }, 403);
    }
    const origin = req.headers.get("origin");
    if (origin && !allowedOrigin(origin)) {
      return json({ error: "Local origin required" }, 403);
    }
    const sharedCatalog = settings.shareCatalogOnLan && req.method === "GET" &&
      ["/api/state", "/api/workbench"].includes(path);
    if (path.startsWith("/api/") && !trusted && !sharedCatalog) {
      return json({ error: "Local capability required" }, 403);
    }

    if (
      req.method !== "GET" &&
      (!trusted || !allowedOrigin(req.headers.get("origin") ?? ""))
    ) return json({ error: "Local origin required" }, 403);
    try {
      if (req.method !== "GET" && !jobsReady) {
        return json({ error: "Workspace is loading. Try again shortly." }, 503);
      }
      if (path.startsWith("/api/skills")) {
        if (!trusted) return json({ error: "Local capability required" }, 403);
        if (path === "/api/skills" && req.method === "GET") {
          return json(
            await integrations.read(
              "workspace",
              () => skills.list(url.searchParams.get("fresh") === "1"),
            ),
          );
        }
        if (req.method === "POST") {
          const input = await body(req);
          if (path === "/api/skills/preview") {
            return json(
              await integrations.read("workspace", () => skills.preview(input)),
            );
          }
          if (path === "/api/skills/apply") {
            return json(
              await integrations.read(
                "workspace",
                () => skills.apply(input.id, input.selected),
              ),
            );
          }
          if (path === "/api/skills/assignment") {
            return json(
              await integrations.read("workspace", () => skills.assign(input)),
            );
          }
          if (path === "/api/skills/categories") {
            return json(
              await integrations.read(
                "workspace",
                () => skills.saveCategories(input),
              ),
            );
          }
          if (path === "/api/skills/recover") {
            return json(
              await integrations.read("workspace", () => skills.recover()),
            );
          }
        }
        return json({ error: "Not found" }, 404);
      }
      if (path === "/api/workbench" && req.method === "GET") {
        return json(workbench.view());
      }
      if (path === "/health") {
        return json({
          ok: true,
          version: "0.2.1",
          catalogReady: !!catalog.scannedAt,
        });
      }
      if (path === "/api/state" && req.method === "GET") {
        return json({
          version: "0.2.1",
          integrations: integrations.view(),
          workspace: settings.workspace,
          workspaces: [
            ...(integrations.connected("workspace")
              ? [{ name: "Workspace", path: settings.workspace }]
              : []),
            ...(workbench.view().snapshot?.projects ?? []).map((p) => ({
              name: p.name,
              path: p.path,
            })),
          ],
          catalog: catalog.view(),
          runner,
          ready: jobsReady,
          canControl: trusted && jobsReady,
          jobs: trusted ? jobs.list() : [],
          chats: trusted ? jobs.chatList() : [],
          limits: {
            queue: settings.maxQueuedJobs,
            minutes: settings.maxJobMinutes,
          },
          serverTime: new Date().toISOString(),
        });
      }
      if (path === "/api/integrations" && req.method === "POST") {
        const input = await body(req);
        await integrations.change(
          input.id,
          input.connected,
          () =>
            jobs.records.some((job) =>
              ["queued", "running"].includes(job.state)
            ),
        );
        if (input.connected) {
          if (input.id === "workspace") await catalog.scan();
          else await workbench.refresh();
        }
        return json({ integrations: integrations.view() });
      }
      if (path === "/api/workbench/refresh" && req.method === "POST") {
        void workbench.refresh();
        return json({ accepted: true }, 202);
      }
      if (path === "/api/refresh" && req.method === "POST") {
        void catalog.scan();
        void refreshRunner();
        return json({ accepted: true }, 202);
      }
      if (path === "/api/modules" && req.method === "POST") {
        const b = await body(req);
        if (typeof b.enabled !== "boolean") {
          throw new Error(
            "enabled must be boolean",
          );
        }
        await catalog.enable(b.id, b.enabled);
        return json({ ok: true });
      }
      if (path === "/api/jobs" && req.method === "POST") {
        const b = await body(req);
        if (
          typeof b.prompt !== "string" || typeof b.id !== "string"
        ) throw new Error("Invalid job");
        return json(
          await integrations.read(
            (b.workspace ?? jobs.chats.find((c) =>
                c.id === b.chatId
              )?.workspace ??
                settings.workspace) === settings.workspace
              ? "workspace"
              : "projects",
            () =>
              jobs.submit(
                b.id,
                b.prompt,
                b.resumeThread,
                b.execution,
                b.chatId,
                b.workspace,
              ),
          ),
          202,
        );
      }
      if (path === "/api/chats" && req.method === "POST") {
        const b = await body(req);
        if (
          typeof b.id !== "string" ||
          (b.title !== undefined && typeof b.title !== "string")
        ) throw new Error("Invalid chat");
        return json(
          await integrations.read(
            (b.workspace ?? settings.workspace) === settings.workspace
              ? "workspace"
              : "projects",
            () => jobs.createChat(b.id, b.title, b.workspace),
          ),
          201,
        );
      }
      const chatMatch = path.match(/^\/api\/chats\/([a-f0-9-]{36})$/);
      if (chatMatch && req.method === "GET") {
        if (!trusted) {
          return json(
            { error: "Private chats are available only on this computer" },
            403,
          );
        }
        const chat = jobs.chats.find((c) => c.id === chatMatch[1]);
        if (!chat) return json({ error: "Not found" }, 404);
        return json({
          chat,
          turns: jobs.records.filter((j) => j.chatId === chat.id).reverse().map(
            ({ events, requestKey: _requestKey, ...j }) => ({
              ...j,
              eventCount: events.length,
            }),
          ),
        });
      }
      if (chatMatch && req.method === "POST") {
        const b = await body(req);
        if (typeof b.archived !== "boolean") {
          throw new Error("Invalid archive state");
        }
        return json(
          await integrations.read(
            (jobs.chats.find((c) => c.id === chatMatch[1])?.workspace ??
                settings.workspace) === settings.workspace
              ? "workspace"
              : "projects",
            () => jobs.archiveChat(chatMatch[1], b.archived),
          ),
        );
      }
      const match = path.match(/^\/api\/jobs\/([a-f0-9-]{36})(\/cancel)?$/);
      if (match) {
        if (!trusted) {
          return json(
            { error: "Private jobs are available only on this computer" },
            403,
          );
        }
        if (match[2] && req.method === "POST") {
          return json(
            await jobs.cancel(match[1]),
          );
        }
        if (req.method === "GET") {
          const j = jobs.get(match[1]);
          return j ? json(j) : json({ error: "Not found" }, 404);
        }
      }
      return json({ error: "Not found" }, 404);
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  },
);
await jobs.init();
jobsReady = true;
await catalog.init();
const timer = setInterval(() => {
  void catalog.scan();
}, settings.scanIntervalMs);
async function shutdown() {
  clearInterval(timer);
  await workbench.stop();
  await jobs.shutdown();
  await server.shutdown();
}
Deno.addSignalListener("SIGTERM", () => void shutdown());
Deno.addSignalListener("SIGINT", () => void shutdown());
console.log(
  JSON.stringify({
    service: "LocalDesk",
    workspace: settings.workspace,
    root: join(root, "plugins"),
    port: ports.backend,
  }),
);
