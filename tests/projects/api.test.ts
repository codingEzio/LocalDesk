import { assertEquals, assertLess } from "@std/assert";
import { join } from "node:path";
import { ProjectStore } from "../../backend/projects/db/store.ts";
import { createApp } from "../../backend/projects/backend/server.ts";
import { scanRoot } from "../../backend/projects/backend/scan.ts";
import { VERSION } from "../../backend/projects/version.ts";
import { git } from "./git_fixture.ts";
import { isProjectsResponse } from "./contract.ts";

async function fixtureRoot(): Promise<string> {
  const root = Deno.makeTempDirSync();
  Deno.mkdirSync(join(root, "plain"));
  Deno.writeTextFileSync(join(root, "plain", "readme.txt"), "hi");
  const dirty = join(root, "dirty");
  await git(dirty, "init", "-b", "main");
  await git(dirty, "config", "user.email", "test@example.com");
  await git(dirty, "config", "user.name", "Test");
  Deno.writeTextFileSync(join(dirty, "a.txt"), "a");
  await git(dirty, "add", "a.txt");
  await git(dirty, "commit", "-m", "a");
  Deno.writeTextFileSync(join(dirty, "a.txt"), "changed");
  return root;
}

Deno.test("GET /health reports version", async () => {
  const store = new ProjectStore(":memory:");
  const app = createApp({ store, root: Deno.makeTempDirSync(), rescanMs: 0 });
  try {
    const response = await app.fetch(new Request("http://127.0.0.1/health"));
    assertEquals(response.status, 200);
    assertEquals(await response.json(), { ok: true, version: VERSION });
  } finally {
    app.close();
    store.close();
  }
});

Deno.test("GET /api/projects reads the snapshot and does not scan", async () => {
  const store = new ProjectStore(":memory:");
  let scans = 0;
  const app = createApp({
    store,
    root: "/tmp/unused",
    rescanMs: 0,
    scan: async (root) => {
      scans += 1;
      return await scanRoot(root);
    },
    pathExists: () => true,
  });
  try {
    store.replaceSnapshot("/tmp/unused", [
      {
        name: "Atlas",
        path: "/tmp/unused/Atlas",
        is_git: true,
        has_remote: true,
        is_dirty: true,
        is_unpushed: false,
        has_multiple_branches: false,
      },
    ]);
    const response = await app.fetch(
      new Request("http://127.0.0.1/api/projects"),
    );
    const body = await response.json();
    assertEquals(response.status, 200);
    assertEquals(scans, 0);
    assertEquals(isProjectsResponse(body), true);
    assertEquals(body.version, VERSION);
    assertEquals(body.projects.length, 1);
    assertEquals(body.projects[0].name, "Atlas");
    assertEquals(body.projects[0].is_dirty, true);
    assertEquals(body.projects[0].branch, null);
    assertEquals(body.projects[0].changed_count, null);
    assertEquals(body.projects[0].ahead_count, null);
    assertEquals(body.projects[0].behind_count, null);
    assertEquals(body.projects[0].upstream, null);
  } finally {
    app.close();
    store.close();
  }
});

Deno.test("POST /api/scan writes a new snapshot from disk", async () => {
  const root = await fixtureRoot();
  const store = new ProjectStore(":memory:");
  const app = createApp({ store, root, rescanMs: 0 });
  try {
    const empty = await app.fetch(new Request("http://127.0.0.1/api/projects"));
    assertEquals((await empty.json()).projects.length, 0);

    const scanned = await app.fetch(
      new Request("http://127.0.0.1/api/scan", { method: "POST" }),
    );
    const body = await scanned.json();
    assertEquals(scanned.status, 200);
    assertEquals(isProjectsResponse(body), true);
    assertEquals(
      body.projects.map((row: { name: string }) => row.name),
      ["dirty", "plain"],
    );
    assertEquals(body.projects[0].is_dirty, true);
    assertEquals(body.projects[0].branch, "main");
    assertEquals(body.projects[0].changed_count, 1);
    assertEquals(body.projects[0].ahead_count, null);
    assertEquals(body.projects[0].behind_count, null);
    assertEquals(body.projects[0].upstream, null);
    assertEquals(typeof body.scanned_at, "string");
    assertEquals(typeof body.duration_ms, "number");
    assertLess(0, body.duration_ms);

    const again = await app.fetch(new Request("http://127.0.0.1/api/projects"));
    const cached = await again.json();
    assertEquals(cached.projects[0].name, "dirty");
  } finally {
    app.close();
    store.close();
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("GET /api/projects omits a project whose directory was removed", async () => {
  const root = Deno.makeTempDirSync();
  const gone = join(root, "Gone");
  const stay = join(root, "Stay");
  Deno.mkdirSync(gone);
  Deno.mkdirSync(stay);
  const store = new ProjectStore(":memory:");
  store.replaceSnapshot(root, [
    {
      name: "Gone",
      path: gone,
      is_git: false,
      has_remote: false,
      is_dirty: false,
      is_unpushed: false,
      has_multiple_branches: false,
    },
    {
      name: "Stay",
      path: stay,
      is_git: false,
      has_remote: false,
      is_dirty: false,
      is_unpushed: false,
      has_multiple_branches: false,
    },
  ]);
  Deno.removeSync(gone, { recursive: true });
  const app = createApp({ store, root, rescanMs: 0 });
  try {
    const response = await app.fetch(
      new Request("http://127.0.0.1/api/projects"),
    );
    const body = await response.json();
    assertEquals(body.projects.map((row: { name: string }) => row.name), [
      "Stay",
    ]);
  } finally {
    app.close();
    store.close();
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("POST /api/scan drops a project after its directory is removed", async () => {
  const root = await fixtureRoot();
  const store = new ProjectStore(":memory:");
  const app = createApp({ store, root, rescanMs: 0 });
  try {
    await app.fetch(
      new Request("http://127.0.0.1/api/scan", { method: "POST" }),
    );
    Deno.removeSync(join(root, "dirty"), { recursive: true });
    const scanned = await app.fetch(
      new Request("http://127.0.0.1/api/scan", { method: "POST" }),
    );
    const body = await scanned.json();
    assertEquals(body.projects.map((row: { name: string }) => row.name), [
      "plain",
    ]);
  } finally {
    app.close();
    store.close();
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("GET /api/projects reuses the snapshot within 250ms", async () => {
  const store = new ProjectStore(":memory:");
  store.replaceSnapshot("/tmp/root", [{
    name: "Atlas",
    path: "/tmp/Atlas",
    is_git: false,
    has_remote: false,
    is_dirty: false,
    is_unpushed: false,
    has_multiple_branches: false,
  }]);
  let existsCalls = 0;
  const app = createApp({
    store,
    root: "/tmp/root",
    rescanMs: 0,
    pathExists: () => {
      existsCalls += 1;
      return true;
    },
  });
  try {
    const first = await app.fetch(new Request("http://127.0.0.1/api/projects"));
    assertEquals(first.status, 200);
    assertEquals(existsCalls, 1);
    const burst = await Promise.all(
      Array.from(
        { length: 20 },
        () => app.fetch(new Request("http://127.0.0.1/api/projects")),
      ),
    );
    assertEquals(burst.every((response) => response.status === 200), true);
    assertEquals(existsCalls, 1);
    for (const response of burst) await response.body?.cancel();
  } finally {
    app.close();
    store.close();
  }
});

Deno.test("GET /api/projects for 100 rows stays under 10ms", async () => {
  const store = new ProjectStore(":memory:");
  const projects = Array.from({ length: 100 }, (_, i) => ({
    name: `proj-${String(i).padStart(3, "0")}`,
    path: `/tmp/proj-${i}`,
    is_git: i % 2 === 0,
    has_remote: i % 3 === 0,
    is_dirty: i % 5 === 0,
    is_unpushed: i % 7 === 0,
    has_multiple_branches: i % 11 === 0,
  }));
  store.replaceSnapshot("/tmp/root", projects);
  const app = createApp({
    store,
    root: "/tmp/root",
    rescanMs: 0,
    pathExists: () => true,
  });
  try {
    const t0 = performance.now();
    const response = await app.fetch(
      new Request("http://127.0.0.1/api/projects"),
    );
    const body = await response.json();
    const ms = performance.now() - t0;
    assertEquals(body.projects.length, 100);
    assertLess(ms, 10);
  } finally {
    app.close();
    store.close();
  }
});

Deno.test("GET /api/projects includes persisted loc without recounting", async () => {
  const store = new ProjectStore(":memory:");
  let locCalls = 0;
  store.replaceSnapshot("/tmp/root", [
    {
      name: "Atlas",
      path: "/tmp/Atlas",
      is_git: true,
      has_remote: true,
      is_dirty: false,
      is_unpushed: false,
      has_multiple_branches: false,
    },
    {
      name: "O-BitOS",
      path: "/tmp/O-BitOS",
      is_git: true,
      has_remote: false,
      is_dirty: false,
      is_unpushed: false,
      has_multiple_branches: false,
    },
  ]);
  store.upsertLoc({
    name: "Atlas",
    profile: "rust",
    core: 12341,
    test: 2108,
    counted_at: "2026-09-11T00:00:00.000Z",
    fingerprint: "rust:1:1:1",
    parts: null,
  });
  const app = createApp({
    store,
    root: "/tmp/root",
    rescanMs: 0,
    pathExists: () => true,
    loc: {
      refresh: () => {
        locCalls += 1;
        return Promise.resolve();
      },
    },
  });
  try {
    const body = await (await app.fetch(
      new Request("http://127.0.0.1/api/projects"),
    )).json();
    assertEquals(locCalls, 0);
    assertEquals(body.projects[0].loc, {
      profile: "rust",
      core: 12341,
      test: 2108,
      counted_at: "2026-09-11T00:00:00.000Z",
    });
    assertEquals(body.projects[1].loc, undefined);
  } finally {
    app.close();
    store.close();
  }
});

Deno.test("POST /api/scan returns git snapshot without waiting for loc", async () => {
  const store = new ProjectStore(":memory:");
  let started = false;
  let finish!: () => void;
  const hang = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const app = createApp({
    store,
    root: "/tmp/root",
    rescanMs: 0,
    pathExists: () => true,
    scan: () =>
      Promise.resolve([{
        name: "Atlas",
        path: "/tmp/Atlas",
        is_git: true,
        has_remote: false,
        is_dirty: false,
        is_unpushed: false,
        has_multiple_branches: false,
      }]),
    loc: {
      refresh: async () => {
        started = true;
        await hang;
      },
    },
  });
  try {
    const t0 = performance.now();
    const scanned = await app.fetch(
      new Request("http://127.0.0.1/api/scan", { method: "POST" }),
    );
    const ms = performance.now() - t0;
    const body = await scanned.json();
    assertEquals(scanned.status, 200);
    assertEquals(body.projects[0].name, "Atlas");
    assertEquals(body.projects[0].loc, undefined);
    assertEquals(started, true);
    assertLess(ms, 200);
  } finally {
    finish();
    app.close();
    store.close();
  }
});
