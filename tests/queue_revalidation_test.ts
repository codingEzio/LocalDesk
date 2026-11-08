import { assertEquals } from "@std/assert";
import { join } from "node:path";

const first = "11111111-1111-4111-8111-111111111111";
const second = "22222222-2222-4222-8222-222222222222";
const driver = `
import { Jobs } from "./backend/jobs.ts";
import { integrations } from "./backend/integrations.ts";
import { refreshSourcePaths } from "./backend/workspaces.ts";
import { join } from "node:path";
const [mode, first, second] = Deno.args;
const local = Deno.env.get("LOCALDESK_DATA");
const jobs = new Jobs();
async function wait(fn) { const deadline=Date.now()+10000; while (!await fn()) { if(Date.now()>deadline) throw Error("Synthetic timeout"); await new Promise(r=>setTimeout(r,20)); } }
async function exists(path) { try { await Deno.lstat(path); return true; } catch(e) { if(e instanceof Deno.errors.NotFound)return false; throw e; } }
await jobs.init();
if (mode === "paused") {
  await jobs.pump();
  const states=[jobs.get(first)?.state,jobs.get(second)?.state];
  const pending=integrations.view().every((s)=>s.requiresBoth && !s.connected);
  const launched=await exists(join(local,"order"));
  await jobs.shutdown();
  console.log(JSON.stringify({states,pending,launched}));
} else if (mode === "resume" || mode === "cancel" || mode === "interrupt") {
  await integrations.change("both",true,()=>false); await refreshSourcePaths();
  void jobs.pump();
  await wait(async()=>await exists(join(local,"first-started")) && jobs.get(first)?.state === "running");
  const before=[jobs.get(first)?.state,jobs.get(second)?.state];
  if(mode === "resume") await Deno.writeTextFile(join(local,"release"), "synthetic");
  if(mode === "cancel") await jobs.cancel(first);
  if(mode === "interrupt") {
    await jobs.shutdown(); await wait(async()=>!jobs.busy);
    console.log(JSON.stringify({before,states:[jobs.get(first)?.state,jobs.get(second)?.state]}));
  } else {
    await wait(async()=>["completed","failed","cancelled"].includes(jobs.get(first)?.state) && jobs.get(second)?.state === "completed" && !jobs.busy);
    const states=[jobs.get(first)?.state,jobs.get(second)?.state];
    const order=(await Deno.readTextFile(join(local,"order"))).trim().split("\\n");
    await jobs.shutdown();
    console.log(JSON.stringify({before,states,order}));
  }
} else if (mode === "after-interrupt") {
  await wait(async()=>jobs.get(second)?.state === "completed" && !jobs.busy);
  const states=[jobs.get(first)?.state,jobs.get(second)?.state];
  const order=(await Deno.readTextFile(join(local,"order"))).trim().split("\\n");
  await jobs.shutdown();
  console.log(JSON.stringify({states,order}));
}
`;
const runner = `#!/bin/sh
payload=$(cat)
case "$payload" in *FIRST*) label=first;; *SECOND*) label=second;; *) exit 2;; esac
printf '%s\\n' "$label" >> "$LOCALDESK_DATA/order"
touch "$LOCALDESK_DATA/$label-started"
if [ "$label" = first ]; then
  n=0
  while [ ! -f "$LOCALDESK_DATA/release" ] && [ "$n" -lt 200 ]; do n=$((n+1)); sleep 0.05; done
  [ -f "$LOCALDESK_DATA/release" ] || exit 3
fi
printf '{}\\n'
`;

Deno.test("queued work survives source revalidation and resumes in order", async (t) => {
  const outer = await Deno.realPath(
    await Deno.makeTempDir({ prefix: "localdesk-queue-test-" }),
  );
  let success = false, index = 0;
  async function step(name: string, fn: () => Promise<void>) {
    if (!await t.step(name, fn)) {
      throw new Error(`Synthetic step failed: ${name}`);
    }
  }
  async function fixture() {
    const base = join(outer, String(index++)),
      source = join(base, "source"),
      backend = join(source, "backend");
    const state = join(base, "state"),
      home = join(base, "home"),
      tmp = join(base, "tmp"),
      config = join(source, "config");
    const old = join(base, "old-workspace"),
      workspace = join(base, "new-workspace"),
      projects = join(base, "projects"),
      project = join(projects, "Example");
    for (
      const path of [
        backend,
        join(backend, "projects/backend"),
        join(state, "jobs"),
        home,
        tmp,
        config,
        old,
        workspace,
        project,
      ]
    ) await Deno.mkdir(path, { recursive: true });
    for (
      const file of [
        "jobs.ts",
        "integrations.ts",
        "config.ts",
        "settings.ts",
        "runtime_paths.ts",
        "atomic_json.ts",
        "workspaces.ts",
        "projects/backend/exclude.ts",
      ]
    ) {
      await Deno.copyFile(
        new URL(`../backend/${file}`, import.meta.url),
        join(backend, file),
      );
    }
    await Deno.writeTextFile(join(source, "driver.ts"), driver);
    const command = join(base, "fake-codex");
    await Deno.writeTextFile(command, runner, { mode: 0o700 });
    const defaults = {
      workspace,
      projectsRoot: projects,
      frontendPort: 4100,
      backendPort: 4101,
      frontendHost: "localhost",
      shareCatalogOnLan: false,
      runtimeRegistry: null,
      codexPath: command,
      modelsFile: "models.json",
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
    const chats = [{
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
    }];
    await Deno.writeTextFile(
      join(state, "chats.json"),
      JSON.stringify(chats),
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
    const env: Record<string, string> = {
      HOME: home,
      TMPDIR: tmp,
      PATH: "/usr/bin:/bin",
      LOCALDESK_DATA: state,
    };
    const cache = Deno.env.get("DENO_DIR");
    if (cache) env.DENO_DIR = cache;
    async function run(mode: string) {
      const out = await new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "--cached-only",
          "-A",
          "driver.ts",
          mode,
          first,
          second,
        ],
        cwd: source,
        clearEnv: true,
        env,
        stdout: "piped",
        stderr: "piped",
      }).output();
      assertEquals(out.code, 0, new TextDecoder().decode(out.stderr));
      return JSON.parse(new TextDecoder().decode(out.stdout));
    }
    return { state, run };
  }
  try {
    for (const mode of ["resume", "cancel", "interrupt"] as const) {
      await step(`paused restart then ${mode}`, async () => {
        const f = await fixture();
        const before = await Promise.all(
          [first, second].map((id) =>
            Deno.readTextFile(join(f.state, "jobs", id + ".json"))
          ),
        );
        assertEquals(await f.run("paused"), {
          states: ["queued", "queued"],
          pending: true,
          launched: false,
        });
        assertEquals(await f.run("paused"), {
          states: ["queued", "queued"],
          pending: true,
          launched: false,
        });
        assertEquals(
          await Promise.all(
            [first, second].map((id) =>
              Deno.readTextFile(join(f.state, "jobs", id + ".json"))
            ),
          ),
          before,
        );
        const out = await f.run(mode);
        assertEquals(out.before, ["running", "queued"]);
        if (mode === "resume") {
          assertEquals(out, {
            before: ["running", "queued"],
            states: ["completed", "completed"],
            order: ["first", "second"],
          });
        }
        if (mode === "cancel") {
          assertEquals(out, {
            before: ["running", "queued"],
            states: ["cancelled", "completed"],
            order: ["first", "second"],
          });
        }
        if (mode === "interrupt") {
          assertEquals(out, {
            before: ["running", "queued"],
            states: ["interrupted", "queued"],
          });
          assertEquals(await f.run("after-interrupt"), {
            states: ["interrupted", "completed"],
            order: ["first", "second"],
          });
        }
      });
    }
    success = true;
  } finally {
    if (success) await Deno.remove(outer, { recursive: true });
    else console.error(`Synthetic failure evidence retained at ${outer}`);
  }
});
