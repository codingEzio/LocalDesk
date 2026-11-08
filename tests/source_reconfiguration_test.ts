import { assert, assertEquals } from "@std/assert";
import { join } from "node:path";

type Action = { id: "workspace" | "projects" | "both"; connected: boolean };
const disconnectWorkspace: Action = { id: "workspace", connected: false };
const reconnectWorkspace: Action = { id: "workspace", connected: true };
const driver = `
const [actions, watched] = Deno.args;
const paths = JSON.parse(watched); let probes = 0;
const original = Deno.realPath;
Deno.realPath = (path) => { if (paths.includes(String(path))) probes++; return original(path); };
try {
  const {integrations} = await import("./backend/integrations.ts");
  for (const action of JSON.parse(actions)) {
    await integrations.change(action.id, action.connected, () => false);
  }
  console.log(JSON.stringify({ok:true, probes, state:integrations.view().map((s)=>s.connected), requiresBoth:integrations.view().some((s)=>s.requiresBoth)}));
} catch (error) {
  console.log(JSON.stringify({ok:false, probes, error:String(error)}));
}
`;

Deno.test("explicit source reconfiguration and same-path retarget remain distinct", async (t) => {
  const outer = await Deno.realPath(
    await Deno.makeTempDir({ prefix: "localdesk-rebind-test-" }),
  );
  let success = false, counter = 0;
  async function step(name: string, fn: () => Promise<void>) {
    if (!await t.step(name, fn)) {
      throw new Error(`Synthetic step failed: ${name}`);
    }
  }
  async function fixture() {
    const base = join(outer, String(counter++)),
      source = join(base, "source");
    const backend = join(source, "backend"), config = join(source, "config");
    const workspace = join(base, "workspace"),
      projects = join(base, "projects");
    const home = join(base, "home"),
      tmp = join(base, "tmp"),
      state = join(base, "state");
    for (const path of [backend, config, workspace, projects, home, tmp]) {
      await Deno.mkdir(path, { recursive: true });
    }
    for (
      const file of [
        "integrations.ts",
        "config.ts",
        "settings.ts",
        "runtime_paths.ts",
        "atomic_json.ts",
      ]
    ) {
      await Deno.copyFile(
        new URL(`../backend/${file}`, import.meta.url),
        join(backend, file),
      );
    }
    await Deno.writeTextFile(join(source, "driver.ts"), driver);
    const defaults: Record<string, unknown> = {
      workspace,
      projectsRoot: projects,
      frontendPort: 4100,
      backendPort: 4101,
      frontendHost: "localhost",
      shareCatalogOnLan: false,
      runtimeRegistry: null,
      codexPath: join(base, "synthetic-codex"),
      modelsFile: "model.json",
      sessionArchiveDirectory: "archive",
      preset: "default",
      presets: [],
      approvalMode: "sandbox",
      sessionOperationTimeoutMs: 1000,
      scanIntervalMs: 1000,
      projectScanIntervalMs: 1000,
      maxQueuedJobs: 3,
      maxPromptCharacters: 1000,
      maxJobMinutes: 1,
      maxOutputBytes: 1000,
      discoveryDirectories: [],
    };
    async function configure(patch: Record<string, unknown> = {}) {
      Object.assign(defaults, patch);
      await Deno.writeTextFile(
        join(config, "settings.json"),
        JSON.stringify(defaults),
      );
    }
    await configure();
    const env: Record<string, string> = {
      HOME: home,
      TMPDIR: tmp,
      PATH: "/usr/bin:/bin",
      LOCALDESK_DATA: state,
    };
    const cache = Deno.env.get("DENO_DIR");
    if (cache) env.DENO_DIR = cache;
    async function run(actions: Action[] = [], watched: string[] = []) {
      const out = await new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "--cached-only",
          "-A",
          "driver.ts",
          JSON.stringify(actions),
          JSON.stringify(watched),
        ],
        cwd: source,
        clearEnv: true,
        env,
        stdout: "piped",
        stderr: "piped",
      }).output();
      assertEquals(out.code, 0, new TextDecoder().decode(out.stderr));
      return JSON.parse(new TextDecoder().decode(out.stdout)) as {
        ok: boolean;
        probes: number;
        state?: boolean[];
        requiresBoth?: boolean;
        error?: string;
      };
    }
    async function bind() {
      const result = await run([disconnectWorkspace, reconnectWorkspace]);
      assert(result.ok, "initial synthetic binding failed: " + result.error);
    }
    return { base, state, workspace, projects, configure, run, bind };
  }
  try {
    for (const key of ["workspace", "projectsRoot"] as const) {
      await step(
        `explicit ${key} change rebinds when both connected`,
        async () => {
          const f = await fixture();
          await f.bind();
          const changed = join(f.base, "new-source");
          await Deno.mkdir(changed);
          await f.configure({ [key]: changed });
          const result = await f.run();
          assert(result.ok, result.error);
          const restarted = await f.run();
          assert(restarted.ok, restarted.error);
          assertEquals(restarted.state, [true, true]);
        },
      );
    }
    for (const key of ["workspace", "projectsRoot"] as const) {
      await step(
        `rebind ${key} persists new identity before another restart`,
        async () => {
          const f = await fixture();
          await f.bind();
          const first = join(f.base, "first-target"),
            second = join(f.base, "second-target"),
            alias = join(f.base, "new-alias");
          await Deno.mkdir(first);
          await Deno.mkdir(second);
          await Deno.symlink(first, alias);
          await f.configure({ [key]: alias });
          const rebound = await f.run();
          assert(rebound.ok, rebound.error);
          await Deno.remove(alias);
          await Deno.symlink(second, alias);
          const result = await f.run();
          assert(!result.ok && /identity changed/i.test(result.error ?? ""));
        },
      );
    }
    for (const key of ["workspace", "projectsRoot"] as const) {
      await step(
        `same ${key} path retarget is refused on startup`,
        async () => {
          const f = await fixture();
          const original = key === "workspace" ? f.workspace : f.projects;
          const alias = join(f.base, "alias");
          await Deno.symlink(original, alias);
          await f.configure({ [key]: alias });
          await f.bind();
          const changed = join(f.base, "new-target");
          await Deno.mkdir(changed);
          await Deno.remove(alias);
          await Deno.symlink(changed, alias);
          const result = await f.run();
          assert(!result.ok && /identity changed/i.test(result.error ?? ""));
        },
      );
    }
    await step(
      "mixed state allows safe explicit connected-root change without probing detached source",
      async () => {
        const f = await fixture();
        await f.bind();
        assert((await f.run([disconnectWorkspace])).ok);
        const changed = join(f.base, "new-projects");
        await Deno.mkdir(changed);
        await f.configure({ projectsRoot: changed });
        const result = await f.run([], [f.workspace]);
        assert(result.ok, result.error);
        assertEquals(result.probes, 0);
        assertEquals(result.state, [false, true]);
        assert((await f.run()).ok);
      },
    );
    await step(
      "mixed state rejects new connected root overlapping detached root",
      async () => {
        const f = await fixture();
        await f.bind();
        assert((await f.run([disconnectWorkspace])).ok);
        const before = await Deno.readTextFile(
          join(f.state, "integrations.json"),
        );
        await f.configure({ projectsRoot: f.base });
        const result = await f.run([], [f.workspace]);
        assert(
          !result.ok && /overlap|safely matched/i.test(result.error ?? ""),
        );
        assertEquals(result.probes, 0);
        assertEquals(
          await Deno.readTextFile(join(f.state, "integrations.json")),
          before,
        );
      },
    );
    await step(
      "detached changed source preserves old binding across restarts until explicit both reconnect",
      async () => {
        const f = await fixture();
        await f.bind();
        assert((await f.run([disconnectWorkspace])).ok);
        const changed = join(f.base, "new-workspace");
        await Deno.mkdir(changed);
        const before = JSON.parse(
          await Deno.readTextFile(join(f.state, "integrations.json")),
        );
        await f.configure({ workspace: changed });
        const cold = await f.run([], [f.workspace, changed]);
        assert(cold.ok, cold.error);
        assertEquals(cold.probes, 0);
        assertEquals(cold.state, [false, false]);
        assertEquals(cold.requiresBoth, true);
        const paused = JSON.parse(
          await Deno.readTextFile(join(f.state, "integrations.json")),
        );
        for (
          const key of [
            "workspace",
            "projects",
            "workspaceCanonical",
            "workspaceConfigured",
            "projectsCanonical",
            "projectsConfigured",
          ]
        ) assertEquals(paused[key], before[key]);
        assertEquals(paused.pendingWorkspaceConfigured, changed);
        assertEquals(paused.requiresBoth, true);
        const restarted = await f.run([], [f.workspace, changed]);
        assert(restarted.ok, restarted.error);
        assertEquals(restarted.probes, 0);
        assertEquals(restarted.state, [false, false]);
        assertEquals(restarted.requiresBoth, true);
        assertEquals(
          JSON.parse(
            await Deno.readTextFile(join(f.state, "integrations.json")),
          ),
          paused,
        );
        const connected = await f.run([{ id: "both", connected: true }]);
        assert(connected.ok, connected.error);
        assertEquals(connected.state, [true, true]);
        const after = JSON.parse(
          await Deno.readTextFile(join(f.state, "integrations.json")),
        );
        assertEquals(after.workspaceConfigured, changed);
        assertEquals(after.workspaceCanonical, changed);
        assertEquals(after.pendingWorkspaceConfigured, undefined);
        assert((await f.run()).ok);
      },
    );
    await step(
      "restoring old config cancels pending rebind without probing detached root",
      async () => {
        const f = await fixture();
        await f.bind();
        assert((await f.run([disconnectWorkspace])).ok);
        const before = JSON.parse(
          await Deno.readTextFile(join(f.state, "integrations.json")),
        );
        const changed = join(f.base, "other-workspace");
        await Deno.mkdir(changed);
        await f.configure({ workspace: changed });
        assert((await f.run()).ok);
        await f.configure({ workspace: f.workspace });
        const restored = await f.run([], [f.workspace, changed]);
        assert(restored.ok, restored.error);
        assertEquals(restored.probes, 0);
        assertEquals(restored.state, [false, true]);
        assertEquals(restored.requiresBoth, false);
        const after = JSON.parse(
          await Deno.readTextFile(join(f.state, "integrations.json")),
        );
        assertEquals(after.workspaceCanonical, before.workspaceCanonical);
        assertEquals(after.workspaceConfigured, before.workspaceConfigured);
        assertEquals(after.pendingWorkspaceConfigured, undefined);
      },
    );
    await step(
      "legacy state without configured identity fails closed when canonical changes",
      async () => {
        const f = await fixture();
        await Deno.mkdir(f.state, { recursive: true });
        await Deno.writeTextFile(
          join(f.state, "integrations.json"),
          JSON.stringify({
            workspace: true,
            projects: true,
            workspaceCanonical: f.workspace,
            projectsCanonical: f.projects,
          }),
        );
        const changed = join(f.base, "unknown-origin");
        await Deno.mkdir(changed);
        await f.configure({ workspace: changed });
        const result = await f.run();
        assert(
          !result.ok && /identity|unknown|review/i.test(result.error ?? ""),
        );
      },
    );
    success = true;
  } finally {
    if (success) await Deno.remove(outer, { recursive: true });
    else console.error(`Synthetic failure evidence retained at ${outer}`);
  }
});
