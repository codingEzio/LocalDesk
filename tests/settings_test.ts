import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "node:path";
import { loadSettings, normalizeSettings } from "../backend/settings.ts";

// Import the pure settings loader only: config.ts creates the live Local directory.
const defaults = JSON.parse(
  await Deno.readTextFile(new URL("../config/settings.json", import.meta.url)),
);
function fixture() {
  return {
    ...structuredClone(defaults),
    frontendPort: 4100,
    backendPort: 4101,
    workspace: "workspace",
    projectsRoot: "projects",
    codexPath: "./bin/codex",
    modelsFile: "fixtures/models.json",
    sessionArchiveDirectory: "fixtures/archives",
    preset: "sample",
    presets: [{
      name: "sample",
      model: "test-model",
      effort: "medium",
      tier: "default",
    }],
  };
}

Deno.test("portable settings resolve checkout-relative paths without creating local state", async () => {
  const root = await Deno.makeTempDir({
    prefix: "delete_after_use_localdesk_settings_",
  });
  try {
    const settings = await normalizeSettings({
      ...fixture(),
      runtimeRegistry: "metadata/registry.json",
    }, root);
    assertEquals(settings.workspace, join(root, "workspace"));
    assertEquals(settings.projectsRoot, join(root, "projects"));
    assertEquals(settings.codexPath, join(root, "bin/codex"));
    assertEquals(settings.modelsFile, join(root, "fixtures/models.json"));
    assertEquals(
      settings.sessionArchiveDirectory,
      join(root, "fixtures/archives"),
    );
    assertEquals(
      settings.runtimeRegistry,
      join(root, "metadata/registry.json"),
    );
    assertEquals(settings.approvalMode, "sandbox");
    assertEquals(settings.shareCatalogOnLan, false);
    assertEquals(settings.lanInterfaces, []);
    await assertRejects(
      () => Deno.stat(join(root, "Local")),
      Deno.errors.NotFound,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("line-count overrides validate profiles and keep exclusions inside each project", async () => {
  const root = await Deno.makeTempDir();
  try {
    const loc = {
      profiles: { Example: "swift-spm" as const },
      skipProjects: ["ExampleOld"],
      skipPrefixes: ["Vendor-"],
      excludePaths: { Example: ["Sources/Generated"] },
    };
    assertEquals(
      (await normalizeSettings({ ...fixture(), loc }, root)).loc,
      loc,
    );
    await assertRejects(
      () =>
        normalizeSettings({
          ...fixture(),
          loc: { profiles: { Example: "unknown" } },
        }, root),
      Error,
    );
    await assertRejects(
      () =>
        normalizeSettings({
          ...fixture(),
          loc: { excludePaths: { Example: ["../private"] } },
        }, root),
      Error,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("setup persists custom sources outside the checkout and preserves them on replay", async () => {
  const base = await Deno.realPath(
    await Deno.makeTempDir({ prefix: "delete_after_use_setup_" }),
  );
  const root = join(base, "desk"), state = join(base, "private state");
  const workspace = join(base, "source"), projects = join(base, "projects");
  try {
    for (const name of ["backend", "scripts", "config"]) {
      await Deno.mkdir(join(root, name), { recursive: true });
    }
    for (
      const name of [
        "backend/settings.ts",
        "backend/runtime_paths.ts",
        "backend/atomic_json.ts",
        "scripts/setup.ts",
        "config/settings.json",
      ]
    ) {
      await Deno.copyFile(name, join(root, name));
    }
    await Deno.mkdir(workspace);
    await Deno.mkdir(projects);
    const setup = async (args: string[]) => {
      const result = await new Deno.Command(Deno.execPath(), {
        args: ["run", "-A", "scripts/setup.ts", ...args],
        cwd: root,
        env: { LOCALDESK_DATA: state, LOCALDESK_CONFIG: "" },
        stdout: "piped",
        stderr: "piped",
      }).output();
      assert(result.success, new TextDecoder().decode(result.stderr));
    };
    await setup(["--workspace", workspace, "--projects", projects]);
    await setup(["--frontend-port", "10123"]);
    const persisted = JSON.parse(
      await Deno.readTextFile(join(state, "settings.local.json")),
    );
    assertEquals(persisted.workspace, workspace);
    assertEquals(persisted.projectsRoot, projects);
    assertEquals(persisted.frontendPort, 10123);
    await assertRejects(
      () => Deno.stat(join(root, "config/settings.local.json")),
      Deno.errors.NotFound,
    );
  } finally {
    await Deno.remove(base, { recursive: true });
  }
});

Deno.test("settings allow a missing optional override but fail for an explicit missing file", async () => {
  const root = await Deno.makeTempDir({
    prefix: "delete_after_use_localdesk_settings_",
  });
  const previous = Deno.env.get("LOCALDESK_CONFIG");
  const previousData = Deno.env.get("LOCALDESK_DATA");
  try {
    Deno.env.delete("LOCALDESK_CONFIG");
    Deno.env.set("LOCALDESK_DATA", join(root, "Local/private state"));
    await Deno.mkdir(join(root, "Local/private state"), { recursive: true });
    await Deno.mkdir(join(root, "config"));
    await Deno.writeTextFile(
      join(root, "config/settings.json"),
      JSON.stringify(fixture()),
    );
    assertEquals((await loadSettings(root)).frontendPort, 4100);
    await Deno.writeTextFile(
      join(root, "Local/private state/settings.local.json"),
      JSON.stringify({ frontendPort: 4200, workspace: "other" }),
    );
    assertEquals((await loadSettings(root)).workspace, join(root, "other"));
    assertEquals((await loadSettings(root)).frontendPort, 4200);
    Deno.env.set("LOCALDESK_CONFIG", "config/missing.json");
    await assertRejects(() => loadSettings(root), Deno.errors.NotFound);
    Deno.env.set("LOCALDESK_CONFIG", "custom.json");
    await Deno.writeTextFile(
      join(root, "custom.json"),
      JSON.stringify({ frontendPort: 4300 }),
    );
    assertEquals((await loadSettings(root)).frontendPort, 4300);
    await Deno.writeTextFile(join(root, "custom.json"), "{malformed");
    await assertRejects(() => loadSettings(root), SyntaxError);
  } finally {
    if (previousData === undefined) Deno.env.delete("LOCALDESK_DATA");
    else Deno.env.set("LOCALDESK_DATA", previousData);
    if (previous === undefined) Deno.env.delete("LOCALDESK_CONFIG");
    else Deno.env.set("LOCALDESK_CONFIG", previous);
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("optional registry and model selection stay disabled while Codex paths use configured home", async () => {
  const previous = Deno.env.get("CODEX_HOME");
  try {
    Deno.env.set("CODEX_HOME", "/synthetic/codex-home");
    const settings = await normalizeSettings({
      ...fixture(),
      runtimeRegistry: null,
      modelsFile: null,
      sessionArchiveDirectory: null,
      presets: [],
    }, "/synthetic/checkout");
    assertEquals(settings.runtimeRegistry, null);
    assertEquals(settings.presets, []);
    assertEquals(
      settings.modelsFile,
      "/synthetic/codex-home/models_cache.json",
    );
    assertEquals(
      settings.sessionArchiveDirectory,
      "/synthetic/codex-home/archived_sessions",
    );
  } finally {
    if (previous === undefined) Deno.env.delete("CODEX_HOME");
    else Deno.env.set("CODEX_HOME", previous);
  }
});

Deno.test("settings reject invalid ports, bounds, presets and discovery escapes", async (t) => {
  const invalid: [string, Record<string, unknown>][] = [
    ["shared port", { backendPort: 4100 }],
    ["port zero", { frontendPort: 0 }],
    ["port above range", { backendPort: 65536 }],
    ["port text", { backendPort: "4101" }],
    ["fractional queue", { maxQueuedJobs: 1.5 }],
    ["unbounded queue", { maxQueuedJobs: 101 }],
    ["negative polling", { scanIntervalMs: -1 }],
    ["nonfinite duration", { maxJobMinutes: Infinity }],
    ["empty output bound", { maxOutputBytes: 0 }],
    ["missing default preset", { preset: "missing" }],
    ["duplicate preset", {
      presets: [fixture().presets[0], fixture().presets[0]],
    }],
    ["invalid model argument", {
      presets: [{ ...fixture().presets[0], model: "--bad model" }],
    }],
    ["invalid tier", {
      presets: [{ ...fixture().presets[0], tier: "unlimited" }],
    }],
    ["invalid approval mode", { approvalMode: "auto" }],
    ["invalid share switch", { shareCatalogOnLan: "yes" }],
    ["invalid LAN interface type", { lanInterfaces: "wifi" }],
    ["invalid LAN interface name", { lanInterfaces: ["en0/../en1"] }],
    ["duplicate LAN interface", { lanInterfaces: ["en0", "en0"] }],
    ["parent discovery path", { discoveryDirectories: ["../private"] }],
    ["absolute discovery path", { discoveryDirectories: ["/private"] }],
  ];
  for (const [name, override] of invalid) {
    await t.step(name, async () => {
      await assertRejects(
        () =>
          normalizeSettings(
            { ...fixture(), ...override },
            "/synthetic/checkout",
          ),
        Error,
      );
    });
  }
  const review = await normalizeSettings({
    ...fixture(),
    approvalMode: "review",
  }, "/synthetic/checkout");
  assertEquals(review.approvalMode, "review");
  assert(review.frontendPort !== review.backendPort);
});
