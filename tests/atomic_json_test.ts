import { assert, assertEquals, assertRejects } from "@std/assert";
import { dirname, join } from "node:path";
import { atomicJson } from "../backend/atomic_json.ts";

Deno.test("concurrent JSON writes preserve an unrelated symlink target", async () => {
  const root = await Deno.makeTempDir({ prefix: "localdesk_atomic_" });
  try {
    const target = join(root, "settings.json");
    const foreign = join(root, "foreign");
    await Deno.writeTextFile(foreign, "untouched");
    await Deno.symlink(foreign, `${target}.tmp`);
    await Promise.all(
      Array.from({ length: 12 }, (_, id) => atomicJson(target, { id })),
    );
    const value = JSON.parse(await Deno.readTextFile(target));
    assert(Number.isInteger(value.id) && value.id >= 0 && value.id < 12);
    assertEquals(await Deno.readTextFile(foreign), "untouched");
    assert((await Deno.lstat(`${target}.tmp`)).isSymlink);
    const names = [];
    for await (const entry of Deno.readDir(root)) names.push(entry.name);
    assertEquals(names.toSorted(), [
      "foreign",
      "settings.json",
      "settings.json.tmp",
    ]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("failed JSON publication removes only its own temporary file", async () => {
  const root = await Deno.makeTempDir({ prefix: "localdesk_atomic_fail_" });
  try {
    const destination = join(root, "directory");
    await Deno.mkdir(destination);
    await assertRejects(() => atomicJson(destination, { value: 1 }));
    const names = [];
    for await (const entry of Deno.readDir(root)) names.push(entry.name);
    assertEquals(names, ["directory"]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("setup preserves a pre-existing unrelated temporary file", async () => {
  const root = await Deno.makeTempDir({ prefix: "localdesk_setup_" });
  try {
    const source = dirname(dirname(new URL(import.meta.url).pathname));
    for (
      const path of [
        "backend/settings.ts",
        "backend/runtime_paths.ts",
        "backend/atomic_json.ts",
        "scripts/setup.ts",
        "config/settings.json",
      ]
    ) {
      const destination = join(root, path);
      await Deno.mkdir(dirname(destination), { recursive: true });
      await Deno.copyFile(join(source, path), destination);
    }
    const home = join(root, "home"),
      workspace = join(root, "workspace"),
      projects = join(root, "projects"),
      state = join(root, "Local", "state");
    await Deno.mkdir(join(root, "Local"));
    for (const path of [home, workspace, projects, state]) {
      await Deno.mkdir(path);
    }
    const settings = join(state, "settings.json");
    await Deno.writeTextFile(`${settings}.tmp`, "unrelated fixture\n");
    const run = () =>
      new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "--allow-read",
          "--allow-write",
          "--allow-env",
          join(root, "scripts/setup.ts"),
          "--workspace",
          workspace,
          "--projects",
          projects,
        ],
        cwd: root,
        clearEnv: true,
        env: {
          HOME: home,
          LOCALDESK_DATA: state,
          LOCALDESK_CONFIG: settings,
          DENO_DIR: Deno.env.get("DENO_DIR") ?? "",
        },
        stdout: "piped",
        stderr: "piped",
      }).output();
    const first = await run();
    assert(first.success, new TextDecoder().decode(first.stderr));
    assertEquals(
      await Deno.readTextFile(`${settings}.tmp`),
      "unrelated fixture\n",
    );
    const second = await run();
    assert(second.success, new TextDecoder().decode(second.stderr));
    assertEquals(
      await Deno.readTextFile(`${settings}.tmp`),
      "unrelated fixture\n",
    );
    assertEquals(
      JSON.parse(await Deno.readTextFile(settings)).workspace,
      workspace,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
