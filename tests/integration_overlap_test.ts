import { assert, assertEquals } from "@std/assert";
import { join } from "node:path";

type Action = {
  id: "workspace" | "projects" | "both";
  connected: boolean;
  active?: boolean;
};
type Result = { outcome: string; state: boolean[] };
const offBoth: Action = { id: "both", connected: false };
const onBoth: Action = { id: "both", connected: true };
const offWorkspace: Action = { id: "workspace", connected: false };
const onWorkspace: Action = { id: "workspace", connected: true };

// A separate subprocess provides each simulated restart. It imports only the
// copied modules and its generated config, never the checkout's settings.
const driver = `
import { integrations } from "./backend/integrations.ts";
import { join } from "node:path";
const [mode, encoded, workspace] = Deno.args;
if (mode === "sequence") {
  const result = [];
  for (const action of JSON.parse(encoded)) {
    let outcome = "ok";
    try { await integrations.change(action.id, action.connected, () => !!action.active); }
    catch (error) {
      const message = String(error);
      outcome = message.includes("overlap") ? "overlap" : message.includes("identity changed") ? "identity" : message.includes("jobs in Activity") ? "active" : "other";
    }
    result.push({outcome, state: integrations.view().map((s) => s.connected)});
  }
  console.log(JSON.stringify(result));
} else if (mode === "drain") {
  let release, started;
  const open = new Promise((r) => { release = r; });
  const entered = new Promise((r) => { started = r; });
  const reader = integrations.read("workspace", async () => { started(); await open; });
  await entered;
  let done = false;
  const transition = integrations.change("both", false, () => false).then(() => { done = true; });
  while (!integrations.view().every((s) => s.changing)) await new Promise((r) => setTimeout(r, 0));
  const pending = !done && integrations.view().every((s) => s.connected);
  let blocked = false;
  try { await integrations.read("projects", async () => {}); } catch { blocked = true; }
  release(); await reader; await transition;
  console.log(JSON.stringify({pending, blocked, state: integrations.view().map((s) => s.connected)}));
} else if (mode === "write-failure") {
  const stateFile = join(Deno.env.get("LOCALDESK_DATA"), "integrations.json");
  await Deno.rename(stateFile, stateFile + ".fixture-backup");
  await Deno.mkdir(stateFile);
  let refused = false;
  try { await integrations.change("both", false, () => false); } catch { refused = true; }
  console.log(JSON.stringify({refused, state: integrations.view().map((s) => s.connected), changing: integrations.view().some((s) => s.changing)}));
} else if (mode === "no-probe") {
  await integrations.change("workspace", false, () => false);
  let probes = 0;
  const original = Deno.realPath;
  Deno.realPath = (path) => { if (String(path) === workspace) probes++; return original(path); };
  await integrations.change("projects", false, () => false);
  await integrations.change("projects", true, () => false);
  console.log(JSON.stringify({probes, state: integrations.view().map((s) => s.connected)}));
}
`;

Deno.test("source connections protect overlapping roots, restart and atomic failure", async (t) => {
  const outer = await Deno.realPath(
    await Deno.makeTempDir({ prefix: "localdesk-overlap-test-" }),
  );
  let successful = false;
  let serial = 0;
  async function step(name: string, fn: () => Promise<void>) {
    if (!await t.step(name, fn)) {
      throw new Error(`Synthetic step failed: ${name}`);
    }
  }
  async function fixture(
    layout: "equal" | "parent" | "reverse" | "alias" | "missing" | "separate",
  ) {
    const base = join(outer, String(serial++));
    const source = join(base, "source"), backend = join(source, "backend");
    const config = join(source, "config"),
      home = join(base, "home"),
      tmp = join(base, "tmp");
    await Promise.all(
      [backend, config, home, tmp].map((path) =>
        Deno.mkdir(path, { recursive: true })
      ),
    );
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
    let workspace = join(base, "workspace"),
      projects = join(base, "projects");
    await Deno.mkdir(workspace);
    if (layout === "equal") projects = workspace;
    else if (layout === "parent") {
      projects = join(workspace, "projects");
      await Deno.mkdir(projects);
    } else if (layout === "reverse") {
      await Deno.mkdir(projects);
      await Deno.remove(workspace);
      workspace = join(projects, "workspace");
      await Deno.mkdir(workspace);
    } else if (layout === "alias") await Deno.symlink(workspace, projects);
    else if (layout !== "missing") await Deno.mkdir(projects);
    const defaults = {
      workspace,
      projectsRoot: projects,
      frontendPort: 4100,
      backendPort: 4101,
      frontendHost: "localhost",
      shareCatalogOnLan: false,
      runtimeRegistry: null,
      codexPath: join(base, "synthetic-codex"),
      modelsFile: "synthetic-models.json",
      sessionArchiveDirectory: "synthetic-archive",
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
    await Deno.writeTextFile(
      join(config, "settings.json"),
      JSON.stringify(defaults),
    );
    const environment: Record<string, string> = {
      HOME: home,
      TMPDIR: tmp,
      PATH: "/usr/bin:/bin",
      LOCALDESK_DATA: join(base, "state"),
    };
    const cache = Deno.env.get("DENO_DIR");
    if (cache) environment.DENO_DIR = cache;
    async function run(mode: string, actions: Action[] = []) {
      const out = await new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "--cached-only",
          "-A",
          "driver.ts",
          mode,
          JSON.stringify(actions),
          workspace,
        ],
        cwd: source,
        clearEnv: true,
        env: environment,
        stdout: "piped",
        stderr: "piped",
      }).output();
      return {
        code: out.code,
        stdout: new TextDecoder().decode(out.stdout),
        stderr: new TextDecoder().decode(out.stderr),
      };
    }
    async function sequence(actions: Action[]): Promise<Result[]> {
      const out = await run("sequence", actions);
      assertEquals(out.code, 0, "synthetic child failed: " + out.stderr);
      return JSON.parse(out.stdout);
    }
    return { base, workspace, projects, run, sequence };
  }
  try {
    for (const layout of ["equal", "parent", "reverse", "alias"] as const) {
      await step(
        `overlap ${layout}: single refuses, explicit both succeeds`,
        async () => {
          const f = await fixture(layout);
          const out = await f.sequence([
            offWorkspace,
            offBoth,
            onWorkspace,
            onBoth,
          ]);
          assertEquals(out.map((x) => x.outcome), [
            "overlap",
            "ok",
            "overlap",
            "ok",
          ]);
          assertEquals(out.map((x) => x.state), [[true, true], [false, false], [
            false,
            false,
          ], [true, true]]);
        },
      );
    }
    await step("separate roots preserve state across restart", async () => {
      const f = await fixture("separate");
      assertEquals(await f.sequence([offWorkspace]), [{
        outcome: "ok",
        state: [false, true],
      }]);
      assertEquals(await f.sequence([onWorkspace]), [{
        outcome: "ok",
        state: [true, true],
      }]);
    });
    await step("unknown root requires explicit both", async () => {
      const f = await fixture("missing");
      const out = await f.sequence([
        offWorkspace,
        offBoth,
        onWorkspace,
        onBoth,
      ]);
      assertEquals(out.map((x) => x.outcome), [
        "overlap",
        "ok",
        "overlap",
        "ok",
      ]);
      assertEquals(out.map((x) => x.state), [[true, true], [false, false], [
        false,
        false,
      ], [true, true]]);
    });
    await step("reconnect rejects workspace retarget", async () => {
      const f = await fixture("separate");
      await f.sequence([offBoth]);
      await Deno.rename(f.workspace, join(f.base, "original"));
      const replacement = join(f.base, "replacement");
      await Deno.mkdir(replacement);
      await Deno.symlink(replacement, f.workspace);
      assertEquals(await f.sequence([onBoth]), [{
        outcome: "identity",
        state: [false, false],
      }]);
    });
    await step("active work rejects both disconnect", async () => {
      const f = await fixture("separate");
      assertEquals(await f.sequence([{ ...offBoth, active: true }]), [{
        outcome: "active",
        state: [true, true],
      }]);
    });
    await step(
      "both switches wait for readers and reject new reads",
      async () => {
        const f = await fixture("equal");
        const out = await f.run("drain");
        assertEquals(out.code, 0, out.stderr);
        assertEquals(JSON.parse(out.stdout), {
          pending: true,
          blocked: true,
          state: [false, false],
        });
      },
    );
    await step("overlapping state survives restart", async () => {
      const f = await fixture("equal");
      assertEquals(await f.sequence([offBoth]), [{
        outcome: "ok",
        state: [false, false],
      }]);
      assertEquals(await f.sequence([onWorkspace]), [{
        outcome: "overlap",
        state: [false, false],
      }]);
      assertEquals(await f.sequence([onBoth]), [{
        outcome: "ok",
        state: [true, true],
      }]);
    });
    await step(
      "atomic write failure keeps both states and clears pending",
      async () => {
        const f = await fixture("separate");
        const out = await f.run("write-failure");
        assertEquals(out.code, 0, out.stderr);
        assertEquals(JSON.parse(out.stdout), {
          refused: true,
          state: [true, true],
          changing: false,
        });
      },
    );
    await step(
      "detached source is not probed when changing other source",
      async () => {
        const f = await fixture("separate");
        const out = await f.run("no-probe");
        assertEquals(out.code, 0, out.stderr);
        assertEquals(JSON.parse(out.stdout), {
          probes: 0,
          state: [false, true],
        });
      },
    );
    await step(
      "startup refuses a retargeted connected projects root",
      async () => {
        const f = await fixture("separate");
        await f.sequence([offBoth, onBoth]);
        await Deno.rename(f.projects, join(f.base, "old-projects"));
        const replacement = join(f.base, "new-projects");
        await Deno.mkdir(replacement);
        await Deno.symlink(replacement, f.projects);
        const out = await f.run("sequence");
        assert(
          out.code !== 0 && out.stderr.includes("projects identity changed"),
          "startup must reject projects identity change",
        );
      },
    );
    successful = true;
  } finally {
    if (successful) await Deno.remove(outer, { recursive: true });
    else console.error(`Synthetic failure evidence retained at ${outer}`);
  }
});
