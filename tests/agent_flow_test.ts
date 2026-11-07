import { assert, assertEquals } from "@std/assert";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

// A whole HTTP/CLI flow in a disposable workspace. No real Codex calls or user workspace scans.
Deno.test("isolated HTTP/CLI privacy, continuity, queue cancellation and restart durability", async () => {
  // Match the physical paths used by persisted workspace identities on macOS.
  const base = await Deno.realPath(
    await Deno.makeTempDir({
      prefix: "delete_after_use_localdesk_",
    }),
  );
  const root = join(base, "desk");
  const local = join(base, "private state");
  await Deno.mkdir(root);
  for (const name of ["backend", "plugins"]) {
    await new Deno.Command("/bin/cp", { args: ["-R", name, join(root, name)] })
      .output();
  }
  // The copied backend uses the same import map and pinned JSR dependencies.
  for (const name of ["deno.json", "deno.lock"]) {
    await Deno.copyFile(name, join(root, name));
  }
  await Deno.mkdir(join(root, "config"));
  for (const name of ["settings.json", "agent_instructions.md"]) {
    await Deno.copyFile(join("config", name), join(root, "config", name));
  }
  const frontendListener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const backendListener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const frontendPort = frontendListener.addr.port;
  const backendPort = backendListener.addr.port;
  frontendListener.close();
  backendListener.close();
  const settings = JSON.parse(
    await Deno.readTextFile(join(root, "config/settings.json")),
  );
  const workspace = join(base, "workspace");
  const projectsRoot = join(base, "projects");
  const projectWorkspace = join(projectsRoot, "Z-Fixture");
  await Deno.mkdir(projectWorkspace, { recursive: true });
  settings.projectsRoot = projectsRoot;
  await Deno.mkdir(workspace);
  const modelsFile = join(base, "models.json");
  await Deno.writeTextFile(
    modelsFile,
    JSON.stringify({
      fetched_at: new Date().toISOString(),
      models: ["test-luna", "test-sol"].map((slug) => ({
        slug,
        visibility: "list",
        display_name: slug,
        supported_reasoning_levels: ["low", "medium", "xhigh"].map(
          (effort) => ({ effort }),
        ),
        service_tiers: [{ id: "priority" }],
      })),
    }),
  );
  const fixture = join(base, "fixture.ts");
  await Deno.writeTextFile(
    fixture,
    `
const a=Deno.args;
if(['archive','unarchive'].includes(a[0])){console.log('OK');Deno.exit(0);}
const prompt=await new Response(Deno.stdin.readable).text();
const thread=a.includes('resume')?a[a.indexOf('resume')+1]:crypto.randomUUID();
console.log(JSON.stringify({type:'thread.started',thread_id:thread}));
if (prompt.endsWith("HOLD_FOR_CANCEL")) await new Promise(()=>setInterval(()=>{},1000));
await new Promise(r=>setTimeout(r,120));
const result=JSON.stringify({thread,prompt,args:a,cwd:Deno.cwd()});
await Deno.writeTextFile(a[a.indexOf('--output-last-message')+1],result);
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:result}}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1}}));
`,
  );
  const runner = join(base, "codex");
  await Deno.writeTextFile(
    runner,
    `#!/bin/sh\nexec '${Deno.execPath()}' run -A '${fixture}' "$@"\n`,
    { mode: 0o700 },
  );
  Object.assign(settings, {
    workspace,
    frontendPort,
    backendPort,
    preset: "luna",
    presets: [
      { name: "luna", model: "test-luna", effort: "xhigh", tier: "priority" },
      { name: "sol", model: "test-sol", effort: "medium", tier: "default" },
    ],
    maxQueuedJobs: 2,
    runtimeRegistry: null,
    modelsFile,
    codexPath: runner,
    sessionArchiveDirectory: join(base, "archived_sessions"),
  });
  await Deno.writeTextFile(
    join(root, "config/settings.json"),
    JSON.stringify(settings),
  );
  await Deno.mkdir(join(local, "jobs"), { recursive: true });
  const legacyId = crypto.randomUUID(), legacyThread = crypto.randomUUID();
  await Deno.writeTextFile(
    join(local, "jobs", legacyId + ".json"),
    JSON.stringify({
      id: legacyId,
      prompt: "old turn",
      createdAt: "2026-01-01T00:00:00Z",
      state: "completed",
      threadId: legacyThread,
      result: "preserved",
      events: [],
    }),
  );
  const logs: string[] = [];
  const startServer = () => {
    const child = new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", "backend/main.ts"],
      cwd: root,
      env: {
        LOCALDESK_DATA: local,
        LOCALDESK_CONFIG: "",
        CODEX_HOME: join(base, "codex-home"),
      },
      stdout: "null",
      stderr: "piped",
    }).spawn();
    return { child, stderr: new Response(child.stderr).text() };
  };
  let server = startServer();
  async function stopServer() {
    try {
      server.child.kill("SIGTERM");
    } catch { /* Preserve diagnostics if startup already exited. */ }
    await server.child.status;
    logs.push(await server.stderr);
  }
  const origin = `http://localhost:${frontendPort}`;
  const url = `http://127.0.0.1:${backendPort}`;
  let token = "";
  const api = async (path: string, body?: unknown) => {
    const res = await fetch(url + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        authorization: "Bearer " + token,
        origin,
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json();
    return { status: res.status, data };
  };
  async function until(fn: () => Promise<boolean>) {
    for (let i = 0; i < 250; i++) {
      if (await fn()) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw Error("Timed out");
  }
  try {
    await until(async () => {
      try {
        token = (await Deno.readTextFile(join(local, "capability")))
          .trim();
        return (await api("/api/state")).data.jobs?.length === 1;
      } catch {
        return false;
      }
    });
    for (const path of ["/api/state", "/api/workbench", "/api/jobs"]) {
      const denied = await fetch(url + path);
      assertEquals(denied.status, 403);
      await denied.body?.cancel();
    }
    const foreign = await fetch(url + "/api/state", {
      headers: {
        authorization: "Bearer " + token,
        origin: "http://foreign.example",
      },
    });
    assertEquals(foreign.status, 403);
    await foreign.body?.cancel();
    const missingOrigin = await fetch(url + "/api/refresh", {
      method: "POST",
      headers: { authorization: "Bearer " + token },
    });
    assertEquals(missingOrigin.status, 403);
    await missingOrigin.body?.cancel();
    const initial = (await api("/api/state")).data;
    assertEquals(initial.chats.length, 1);
    assertEquals(initial.chats[0].threadId, legacyThread);
    assertEquals(initial.runner.presets.length, 2);
    const chat =
      (await api("/api/chats", { id: crypto.randomUUID(), title: "Hello" }))
        .data;
    const execution = { preset: "sol", effort: "medium", fast: false };
    const firstId = crypto.randomUUID(), secondId = crypto.randomUUID();
    assertEquals(
      (await api("/api/jobs", {
        id: firstId,
        prompt: "Hello World",
        chatId: chat.id,
        execution,
      })).status,
      202,
    );
    assertEquals(
      (await api("/api/jobs", {
        id: secondId,
        prompt: "continue",
        chatId: chat.id,
        execution: { preset: "luna", effort: "low", fast: true },
      })).status,
      202,
    );
    await until(async () =>
      (await api("/api/jobs/" + secondId)).data.state === "completed"
    );
    const first = (await api("/api/jobs/" + firstId)).data,
      second = (await api("/api/jobs/" + secondId)).data;
    assertEquals(first.threadId, second.threadId);
    assertEquals(second.resumeThread, first.threadId);
    assertEquals([first.model, first.effort, first.tier], [
      "test-sol",
      "medium",
      "default",
    ]);
    assertEquals([second.model, second.effort, second.tier], [
      "test-luna",
      "low",
      "priority",
    ]);
    const argv = JSON.parse(first.result).args;
    assert(argv.includes('service_tier="default"'));
    assertEquals(argv[argv.indexOf("--sandbox") + 1], "workspace-write");
    assert(argv.includes('approval_policy="never"'));
    assert(!argv.includes("--approve-for-me"));
    assertEquals(
      (await api("/api/jobs", {
        id: firstId,
        prompt: "Hello World",
        chatId: chat.id,
        execution,
      })).status,
      202,
    );
    assertEquals(
      (await api("/api/jobs", {
        id: firstId,
        prompt: "Hello World",
        chatId: chat.id,
        execution: { ...execution, fast: true },
      })).status,
      400,
    );
    assertEquals(
      (await api("/api/jobs", {
        id: crypto.randomUUID(),
        prompt: "invalid",
        chatId: chat.id,
        execution: { ...execution, effort: "ultra" },
      })).status,
      400,
    );
    assertEquals(
      (await api("/api/chats/" + chat.id, { archived: true })).status,
      200,
    );
    assertEquals(
      (await api("/api/jobs", {
        id: crypto.randomUUID(),
        prompt: "blocked",
        chatId: chat.id,
        execution,
      })).status,
      400,
    );
    assertEquals(
      (await api("/api/chats/" + chat.id, { archived: false })).status,
      200,
    );
    const next =
      (await api("/api/chats", { id: crypto.randomUUID(), title: "Separate" }))
        .data;
    const nextId = crypto.randomUUID();
    await api("/api/jobs", {
      id: nextId,
      prompt: "new",
      chatId: next.id,
      execution,
    });
    await until(async () =>
      (await api("/api/jobs/" + nextId)).data.state === "completed"
    );
    assert((await api("/api/jobs/" + nextId)).data.threadId !== first.threadId);
    // A project target must affect actual process cwd and never reuse another
    // workspace's thread. These are concrete data-isolation regression risks.
    assertEquals(
      (await api("/api/chats", {
        id: crypto.randomUUID(),
        workspace: base,
      })).status,
      400,
    );
    const scoped = (await api("/api/chats", {
      id: crypto.randomUUID(),
      workspace: projectWorkspace,
      title: "Project",
    })).data;
    assertEquals(scoped.workspace, await Deno.realPath(projectWorkspace));
    const scopedJobId = crypto.randomUUID();
    assertEquals(
      (await api("/api/jobs", {
        id: scopedJobId,
        prompt: "where",
        chatId: scoped.id,
        workspace: projectWorkspace,
        execution,
      })).status,
      202,
    );
    await until(async () =>
      (await api("/api/jobs/" + scopedJobId)).data.state === "completed"
    );
    const scopedJob = (await api("/api/jobs/" + scopedJobId)).data;
    assertEquals(
      JSON.parse(scopedJob.result).cwd,
      await Deno.realPath(projectWorkspace),
    );
    assertEquals(scopedJob.workspace, await Deno.realPath(projectWorkspace));
    assertEquals(
      (await api("/api/jobs", {
        id: crypto.randomUUID(),
        prompt: "wrong workspace",
        chatId: scoped.id,
        workspace,
        execution,
      })).status,
      400,
    );
    const emptyScoped = (await api("/api/chats", {
      id: crypto.randomUUID(),
      workspace: projectWorkspace,
    })).data;
    assertEquals(
      (await api("/api/jobs", {
        id: crypto.randomUUID(),
        prompt: "cross-thread",
        chatId: emptyScoped.id,
        resumeThread: first.threadId,
        execution,
      })).status,
      400,
    );
    assertEquals(
      (await api("/api/chats", {
        id: scoped.id,
        workspace,
      })).status,
      400,
    );
    // The whole HTTP service stays readable while another connection holds a write lock.
    const writer = new DatabaseSync(join(local, "projects.sqlite3"));
    writer.exec("BEGIN IMMEDIATE");
    try {
      const start = performance.now();
      assertEquals((await api("/api/workbench")).status, 200);
      assert(
        performance.now() - start < 250,
        "project GET blocked on SQLite write lock",
      );
    } finally {
      writer.exec("ROLLBACK");
      writer.close();
    }
    const saved = JSON.parse(
      await Deno.readTextFile(join(local, "chats.json")),
    );
    assert(
      saved.some((c: { id: string; threadId: string }) =>
        c.id === chat.id && c.threadId === first.threadId
      ),
    );
    // Hold one synthetic CLI open to observe bounded queuing and both cancel paths.
    const runningId = crypto.randomUUID(), queuedId = crypto.randomUUID();
    assertEquals(
      (await api("/api/jobs", {
        id: runningId,
        prompt: "HOLD_FOR_CANCEL",
        execution,
      })).status,
      202,
    );
    await until(async () => {
      const job = (await api("/api/jobs/" + runningId)).data;
      return job.state === "running" && typeof job.threadId === "string";
    });
    assertEquals(
      (await api("/api/jobs", {
        id: queuedId,
        prompt: "must stay queued",
        execution,
      })).status,
      202,
    );
    assertEquals((await api("/api/jobs/" + queuedId)).data.state, "queued");
    const overflow = await api("/api/jobs", {
      id: crypto.randomUUID(),
      prompt: "overflow",
      execution,
    });
    assertEquals(overflow.status, 400);
    assertEquals(overflow.data.error, "Queue full");
    assertEquals(
      (await api("/api/jobs/" + queuedId + "/cancel", {})).data.state,
      "cancelled",
    );
    assertEquals(
      (await api("/api/jobs/" + runningId + "/cancel", {})).data.state,
      "cancelled",
    );
    await until(async () => {
      const job = (await api("/api/jobs/" + runningId)).data;
      return job.state === "cancelled" && typeof job.exitCode === "number";
    });
    const queued = (await api("/api/jobs/" + queuedId)).data;
    assertEquals(queued.startedAt, undefined);
    assertEquals(queued.threadId, undefined);
    // Restart the isolated server and require durable chats/jobs plus explicit resume.
    await stopServer();
    // Review mode is opt-in; restarting also proves an explicit local override.
    await Deno.writeTextFile(
      join(local, "settings.local.json"),
      JSON.stringify({ approvalMode: "review" }),
    );
    server = startServer();
    await until(async () => {
      try {
        return (await api("/api/state")).data.ready === true;
      } catch {
        return false;
      }
    });
    const recovered = (await api("/api/state")).data;
    assert(
      recovered.chats.some((c: { id: string; threadId: string }) =>
        c.id === chat.id && c.threadId === first.threadId
      ),
    );
    assertEquals((await api("/api/jobs/" + firstId)).data.result, first.result);
    assertEquals((await api("/api/jobs/" + runningId)).data.state, "cancelled");
    assertEquals((await api("/api/jobs/" + queuedId)).data.state, "cancelled");
    const resumedId = crypto.randomUUID();
    assertEquals(
      (await api("/api/jobs", {
        id: resumedId,
        prompt: "resume after restart",
        chatId: chat.id,
        execution,
      })).status,
      202,
    );
    await until(async () =>
      (await api("/api/jobs/" + resumedId)).data.state === "completed"
    );
    const resumed = (await api("/api/jobs/" + resumedId)).data;
    assertEquals(resumed.threadId, first.threadId);
    assertEquals(resumed.resumeThread, first.threadId);
    const reviewArgs = JSON.parse(resumed.result).args;
    assert(reviewArgs.includes("--approve-for-me"));
    assert(!reviewArgs.includes("--sandbox"));
    assert(!reviewArgs.includes('approval_policy="never"'));
  } finally {
    await stopServer();
    await Deno.mkdir("Local", { recursive: true });
    await Deno.writeTextFile(
      "Local/agent-flow-server.log",
      logs.join("\n--- restart ---\n"),
    );
    await Deno.remove(base, { recursive: true });
  }
});
