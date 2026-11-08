import { assert, assertEquals } from "@std/assert";
import { join } from "node:path";
import { lanState, lanWorkbench } from "../backend/lan_view.ts";
import { createStaticApp } from "../backend/static-web.ts";
import { createWebHandler } from "../backend/web.ts";
import { createLanPolicy } from "../backend/lan_network.ts";

Deno.test("LAN project view admits only explicit project and Git fields", () => {
  const project = {
    name: "Example",
    path: "/synthetic/Example",
    is_git: true,
    has_remote: true,
    is_dirty: false,
    is_unpushed: false,
    has_multiple_branches: false,
    branch: "main",
    changed_count: 0,
    ahead_count: 0,
    behind_count: 0,
    upstream: "origin/main",
    loc: { profile: "PRIVATE_SENTINEL", core: 1, test: 1, counted_at: "now" },
    runtime: { secret: "PRIVATE_SENTINEL" },
  };
  const view = {
    source: "PRIVATE_SENTINEL",
    fetchedAt: null,
    connected: true,
    stale: true,
    error: "PRIVATE_SENTINEL",
    scanning: false,
    snapshot: {
      version: "1",
      scanned_at: null,
      duration_ms: 1,
      projects: [project],
    },
  } as unknown as Parameters<typeof lanWorkbench>[0];
  const shared = lanWorkbench(view);
  assert(!JSON.stringify(shared).includes("PRIVATE_SENTINEL"));
  assertEquals(shared.snapshot?.projects[0].name, "Example");
  assertEquals(shared.snapshot?.projects[0].branch, "main");
  assertEquals(Object.keys(shared.snapshot!.projects[0]).sort(), [
    "ahead_count",
    "behind_count",
    "branch",
    "changed_count",
    "has_multiple_branches",
    "has_remote",
    "is_dirty",
    "is_git",
    "is_unpushed",
    "name",
    "path",
    "upstream",
  ]);
  assertEquals(
    lanWorkbench({ ...view, connected: false, snapshot: null }).snapshot,
    null,
  );
  assertEquals(lanState(true).canControl, false);
  assertEquals(lanState(true).catalog.plugins, []);
  assertEquals(lanState(true).runner.presets, []);
});

Deno.test("real LAN proxy and backend hide private catalog and deny writes", async () => {
  const dir = await Deno.makeTempDir({ prefix: "localdesk-lan-test-" });
  const workspace = join(dir, "workspace"), projects = join(dir, "projects");
  const source = join(dir, "source"), data = join(dir, "data");
  const config = join(dir, "settings.json");
  const sockets = [0, 0].map(() =>
    Deno.listen({ hostname: "127.0.0.1", port: 0 })
  );
  const frontendPort = sockets[0].addr.port, backendPort = sockets[1].addr.port;
  sockets.forEach((socket) => socket.close());
  let child: Deno.ChildProcess | undefined;
  let passed = false;
  try {
    await Deno.mkdir(join(workspace, "config", "PRIVATE_SENTINEL"), {
      recursive: true,
    });
    await Deno.mkdir(join(projects, "Example"), { recursive: true });
    await Deno.mkdir(join(source, "config"), { recursive: true });
    await Deno.mkdir(join(source, "plugins"));
    await Deno.mkdir(join(dir, "sessions"));
    const copied = await new Deno.Command("/bin/cp", {
      args: ["-R", "backend", source],
    }).output();
    assert(copied.success);
    for (const file of ["deno.json", "deno.lock", "config/settings.json"]) {
      await Deno.copyFile(file, join(source, file));
    }
    await Deno.writeTextFile(
      join(source, "plugins", "synthetic.json"),
      JSON.stringify({
        id: "synthetic",
        version: 1,
        order: 0,
        kind: "directories",
        path: "config",
        icon: "folder",
        title: { en: "Synthetic" },
        enabled: true,
      }),
    );
    await Deno.writeTextFile(
      config,
      JSON.stringify({
        workspace,
        projectsRoot: projects,
        frontendPort,
        backendPort,
        shareCatalogOnLan: true,
        runtimeRegistry: null,
        codexPath: join(dir, "no-codex"),
        modelsFile: join(dir, "no-models"),
        sessionArchiveDirectory: join(dir, "sessions"),
        preset: "private-sentinel",
        presets: [],
      }),
    );
    child = new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", "backend/main.ts"],
      cwd: source,
      env: { LOCALDESK_DATA: data, LOCALDESK_CONFIG: config },
      stdout: "null",
      stderr: "piped",
    }).spawn();
    const base = `http://127.0.0.1:${backendPort}`;
    const deadline = Date.now() + 15000;
    while (true) {
      try {
        if ((await fetch(base + "/health")).ok) break;
      } catch { /* Starting. */ }
      if (Date.now() >= deadline) {
        throw Error("Synthetic backend did not start");
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const token = (await Deno.readTextFile(join(data, "capability"))).trim();
    const staticRoot = join(dir, "static");
    await Deno.mkdir(staticRoot);
    await Deno.writeTextFile(
      join(staticRoot, "index.html"),
      "<main>Fixture</main>",
    );
    const app = await createStaticApp({
      root: staticRoot,
      backend: base,
      cacheBytes: 0,
    });
    const proxy = createWebHandler({
      token,
      frontendPort,
      localAddresses: ["127.0.0.1", "192.0.2.1"],
      shareCatalogOnLan: true,
      isLanPeer: createLanPolicy(["wifi"], () => [{
        name: "wifi",
        address: "192.0.2.1",
        cidr: "192.0.2.1/24",
      }]),
      fetch: app.fetch,
    });
    const remote = (path: string, init?: RequestInit) =>
      proxy(
        new Request(`http://192.0.2.1:${frontendPort}${path}`, init),
        "192.0.2.2",
      );
    const remoteState = await (await remote("/api/state", {
      headers: { authorization: `Bearer ${token}` },
    })).json();
    assertEquals(remoteState.canControl, false);
    assertEquals(remoteState.readOnly, true);
    assertEquals(remoteState.catalog.plugins, []);
    assertEquals(remoteState.runner.presets, []);
    assert(!JSON.stringify(remoteState).includes("PRIVATE_SENTINEL"));
    let list;
    do {
      list = await (await remote("/api/workbench")).json();
      if (
        list.snapshot?.projects.some((p: { name: string }) =>
          p.name === "Example"
        )
      ) break;
      if (Date.now() >= deadline) {
        const localView = await (await fetch(base + "/api/workbench", {
          headers: { authorization: `Bearer ${token}` },
        })).json();
        throw Error(`Synthetic project was not scanned: ${
          JSON.stringify({
            connected: localView.connected,
            scanning: localView.scanning,
            error: localView.error,
            count: localView.snapshot?.projects?.length,
          })
        }`);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    } while (true);
    assertEquals(list.snapshot.projects[0].name, "Example");
    assert(!JSON.stringify(list).includes("PRIVATE_SENTINEL"));
    assertEquals("loc" in list.snapshot.projects[0], false);
    assertEquals("runtime" in list.snapshot.projects[0], false);
    assertEquals((await remote("/api/jobs", { method: "POST" })).status, 403);
    const local = await proxy(
      new Request(`http://localhost:${frontendPort}/api/state`),
      "127.0.0.1",
    );
    const localState = await local.json();
    assertEquals(localState.canControl, true);
    assert(JSON.stringify(localState).includes("PRIVATE_SENTINEL"));
    passed = true;
  } finally {
    if (child) {
      try {
        child.kill("SIGTERM");
      } catch { /* Already exited. */ }
      await child.status;
    }
    if (passed) await Deno.remove(dir, { recursive: true });
    else console.error(`Synthetic failure fixture retained: ${dir}`);
  }
});
