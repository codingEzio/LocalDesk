import { assert, assertEquals } from "@std/assert";
import { join } from "node:path";

const first = "11111111-1111-4111-8111-111111111111";
const second = "22222222-2222-4222-8222-222222222222";
const runner = `#!/bin/sh
payload=$(cat)
case "$payload" in *FIRST*) label=first;; *SECOND*) label=second;; *) exit 2;; esac
printf '%s\\n' "$label" >> "$LOCALDESK_DATA/order"
touch "$LOCALDESK_DATA/$label-started"
if [ "$label" = first ]; then
 n=0; while [ ! -f "$LOCALDESK_DATA/release" ] && [ "$n" -lt 200 ]; do n=$((n+1)); sleep 0.05; done
 [ -f "$LOCALDESK_DATA/release" ] || exit 3
fi
printf '{}\\n'
`;

Deno.test("HTTP reconnect resumes a paused queue in order and preserves interruption", async (t) => {
  const outer = await Deno.realPath(
    await Deno.makeTempDir({ prefix: "localdesk-queue-api-" }),
  );
  let success = false, serial = 0;
  async function step(name: string, fn: () => Promise<void>) {
    if (!await t.step(name, fn)) {
      throw new Error(`Synthetic step failed: ${name}`);
    }
  }
  async function fixture() {
    const base = join(outer, String(serial++)),
      source = join(base, "source"),
      config = join(source, "config");
    const state = join(base, "state"),
      home = join(base, "home"),
      tmp = join(base, "tmp"),
      old = join(base, "old-workspace"),
      workspace = join(base, "new-workspace"),
      projects = join(base, "projects"),
      project = join(projects, "Example");
    for (
      const path of [
        source,
        config,
        join(state, "jobs"),
        home,
        tmp,
        old,
        workspace,
        project,
      ]
    ) await Deno.mkdir(path, { recursive: true });
    // The caller uses an explicitly selected, de-identified backend source.
    const copy = await new Deno.Command("/bin/cp", {
      args: ["-R", "backend", source],
    }).output();
    assert(copy.success);
    for (const file of ["deno.json", "deno.lock"]) {
      await Deno.copyFile(file, join(source, file));
    }
    const sockets = [0, 0].map(() =>
      Deno.listen({ hostname: "127.0.0.1", port: 0 })
    );
    const frontendPort = sockets[0].addr.port,
      backendPort = sockets[1].addr.port;
    sockets.forEach((s) => s.close());
    const command = join(base, "fake-codex"),
      models = join(base, "synthetic-models.json");
    await Deno.writeTextFile(command, runner, { mode: 0o700 });
    await Deno.writeTextFile(
      models,
      JSON.stringify({
        models: [{
          slug: "synthetic",
          visibility: "list",
          supported_reasoning_levels: [{ effort: "low" }],
        }],
      }),
    );
    const defaults = {
      workspace,
      projectsRoot: projects,
      frontendPort,
      backendPort,
      frontendHost: "localhost",
      shareCatalogOnLan: false,
      runtimeRegistry: null,
      codexPath: command,
      modelsFile: models,
      sessionArchiveDirectory: "archive",
      preset: "default",
      presets: [{
        name: "default",
        model: "synthetic",
        effort: "low",
        tier: "default",
      }],
      approvalMode: "sandbox",
      sessionOperationTimeoutMs: 1000,
      scanIntervalMs: 60000,
      projectScanIntervalMs: 60000,
      maxQueuedJobs: 3,
      maxPromptCharacters: 1000,
      maxJobMinutes: 1,
      maxOutputBytes: 1000,
      discoveryDirectories: [],
    };
    await Deno.writeTextFile(
      join(config, "settings.json"),
      JSON.stringify(defaults),
    );
    await Deno.writeTextFile(
      join(config, "agent_instructions.md"),
      "Synthetic instructions\n",
    );
    await Deno.writeTextFile(
      join(state, "integrations.json"),
      JSON.stringify({
        workspace: false,
        projects: true,
        workspaceCanonical: old,
        projectsCanonical: projects,
        workspaceConfigured: old,
        projectsConfigured: projects,
      }),
    );
    const now = "2020-01-01T00:00:00.000Z",
      later = "2020-01-01T00:00:01.000Z";
    await Deno.writeTextFile(
      join(state, "chats.json"),
      JSON.stringify([{
        id: first,
        workspace: project,
        title: "first",
        createdAt: now,
        updatedAt: now,
        archived: false,
      }, {
        id: second,
        workspace: project,
        title: "second",
        createdAt: later,
        updatedAt: later,
        archived: false,
      }]),
    );
    for (
      const [id, prompt, time] of [[first, "FIRST", now], [
        second,
        "SECOND",
        later,
      ]]
    ) {
      await Deno.writeTextFile(
        join(state, "jobs", id + ".json"),
        JSON.stringify({
          id,
          prompt,
          createdAt: time,
          state: "queued",
          events: [],
          chatId: id,
          workspace: project,
          name: "fixture",
          model: "synthetic",
          effort: "low",
          tier: "default",
        }),
      );
    }
    const before = await Promise.all(
      [first, second].map((id) =>
        Deno.readTextFile(join(state, "jobs", id + ".json"))
      ),
    );
    const env: Record<string, string> = {
      HOME: home,
      TMPDIR: tmp,
      PATH: "/usr/bin:/bin",
      LOCALDESK_DATA: state,
      CODEX_HOME: join(home, ".codex"),
    };
    const cache = Deno.env.get("DENO_DIR");
    if (cache) env.DENO_DIR = cache;
    let child: Deno.ChildProcess | undefined;
    let stderr: Promise<string> | undefined;
    let token = "";
    async function exists(path: string) {
      try {
        await Deno.lstat(path);
        return true;
      } catch (e) {
        if (e instanceof Deno.errors.NotFound) return false;
        throw e;
      }
    }
    async function wait(condition: () => Promise<boolean>) {
      const deadline = Date.now() + 15000;
      while (!await condition()) {
        if (Date.now() > deadline) throw Error("Synthetic HTTP timeout");
        await new Promise((r) => setTimeout(r, 20));
      }
    }
    async function api(path: string, body?: unknown) {
      const res = await fetch(`http://127.0.0.1:${backendPort}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          authorization: `Bearer ${token}`,
          origin: `http://localhost:${frontendPort}`,
          "content-type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: res.status, body: await res.json() };
    }
    async function start() {
      child = new Deno.Command(Deno.execPath(), {
        args: ["run", "--cached-only", "-A", "backend/main.ts"],
        cwd: source,
        clearEnv: true,
        env,
        stdout: "null",
        stderr: "piped",
      }).spawn();
      stderr = new Response(child.stderr).text();
      await Promise.race([
        wait(async () => {
          try {
            token = (await Deno.readTextFile(join(state, "capability")))
              .trim();
            return (await api("/api/state")).body.ready;
          } catch {
            return false;
          }
        }),
        child.status.then(async (status) => {
          throw new Error(
            `Synthetic backend exited (${status.code}): ${await stderr}`,
          );
        }),
      ]);
    }
    async function stop() {
      if (!child) return;
      try {
        child.kill("SIGTERM");
      } catch (e) {
        if (!(e instanceof TypeError)) throw e;
      }
      await child.status;
      await stderr;
      child = undefined;
    }
    async function paused() {
      const result = (await api("/api/state")).body;
      assert(
        result.integrations.every((
          s: { requiresBoth: boolean; connected: boolean },
        ) => s.requiresBoth && !s.connected),
      );
      assertEquals(
        [first, second].map((id) =>
          result.jobs.find((j: { id: string }) => j.id === id)?.state
        ),
        ["queued", "queued"],
      );
      assertEquals(await exists(join(state, "order")), false);
    }
    return { state, before, api, start, stop, wait, exists, paused };
  }
  try {
    for (const mode of ["cancel", "interrupt"] as const) {
      await step(`HTTP both reconnect, FIFO and ${mode}`, async () => {
        const f = await fixture();
        try {
          await f.start();
          await f.paused();
          await f.stop();
          await f.start();
          await f.paused();
          assertEquals(
            await Promise.all(
              [first, second].map((id) =>
                Deno.readTextFile(join(f.state, "jobs", id + ".json"))
              ),
            ),
            f.before,
          );
          assertEquals(
            (await f.api("/api/integrations", { id: "both", connected: true }))
              .status,
            200,
          );
          await f.wait(async () =>
            await f.exists(join(f.state, "first-started"))
          );
          const active = (await f.api("/api/state")).body;
          assertEquals(
            [first, second].map((id) =>
              active.jobs.find((j: { id: string }) => j.id === id)?.state
            ),
            ["running", "queued"],
          );
          if (mode === "cancel") {
            assertEquals(
              (await f.api(`/api/jobs/${first}/cancel`, {})).status,
              200,
            );
            await f.wait(async () => {
              const s = (await f.api("/api/state")).body;
              return s.jobs.find((j: { id: string }) => j.id === second)
                ?.state === "completed";
            });
            const s = (await f.api("/api/state")).body;
            assertEquals(
              [first, second].map((id) =>
                s.jobs.find((j: { id: string }) => j.id === id)?.state
              ),
              ["cancelled", "completed"],
            );
          } else {
            await f.stop();
            const firstSaved = JSON.parse(
              await Deno.readTextFile(join(f.state, "jobs", first + ".json")),
            );
            const secondSaved = JSON.parse(
              await Deno.readTextFile(join(f.state, "jobs", second + ".json")),
            );
            assertEquals([firstSaved.state, secondSaved.state], [
              "interrupted",
              "queued",
            ]);
            await f.start();
            await f.wait(async () => {
              const s = (await f.api("/api/state")).body;
              return s.jobs.find((j: { id: string }) => j.id === second)
                ?.state === "completed";
            });
            const s = (await f.api("/api/state")).body;
            assertEquals(
              [first, second].map((id) =>
                s.jobs.find((j: { id: string }) => j.id === id)?.state
              ),
              ["interrupted", "completed"],
            );
          }
          assertEquals(
            (await Deno.readTextFile(join(f.state, "order"))).trim().split(
              "\n",
            ),
            ["first", "second"],
          );
        } finally {
          await f.stop();
        }
      });
    }
    success = true;
  } finally {
    if (success) await Deno.remove(outer, { recursive: true });
    else console.error(`Synthetic failure evidence retained at ${outer}`);
  }
});
