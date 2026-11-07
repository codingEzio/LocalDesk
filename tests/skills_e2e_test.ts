import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { dirname, join } from "node:path";

// Real app HTTP handlers in a source-only disposable checkout. Never copy Local,
// local settings, capabilities, real skills or user references. Fault injection
// changes ONLY the disposable module, after the production write operation.
Deno.test("isolated skills HTTP rename, rollback, restart and stale conflicts", async () => {
  const base = await Deno.realPath(
    await Deno.makeTempDir({
      prefix: "delete_after_use_skills_e2e_",
    }),
  );
  const root = join(base, "desk"),
    source = join(base, "skills"),
    refs = join(base, "refs");
  const local = join(base, "private state");
  await Deno.mkdir(local, { recursive: true });
  const evidence: unknown[] = [];
  // Curated source ZIPs have no .git directory. Copy only public application
  // modules and named defaults; never discover local overrides through Git.
  async function copySources(directory: string) {
    await Deno.mkdir(join(root, directory), { recursive: true });
    for await (const entry of Deno.readDir(directory)) {
      if (entry.name.startsWith(".")) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory) await copySources(path);
      else if (entry.isFile && /\.(ts|json)$/.test(entry.name)) {
        await Deno.copyFile(path, join(root, path));
      }
    }
  }
  for (const directory of ["backend", "plugins"]) await copySources(directory);
  for (
    const path of [
      "deno.json",
      "deno.lock",
      "config/settings.json",
      "config/agent_instructions.md",
      "config/skill_management.json",
      "config/skill_categories.json",
    ]
  ) {
    await Deno.mkdir(dirname(join(root, path)), { recursive: true });
    await Deno.copyFile(path, join(root, path));
  }
  const settings = JSON.parse(
    await Deno.readTextFile(join(root, "config/settings.json")),
  );
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = listener.addr.port;
  listener.close();
  const frontendListener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const frontendPort = frontendListener.addr.port;
  frontendListener.close();
  await Deno.mkdir(source);
  await Deno.mkdir(refs);
  await Deno.mkdir(join(base, "projects"));
  Object.assign(settings, {
    workspace: base,
    projectsRoot: join(base, "projects"),
    frontendPort,
    backendPort: port,
    runtimeRegistry: null,
    codexPath: join(base, "no-codex"),
    presetFile: join(base, "no-presets"),
    modelsFile: join(base, "no-models"),
    sessionArchiveDirectory: join(base, "sessions"),
  });
  await Deno.writeTextFile(
    join(root, "config/settings.json"),
    JSON.stringify(settings),
  );
  await Deno.writeTextFile(
    join(base, "PROJECT_PORTS.json"),
    JSON.stringify({
      projects: [{
        project: "ExampleOther",
        frontend: frontendPort,
        backend: port,
      }],
    }),
  );
  await Deno.writeTextFile(
    join(local, "skills.local.json"),
    JSON.stringify({ skillsRoot: source, referenceRoots: [refs] }),
  );
  const modulePath = join(root, "backend/skills.ts");
  const original = await Deno.readTextFile(modulePath);
  const anchor = "await this.writeEdit(e, path, e.after);";
  assertEquals(original.split(anchor).length, 2);
  await Deno.writeTextFile(
    modulePath,
    original.replace(
      anchor,
      anchor + `
          // Disposable test copy only: deterministic failure after alias write.
          if (e.kind === "link" && await exists(join(local, "fault.json"))) {
            const fault = JSON.parse(await Deno.readTextFile(join(local, "fault.json")));
            await Deno.remove(join(local, "fault.json"));
            await Deno.writeTextFile(join(local, "fault-reached"), path);
            if (fault.kind === "crash") await new Promise(() => {});
            if (fault.kind === "conflict") await Deno.writeTextFile(join(plan.destination, "SKILL.md"), "external edit preserved\\n");
            throw Error("Injected post-alias write failure");
          }
  `,
    ),
  );
  let child: Deno.ChildProcess | undefined;
  let stderr: Promise<string> = Promise.resolve("");
  let token = "";
  const api = async (path: string, body?: unknown) => {
    const res = await fetch(`http://127.0.0.1:${port}` + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        authorization: "Bearer " + token,
        origin: `http://localhost:${frontendPort}`,
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, data: await res.json() };
  };
  async function until(fn: () => Promise<boolean>) {
    for (let i = 0; i < 200; i++) {
      if (await fn()) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw Error("Timed out waiting for isolated app state");
  }
  async function start() {
    child = new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", "backend/main.ts"],
      cwd: root,
      env: {
        LOCALDESK_DATA: local,
        LOCALDESK_CONFIG: join(root, "config/settings.json"),
      },
      stdout: "null",
      stderr: "piped",
    }).spawn();
    stderr = new Response(child.stderr).text();
    await until(async () => {
      try {
        token = (await Deno.readTextFile(join(local, "capability"))).trim();
        return (await api("/health")).status === 200;
      } catch {
        return false;
      }
    });
  }
  async function stop(signal: "SIGTERM" | "SIGKILL" = "SIGTERM") {
    if (child) {
      try {
        child.kill(signal);
      } catch (e) {
        if (!(e instanceof TypeError)) throw e;
      }
      await child.status;
      child = undefined;
      const log = await stderr;
      evidence.push({ server: log });
      console.error(log);
    }
  }
  const missing = async (p: string) => {
    try {
      await Deno.lstat(p);
      return false;
    } catch (e) {
      if (e instanceof Deno.errors.NotFound) return true;
      throw e;
    }
  };
  const old = "sample-skill", renamed = "renamed-skill";
  const skill =
    "---\nname: sample-skill\ndescription: Fixture skill\n---\n# sample-skill\nRead [guide](guide.md).\n";
  async function reset() {
    for (const path of [source, refs, join(local, "skill-management")]) {
      await Deno.remove(path, { recursive: true }).catch((e) => {
        if (!(e instanceof Deno.errors.NotFound)) throw e;
      });
      await Deno.mkdir(path, { recursive: true });
    }
    await Deno.mkdir(join(source, old, "agents"), { recursive: true });
    await Deno.writeTextFile(join(source, old, "SKILL.md"), skill, {
      mode: 0o640,
    });
    await Deno.writeTextFile(
      join(source, old, "guide.md"),
      "Use $sample-skill.\n",
    );
    await Deno.writeTextFile(
      join(source, old, "agents/openai.yaml"),
      "interface:\n  display_name: Fixture\n  default_prompt: Use $sample-skill\n",
    );
    await Deno.symlink(old, join(source, "short-alias"));
    await Deno.writeTextFile(
      join(refs, "usage.md"),
      "Use $sample-skill; [skill](../skills/sample-skill/SKILL.md).\n",
    );
    await Deno.writeTextFile(
      join(refs, "product.json"),
      '{"product":"sample-skill"}\n',
    );
  }
  async function preview() {
    const list = await api("/api/skills?fresh=1");
    assertEquals(list.status, 200);
    const item = list.data.items.find((x: { folder: string }) =>
      x.folder === old
    );
    assert(item);
    const result = await api("/api/skills/preview", {
      folder: old,
      name: renamed,
      description: "Renamed fixture",
      category: "uncategorized",
      expected: item.revision,
    });
    assertEquals(result.status, 200, JSON.stringify(result));
    return result.data;
  }
  const apply = (
    plan: { id: string; files: { index: number; selected: boolean }[] },
  ) =>
    api("/api/skills/apply", {
      id: plan.id,
      selected: plan.files.filter((x) => x.selected).map((x) => x.index),
    });
  async function restored() {
    assertEquals(await Deno.readTextFile(join(source, old, "SKILL.md")), skill);
    assertEquals(await Deno.readLink(join(source, "short-alias")), old);
    assertEquals(
      await Deno.readTextFile(join(refs, "usage.md")),
      "Use $sample-skill; [skill](../skills/sample-skill/SKILL.md).\n",
    );
    assertEquals(
      await Deno.readTextFile(join(source, old, "guide.md")),
      "Use $sample-skill.\n",
    );
    assertStringIncludes(
      await Deno.readTextFile(join(source, old, "agents/openai.yaml")),
      "$sample-skill",
    );
    assert(await missing(join(source, renamed)));
    assert(await missing(join(source, ".skill-categories.json")));
    assert(await missing(join(source, ".skill-manager.lock")));
  }
  try {
    await start();
    await reset();
    let plan = await preview();
    assertEquals(
      plan.files.find((x: { path: string }) => x.path.endsWith("product.json"))
        .selected,
      false,
    );
    let result = await apply(plan);
    assertEquals(result.status, 200, JSON.stringify(result));
    assertEquals(result.data.status, "committed");
    assert(await missing(join(source, old)));
    assertEquals(await Deno.readLink(join(source, "short-alias")), renamed);
    assertStringIncludes(
      await Deno.readTextFile(join(source, renamed, "SKILL.md")),
      "name: renamed-skill",
    );
    assertStringIncludes(
      await Deno.readTextFile(join(source, renamed, "agents/openai.yaml")),
      "$renamed-skill",
    );
    assertStringIncludes(
      await Deno.readTextFile(join(refs, "usage.md")),
      "../skills/renamed-skill/SKILL.md",
    );
    assertStringIncludes(
      await Deno.readTextFile(join(source, renamed, "guide.md")),
      "$renamed-skill",
    );
    assertEquals(
      await Deno.readTextFile(join(refs, "product.json")),
      '{"product":"sample-skill"}\n',
    );
    assertEquals(
      (await Deno.stat(join(source, renamed, "SKILL.md"))).mode! & 0o777,
      0o640,
    );
    assertEquals(
      JSON.parse(
        await Deno.readTextFile(join(source, ".skill-categories.json")),
      ).assignments[renamed],
      "uncategorized",
    );
    evidence.push({
      scenario:
        "rename references alias metadata category permissions and opt-out",
      result,
    });
    await reset();
    plan = await preview();
    await Deno.writeTextFile(
      join(refs, "usage.md"),
      "external stale reference\n",
    );
    result = await apply(plan);
    assertEquals(result.status, 400);
    assertStringIncludes(result.data.error, "changed");
    assertEquals(
      await Deno.readTextFile(join(refs, "usage.md")),
      "external stale reference\n",
    );
    assertEquals(await Deno.readTextFile(join(source, old, "SKILL.md")), skill);
    assertEquals(await Deno.readLink(join(source, "short-alias")), old);
    evidence.push({
      scenario: "stale reference rejected without mutation",
      result,
    });
    await reset();
    plan = await preview();
    await Deno.writeTextFile(
      join(source, old, "SKILL.md"),
      skill + "external\n",
    );
    result = await apply(plan);
    assertEquals(result.status, 400);
    assertEquals(
      await Deno.readTextFile(join(source, old, "SKILL.md")),
      skill + "external\n",
    );
    evidence.push({ scenario: "stale SKILL rejected without clobber", result });
    await reset();
    plan = await preview();
    await Deno.remove(join(source, "short-alias"));
    await Deno.symlink("external-target", join(source, "short-alias"));
    result = await apply(plan);
    assertEquals(result.status, 400);
    assertEquals(
      await Deno.readLink(join(source, "short-alias")),
      "external-target",
    );
    assertEquals(await Deno.readTextFile(join(source, old, "SKILL.md")), skill);
    evidence.push({ scenario: "stale alias target preserved", result });
    await reset();
    plan = await preview();
    await Deno.mkdir(join(source, renamed));
    result = await apply(plan);
    assertEquals(result.status, 400);
    assertEquals(await Deno.readTextFile(join(source, old, "SKILL.md")), skill);
    evidence.push({ scenario: "destination collision rejected", result });
    await reset();
    plan = await preview();
    await Deno.writeTextFile(join(local, "fault.json"), '{"kind":"throw"}');
    result = await apply(plan);
    assertEquals(result.status, 400);
    assertStringIncludes(result.data.error, "Injected");
    await restored();
    assertEquals(
      JSON.parse(
        await Deno.readTextFile(join(local, "skill-management/pending.json")),
      ).status,
      "rolled_back",
    );
    evidence.push({
      scenario: "post-alias failure automatic rollback",
      result,
    });
    await reset();
    plan = await preview();
    await Deno.writeTextFile(join(local, "fault.json"), '{"kind":"conflict"}');
    result = await apply(plan);
    assertEquals(result.status, 400);
    assertStringIncludes(result.data.error, "Concurrent edit preserved");
    assertEquals(
      await Deno.readTextFile(join(source, renamed, "SKILL.md")),
      "external edit preserved\n",
    );
    assert(!(await missing(join(source, ".skill-manager.lock"))));
    result = await api("/api/skills/recover", {});
    assertEquals(result.status, 400);
    assertEquals(
      await Deno.readTextFile(join(source, renamed, "SKILL.md")),
      "external edit preserved\n",
    );
    const journal = JSON.parse(
      await Deno.readTextFile(join(local, "skill-management/pending.json")),
    );
    await Deno.writeTextFile(
      join(source, renamed, "SKILL.md"),
      journal.edits.find((x: { path: string }) =>
        x.path === join(source, old, "SKILL.md")
      ).after,
    );
    result = await api("/api/skills/recover", {});
    assertEquals(result.status, 200, JSON.stringify(result));
    await restored();
    evidence.push({
      scenario: "foreign edit preserved; explicit resolution then recovery",
      result,
    });
    await reset();
    plan = await preview();
    await Deno.remove(join(local, "fault-reached"));
    await Deno.writeTextFile(join(local, "fault.json"), '{"kind":"crash"}');
    const pendingRequest = apply(plan).catch((e) => ({
      status: 0,
      data: String(e),
    }));
    await until(async () => !(await missing(join(local, "fault-reached"))));
    assertEquals(await Deno.readLink(join(source, "short-alias")), renamed);
    await stop("SIGKILL");
    await pendingRequest;
    await start();
    const listed = await api("/api/skills?fresh=1");
    assert(listed.data.pending);
    result = await api("/api/skills/recover", {});
    assertEquals(result.status, 200, JSON.stringify(result));
    await restored();
    evidence.push({ scenario: "SIGKILL restart pending recovery", result });
  } finally {
    await stop();
    const evidenceDir = Deno.env.get("SKILLS_E2E_EVIDENCE");
    if (evidenceDir) {
      await Deno.mkdir(evidenceDir, { recursive: true });
      await Deno.writeTextFile(
        join(evidenceDir, "results.json"),
        JSON.stringify(
          { app: "LocalDesk", port, evidence },
          null,
          2,
        ),
      );
    }
    await Deno.remove(base, { recursive: true });
  }
});
