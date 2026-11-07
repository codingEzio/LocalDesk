import { assert, assertEquals, assertThrows } from "@std/assert";
import { join } from "node:path";
import {
  parseServiceOptions,
  renderService,
  validateServiceRegistry,
} from "../scripts/service.ts";
import type { PortProject } from "../backend/runtime-registry.ts";

Deno.test("service installation requires an explicit mode and valid unique arguments", () => {
  assertEquals(parseServiceOptions([]), {
    install: false,
    label: "org.localdesk.app",
  });
  assertEquals(parseServiceOptions(["--dry-run"]).install, false);
  assertEquals(parseServiceOptions(["--install"]).install, true);
  for (
    const args of [
      ["--install", "--dry-run"],
      ["--install", "--install"],
      ["--label"],
      ["--label", "../other"],
      ["--restart"],
      ["--uninstall"],
    ]
  ) {
    assertThrows(() => parseServiceOptions(args));
  }
});

Deno.test("generated standalone service is portable and explicit registry integration is scoped", () => {
  const input = {
    root: "/synthetic/LocalDesk",
    deno: "/tools/deno",
    processCompose: "/tools/process-compose",
    home: "/synthetic/home",
    path: "/tools:/usr/bin:/bin",
    label: "org.localdesk.app",
    config: "/synthetic/override.json",
    codexHome: "/synthetic/codex",
  };
  const standalone = renderService(input);
  assert(
    standalone.compose.includes(
      "exec /tools/deno run -A /synthetic/LocalDesk/backend/main.ts",
    ),
  );
  assert(!standalone.compose.includes(".runtime"));
  assert(!standalone.compose.includes("--reclaim-port"));
  assert(!standalone.compose.includes("readiness_probe"));
  assert(!standalone.compose.includes("liveness_probe"));
  assert(standalone.compose.includes("LOCALDESK_HOST=0.0.0.0"));
  assert(standalone.compose.includes("max_size_mb: 5"));
  assert(standalone.compose.includes("max_backups: 2"));
  assertEquals(standalone.environment.LOCALDESK_CONFIG, input.config);
  assertEquals(standalone.environment.CODEX_HOME, input.codexHome);
  assertEquals(standalone.environment.HOME, input.home);
  assertEquals(standalone.environment.PATH, input.path);
  assert(standalone.plist.includes("<key>RunAtLoad</key><true/>"));
  assert(standalone.plist.includes("<key>KeepAlive</key><true/>"));
  const registry = renderService({
    ...input,
    workspaceRegistry: "/synthetic/PROJECT_PORTS.json",
  });
  assert(
    registry.compose.includes(
      "/synthetic/.runtime/run-project.sh X-LocalDesk frontend --reclaim-port -- /tools/deno",
    ),
  );
  assert(
    registry.compose.includes(
      "/synthetic/.runtime/run-project.sh X-LocalDesk backend --reclaim-port -- /tools/deno",
    ),
  );
});

Deno.test("registry adapter rejects ports, paths and nonactive rows that belong elsewhere", () => {
  const row: PortProject = {
    project: "X-LocalDesk",
    path: "X-LocalDesk",
    slot: 13,
    lifecycle: "active",
    frontend: 10013,
    backend: 15013,
    endpoints: { frontend: true, backend: true },
    runtime: { kind: "none", composeFile: null, launchAgentLabel: null },
  };
  const settings = { frontendPort: 10013, backendPort: 15013 };
  const validate = (entry: PortProject | undefined) =>
    validateServiceRegistry(
      entry,
      "/synthetic/PROJECT_PORTS.json",
      "/synthetic/X-LocalDesk",
      settings,
    );
  validate(row);
  validateServiceRegistry(
    row,
    "/synthetic/.runtime/registry/PROJECT_PORTS.json",
    "/synthetic/X-LocalDesk",
    settings,
  );
  for (
    const invalid of [
      undefined,
      { ...row, path: "ExampleOther" },
      { ...row, frontend: 10001 },
      { ...row, backend: 15001 },
      { ...row, lifecycle: "archived" as const },
      { ...row, endpoints: { frontend: false, backend: true } },
    ]
  ) {
    assertThrows(() => validate(invalid));
  }
});

Deno.test({
  name:
    "generated plist handles spaces and XML characters without executing a service",
  ignore: Deno.build.os !== "darwin",
  fn: async () => {
    const root = await Deno.makeTempDir({
      prefix: "delete_after_use_localdesk_service_",
    });
    try {
      const generated = renderService({
        root: join(root, "Desk & user's files"),
        deno: "/tools/deno",
        processCompose: "/tools/process-compose",
        home: "/synthetic/home",
        path: "/tools:/usr/bin:/bin",
        label: "org.localdesk.fixture",
        config: "/synthetic/settings & choices.json",
      });
      const file = join(root, "fixture.plist");
      await Deno.writeTextFile(file, generated.plist);
      const checked = await new Deno.Command("/usr/bin/plutil", {
        args: ["-convert", "json", "-o", "-", file],
        stdout: "piped",
        stderr: "piped",
      }).output();
      assert(checked.success, new TextDecoder().decode(checked.stderr));
      const plist = JSON.parse(new TextDecoder().decode(checked.stdout));
      assertEquals(plist.ProgramArguments, [
        "/tools/process-compose",
        "-f",
        generated.composePath,
        "--no-server",
        "up",
      ]);
      assertEquals(plist.WorkingDirectory, join(root, "Desk & user's files"));
      assertEquals(
        plist.EnvironmentVariables.LOCALDESK_CONFIG,
        "/synthetic/settings & choices.json",
      );
      const yamlCommand = generated.compose.split("\n").find((line) =>
        line.trim().startsWith("command:")
      )!;
      const shellCommand = JSON.parse(
        yamlCommand.trim().slice("command:".length),
      );
      assert(shellCommand.includes("'\\''"));
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "service dry-run retains a logical launcher across a version-target replacement",
  ignore: Deno.build.os !== "darwin",
  fn: async () => {
    const base = await Deno.realPath(
      await Deno.makeTempDir({ prefix: "delete_after_use_launcher_" }),
    );
    const root = join(base, "desk"),
      bin = join(base, "bin"),
      state = join(base, "private state");
    try {
      for (const name of ["scripts", "backend", "config"]) {
        await Deno.mkdir(join(root, name), { recursive: true });
      }
      for (
        const name of [
          "scripts/service.ts",
          "backend/runtime_paths.ts",
          "backend/settings.ts",
          "backend/runtime-registry.ts",
          "config/settings.json",
        ]
      ) {
        await Deno.copyFile(name, join(root, name));
      }
      await Deno.mkdir(bin);
      for (const version of ["v1", "v2"]) {
        await Deno.writeTextFile(
          join(bin, version),
          `#!/bin/sh\nprintf '${version}\\n'\n`,
          { mode: 0o700 },
        );
      }
      const launcher = join(bin, "deno");
      await Deno.symlink(join(bin, "v1"), launcher);
      await Deno.writeTextFile(
        join(bin, "process-compose"),
        '#!/bin/sh\n[ "$1" = --dry-run ] || exit 97\n',
        { mode: 0o700 },
      );
      const label = `org.localdesk.fixture-${crypto.randomUUID()}`;
      const result = await new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "-A",
          "scripts/service.ts",
          "--dry-run",
          "--label",
          label,
        ],
        cwd: root,
        env: {
          PATH: `${bin}:/usr/bin:/bin`,
          LOCALDESK_DATA: state,
          LOCALDESK_CONFIG: "",
        },
        stdout: "piped",
        stderr: "piped",
      }).output();
      assert(result.success, new TextDecoder().decode(result.stderr));
      const readback = await new Deno.Command("/usr/bin/plutil", {
        args: [
          "-convert",
          "json",
          "-o",
          "-",
          join(root, "Local/runtime", `${label}.plist`),
        ],
        stdout: "piped",
        stderr: "piped",
      }).output();
      assert(readback.success);
      const plist = JSON.parse(new TextDecoder().decode(readback.stdout));
      assertEquals(plist.EnvironmentVariables.LOCALDESK_DENO, launcher);
      assertEquals(plist.EnvironmentVariables.LOCALDESK_DATA, state);
      await Deno.remove(launcher);
      await Deno.remove(join(bin, "v1"));
      await Deno.symlink(join(bin, "v2"), launcher);
      const replaced = await new Deno.Command(
        plist.EnvironmentVariables.LOCALDESK_DENO,
        {
          args: ["--version"],
          stdout: "piped",
          stderr: "piped",
        },
      ).output();
      assert(replaced.success);
      assertEquals(new TextDecoder().decode(replaced.stdout).trim(), "v2");
      assert(
        new TextDecoder().decode(result.stdout).includes(
          "no LaunchAgent installed or started",
        ),
      );
    } finally {
      await Deno.remove(base, { recursive: true });
    }
  },
});
