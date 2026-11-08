import { assert, assertEquals } from "@std/assert";
import { join } from "node:path";

// Disposable source-only backend and synthetic runner. Never reads a user profile.
Deno.test("source connections drain reads, preserve data, reject active work and survive restart", async () => {
  const base = await Deno.realPath(
    await Deno.makeTempDir({
      prefix: "delete_after_use_localdesk_sources_",
    }),
  );
  const root = join(base, "Source With Spaces");
  const local = join(base, "private state");
  await Deno.mkdir(root);
  for (const name of ["backend", "plugins", "config"]) {
    await Deno.mkdir(join(root, name));
  }
  // Copy tracked defaults explicitly; never copy settings.local.json or skills.local.json.
  for (const directory of ["backend", "plugins"]) {
    const result = await new Deno.Command("/bin/cp", {
      args: ["-R", directory + "/.", join(root, directory)],
    }).output();
    assert(result.success);
  }
  for (const name of ["deno.json", "deno.lock"]) {
    await Deno.copyFile(name, join(root, name));
  }
  for (
    const name of [
      "settings.json",
      "skill_management.json",
      "skill_categories.json",
      "agent_instructions.md",
    ]
  ) {
    await Deno.copyFile(join("config", name), join(root, "config", name));
  }
  const ports = [0, 0].map(() =>
    Deno.listen({ hostname: "127.0.0.1", port: 0 })
  );
  const frontendPort = ports[0].addr.port, backendPort = ports[1].addr.port;
  ports.forEach((listener) => listener.close());
  const workspace = join(base, "workspace"),
    workspaceLink = join(base, "workspace-link"),
    projectsRoot = join(base, "projects");
  for (const name of ["config", "scripts", "skills", "services", "tools"]) {
    await Deno.mkdir(join(workspace, name), { recursive: true });
  }
  await Deno.mkdir(join(workspace, "Personal", "Settings", "FixtureConfig"), {
    recursive: true,
  });
  await Deno.mkdir(join(workspace, "Personal", "Utilities", "FixtureTool"), {
    recursive: true,
  });
  await Deno.mkdir(join(workspace, "config", "DefaultOnly"));
  await Deno.mkdir(join(workspace, "tools", "DefaultOnly"));
  await Deno.symlink(workspace, workspaceLink);
  await Deno.writeTextFile(join(workspace, "Brewfile"), 'brew "fixture-one"\n');
  await Deno.mkdir(join(projectsRoot, "X-Fixture"), { recursive: true });
  await Deno.writeTextFile(
    join(projectsRoot, "X-Fixture", "README.md"),
    "Synthetic project\n",
  );
  await Deno.mkdir(join(workspace, "skills", "fixture-skill"));
  await Deno.writeTextFile(
    join(workspace, "skills", "fixture-skill", "SKILL.md"),
    "---\nname: fixture-skill\ndescription: Synthetic fixture\n---\nFixture\n",
  );
  await Deno.mkdir(local);
  await Deno.writeTextFile(
    join(local, "settings.local.json"),
    JSON.stringify({
      sourcePaths: {
        configurations: "Personal/Settings",
        utilities: "Personal/Utilities",
      },
    }),
  );
  const legacyChatId = crypto.randomUUID();
  await Deno.writeTextFile(
    join(local, "chats.json"),
    JSON.stringify([{
      id: legacyChatId,
      title: "Legacy fixture",
      createdAt: "2020-01-01T00:00:00Z",
      updatedAt: "2020-01-01T00:00:00Z",
      archived: false,
    }]),
  );
  const modelsFile = join(base, "models.json"),
    runner = join(base, "fake-codex");
  await Deno.writeTextFile(
    modelsFile,
    JSON.stringify({
      models: [{
        slug: "fixture",
        visibility: "list",
        supported_reasoning_levels: [{ effort: "low" }],
      }],
    }),
  );
  await Deno.writeTextFile(
    runner,
    '#!/bin/sh\nif [ "$1" = archive ]; then exit 0; fi\nexec sleep 30\n',
    { mode: 0o700 },
  );
  const defaults = JSON.parse(await Deno.readTextFile("config/settings.json"));
  await Deno.writeTextFile(
    join(root, "config/settings.json"),
    JSON.stringify({
      ...defaults,
      workspace: workspaceLink,
      projectsRoot,
      frontendPort,
      backendPort,
      modelsFile,
      codexPath: runner,
      sessionArchiveDirectory: join(base, "archive"),
      runtimeRegistry: null,
      scanIntervalMs: 60,
      projectScanIntervalMs: 80,
      presets: [{
        name: "default",
        model: "fixture",
        effort: "low",
        tier: "default",
      }],
    }),
  );
  let child: Deno.ChildProcess | undefined;
  let stderr: Promise<string> = Promise.resolve("");
  const logs: string[] = [];
  const wait = async (condition: () => Promise<boolean>) => {
    const deadline = Date.now() + 15000;
    while (!await condition()) {
      if (Date.now() > deadline) {
        throw new Error("Timed out waiting for fixture state");
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };
  let token = "";
  const api = async (path: string, value?: unknown) => {
    const response = await fetch(`http://127.0.0.1:${backendPort}${path}`, {
      method: value === undefined ? "GET" : "POST",
      headers: {
        authorization: "Bearer " + token,
        origin: `http://localhost:${frontendPort}`,
        "content-type": "application/json",
      },
      body: value === undefined ? undefined : JSON.stringify(value),
    });
    return { status: response.status, body: await response.json() };
  };
  const start = async () => {
    child = new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", "backend/main.ts"],
      cwd: root,
      env: {
        LOCALDESK_DATA: local,
        LOCALDESK_CONFIG: "",
        HOME: join(base, "empty-home"),
        CODEX_HOME: join(base, "empty-home", ".codex"),
      },
      stdout: "null",
      stderr: "piped",
    }).spawn();
    stderr = new Response(child.stderr).text();
    await wait(async () => {
      try {
        token = (await Deno.readTextFile(join(local, "capability")))
          .trim();
        return (await api("/api/state")).body.ready;
      } catch {
        return false;
      }
    });
  };
  const stop = async () => {
    if (!child) return;
    child.kill("SIGTERM");
    await child.status;
    logs.push(await stderr);
    child = undefined;
  };
  try {
    await start();
    await wait(async () =>
      (await api("/api/workbench")).body.snapshot?.projects.length === 1
    );
    await wait(async () => !!(await api("/api/state")).body.catalog.scannedAt);
    const initial = (await api("/api/state")).body;
    for (
      const [id, name, path] of [
        ["configurations", "FixtureConfig", "Personal/Settings"],
        ["utilities", "FixtureTool", "Personal/Utilities"],
      ]
    ) {
      const module = initial.catalog.plugins.find((p: { id: string }) =>
        p.id === id
      );
      assertEquals(module.path, path);
      assertEquals(module.items.map((item: { name: string }) => item.name), [
        name,
      ]);
    }
    assert(
      initial.catalog.plugins.find((p: { id: string }) => p.id === "software")
        .items.some((p: { name: string }) => p.name === "fixture-one"),
    );
    assertEquals(
      (await api("/api/state")).body.chats.find((c: { id: string }) =>
        c.id === legacyChatId
      ).sourceId,
      "workspace",
    );
    assertEquals(
      (await api("/api/integrations", { id: "both", connected: false })).status,
      200,
    );
    assertEquals(
      (await api("/api/state")).body.integrations.map((
        x: { connected: boolean },
      ) => x.connected),
      [false, false],
    );
    assertEquals(
      (await api("/api/integrations", { id: "both", connected: true })).status,
      200,
    );
    const legacyJob = crypto.randomUUID();
    assertEquals(
      (await api("/api/jobs", {
        id: legacyJob,
        chatId: legacyChatId,
        prompt: "Legacy fixture",
      })).status,
      202,
    );
    await api("/api/jobs/" + legacyJob + "/cancel", {});
    await wait(async () =>
      !(await api("/api/state")).body.jobs.some((j: { state: string }) =>
        ["queued", "running"].includes(j.state)
      )
    );
    const chatId = crypto.randomUUID();
    assertEquals((await api("/api/chats", { id: chatId })).status, 201);
    assertEquals(
      (await api("/api/state")).body.chats.find((c: { id: string }) =>
        c.id === chatId
      ).sourceId,
      "workspace",
    );
    assertEquals(
      (await api("/api/integrations", { id: "projects", connected: false }))
        .status,
      200,
    );
    const crossSkills = join(projectsRoot, "X-Fixture", "skills");
    await Deno.mkdir(crossSkills, { recursive: true });
    await Deno.writeTextFile(
      join(local, "skills.local.json"),
      JSON.stringify({ skillsRoot: crossSkills }),
    );
    assertEquals((await api("/api/skills?fresh=1")).status, 400);
    assertEquals((await api("/api/skills/recover", {})).status, 400);
    await api("/api/refresh", {});
    assertEquals(
      (await api("/api/state")).body.catalog.plugins.some((p: { id: string }) =>
        p.id === "skills"
      ),
      false,
    );
    await Deno.remove(join(local, "skills.local.json"));
    const aliasJob = crypto.randomUUID();
    assertEquals(
      (await api("/api/jobs", {
        id: aliasJob,
        chatId,
        prompt: "Synthetic alias",
      })).status,
      202,
    );
    await api("/api/jobs/" + aliasJob + "/cancel", {});
    await wait(async () =>
      !(await api("/api/state")).body.jobs.some((j: { state: string }) =>
        ["queued", "running"].includes(j.state)
      )
    );
    assertEquals(
      (await api("/api/integrations", { id: "projects", connected: true }))
        .status,
      200,
    );
    assertEquals((await api("/api/skills?fresh=1")).status, 200);
    const jobId = crypto.randomUUID(), queuedId = crypto.randomUUID();
    assertEquals(
      (await api("/api/jobs", { id: jobId, chatId, prompt: "Synthetic hold" }))
        .status,
      202,
    );
    await wait(async () =>
      (await api("/api/jobs/" + jobId)).body.state === "running"
    );
    assertEquals(
      (await api("/api/jobs", { id: queuedId, prompt: "Synthetic queue" }))
        .status,
      202,
    );
    assertEquals(
      (await api("/api/integrations", { id: "workspace", connected: false }))
        .status,
      400,
    );
    assert(
      (await api("/api/state")).body.integrations.find((s: { id: string }) =>
        s.id === "workspace"
      ).connected,
    );
    await api("/api/jobs/" + queuedId + "/cancel", {});
    await api("/api/jobs/" + jobId + "/cancel", {});
    await wait(async () =>
      !(await api("/api/state")).body.jobs.some((j: { state: string }) =>
        ["queued", "running"].includes(j.state)
      )
    );
    assertEquals(
      (await api("/api/integrations", { id: "workspace", connected: false }))
        .status,
      200,
    );
    const projectAlias = join(projectsRoot, "AliasToWorkspace");
    await Deno.symlink(workspace, projectAlias);
    assertEquals(
      (await api("/api/chats", {
        id: crypto.randomUUID(),
        workspace: projectAlias,
      })).status,
      400,
    );
    await Deno.remove(projectAlias);
    assertEquals(
      (await api("/api/integrations", { id: "projects", connected: false }))
        .status,
      200,
    );
    const disconnected = (await api("/api/state")).body;
    assertEquals(disconnected.catalog.plugins, []);
    assertEquals(disconnected.workspaces, []);
    assertEquals((await api("/api/workbench")).body.snapshot, null);
    const retained = await Deno.readTextFile(
      join(local, "jobs", jobId + ".json"),
    );
    const scannedAt = disconnected.catalog.scannedAt;
    await Deno.rename(workspace, workspace + "-unmounted");
    await Deno.rename(projectsRoot, projectsRoot + "-unmounted");
    assertEquals((await api("/api/skills?fresh=1")).status, 400);
    assertEquals(
      (await api("/api/modules", { id: "software", enabled: false })).status,
      400,
    );
    assertEquals(
      (await api("/api/skills/preview", {
        folder: "fixture-skill",
        name: "new-name",
      })).status,
      400,
    );
    assertEquals(
      (await api("/api/chats", { id: crypto.randomUUID() })).status,
      400,
    );
    assertEquals(
      (await api("/api/jobs", {
        id: crypto.randomUUID(),
        prompt: "Must not run",
      })).status,
      400,
    );
    assertEquals(
      (await api("/api/jobs", {
        id: crypto.randomUUID(),
        prompt: "Must not run project",
        workspace: join(projectsRoot, "X-Fixture"),
      })).status,
      400,
    );
    await api("/api/refresh", {});
    await api("/api/workbench/refresh", {});
    assertEquals((await api("/api/state")).body.catalog.scannedAt, scannedAt);
    await stop();
    await start(); // Missing detached roots must not be read or prevent startup.
    const restarted = (await api("/api/state")).body;
    assertEquals(
      restarted.integrations.map((s: { connected: boolean }) => s.connected),
      [false, false],
    );
    assert(restarted.chats.some((c: { id: string }) => c.id === chatId));
    assertEquals(
      await Deno.readTextFile(join(local, "jobs", jobId + ".json")),
      retained,
    );
    // A configured-but-missing root differs from a deliberately disconnected root.
    assertEquals(
      (await api("/api/integrations", { id: "workspace", connected: true }))
        .status,
      200,
    );
    const missing = (await api("/api/state")).body;
    assert(missing.catalog.connected);
    assert(missing.catalog.plugins.some((p: { error?: string }) => p.error));
    await api("/api/integrations", { id: "workspace", connected: false });
    const alternative = join(base, "different-workspace");
    await Deno.mkdir(alternative);
    await Deno.remove(workspaceLink);
    await Deno.symlink(alternative, workspaceLink);
    assertEquals(
      (await api("/api/integrations", { id: "workspace", connected: true }))
        .status,
      400,
    );
    await Deno.remove(workspaceLink);
    await Deno.symlink(workspace, workspaceLink);
    await Deno.rename(workspace + "-unmounted", workspace);
    await Deno.rename(projectsRoot + "-unmounted", projectsRoot);
    await Deno.writeTextFile(
      join(workspace, "Brewfile"),
      'brew "fixture-one"\nbrew "fixture-two"\n',
    );
    for (const id of ["workspace", "projects"]) {
      assertEquals(
        (await api("/api/integrations", { id, connected: true })).status,
        200,
      );
    }
    assertEquals(
      (await api("/api/workbench")).body.snapshot.projects.length,
      1,
    );
    const reconnected = (await api("/api/state")).body;
    assert(
      reconnected.catalog.plugins.find((p: { id: string }) =>
        p.id === "software"
      ).items.some((p: { name: string }) => p.name === "fixture-two"),
    );
    assertEquals((await api("/api/skills?fresh=1")).status, 200);
    assertEquals(
      await Deno.readTextFile(join(local, "jobs", jobId + ".json")),
      retained,
    );
    await stop();
    await start();
    await wait(async () => !!(await api("/api/state")).body.catalog.scannedAt);
    const restored = (await api("/api/state")).body;
    assertEquals(
      restored.catalog.plugins.find((p: { id: string }) =>
        p.id === "configurations"
      ).items[0].name,
      "FixtureConfig",
    );
    assertEquals(
      restored.integrations.map((
        s: { connected: boolean },
      ) => s.connected),
      [true, true],
    );
    await stop();
    // A private override cannot use a symlink to escape its workspace.
    await Deno.symlink(base, join(workspace, "external-link"));
    await Deno.writeTextFile(
      join(local, "settings.local.json"),
      JSON.stringify({ sourcePaths: { configurations: "external-link" } }),
    );
    await start();
    await wait(async () => !!(await api("/api/state")).body.catalog.scannedAt);
    const escaped = (await api("/api/state")).body.catalog.plugins.find((
      p: { id: string },
    ) => p.id === "configurations");
    assert(escaped.error.includes("Source symlink escapes"));
    assertEquals(escaped.items, []);
    await stop();
    // Exercise a held reader and the timeout branch without a 30-second sleep.
    await Deno.writeTextFile(
      join(root, "drain-fixture.ts"),
      `
import {assert, assertRejects} from "@std/assert";
import {integrations} from "./backend/integrations.ts";
let release = () => {};
let read = integrations.read("workspace", () => new Promise<void>((resolve) => release = resolve));
let settled = false;
const change = integrations.change("workspace", false, () => false).then(() => settled = true);
await Promise.resolve();
assert(!settled);
assert(integrations.view()[0].changing);
await assertRejects(() => integrations.read("workspace", async () => {}), Error, "Source disconnected");
release(); await read; await change;
assert(!integrations.connected("workspace"));
await integrations.change("workspace", true, () => false);
read = integrations.read("workspace", () => new Promise<void>((resolve) => release = resolve));
const realNow = Date.now;
let calls = 0;
try {
  Date.now = () => calls++ ? 30001 : 0;
  await assertRejects(() => integrations.change("workspace", false, () => false), Error, "still in use");
} finally { Date.now = realNow; release(); await read; }
assert(integrations.connected("workspace"));
console.log("Reader drain and simulated deadline refusal: passed");
`,
    );
    const drain = await new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", "drain-fixture.ts"],
      cwd: root,
      env: {
        LOCALDESK_DATA: local,
        LOCALDESK_CONFIG: "",
        HOME: join(base, "empty-home"),
        CODEX_HOME: join(base, "empty-home", ".codex"),
      },
      stdout: "piped",
      stderr: "piped",
    }).output();
    assert(drain.success, new TextDecoder().decode(drain.stderr));
    console.log(new TextDecoder().decode(drain.stdout));
    console.log(
      "Synthetic connect/disconnect/restart/reconnect: passed; retained job bytes unchanged.",
    );
  } finally {
    await stop();
    if (logs.some((log) => /error:/i.test(log))) console.log(logs.join("\n"));
    await Deno.remove(base, { recursive: true });
  }
});
