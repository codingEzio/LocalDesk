import { assertEquals } from "@std/assert";
import {
  createRuntimeProvider,
  inspectManagement,
  type PortProject,
  type RuntimeDependencies,
  runtimeFactsFor,
} from "../../backend/projects/backend/runtime.ts";

const entry: PortProject = {
  slot: 0,
  project: "ExampleProject",
  path: "ExampleProject",
  lifecycle: "active",
  frontend: 10000,
  backend: 15000,
  endpoints: { frontend: true, backend: true },
  runtime: {
    kind: "web" as const,
    composeFile: "ExampleProject/process-compose.yaml",
    launchAgentLabel: "org.example.process-compose.exampleproject",
  },
};

function dependencies(
  overrides: Partial<RuntimeDependencies> = {},
): RuntimeDependencies {
  return {
    readText: (path) => {
      if (path.endsWith("process-compose.yaml")) {
        return Promise.resolve(
          "processes:\n  web:\n    availability:\n      restart: always\n",
        );
      }
      return Promise.resolve(
        `<?xml version=\"1.0\"?><plist><dict><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ProgramArguments</key><array><string>/opt/homebrew/bin/process-compose</string><string>-f</string><string>/home/example/projects/ExampleProject/process-compose.yaml</string></array></dict></plist>`,
      );
    },
    launchctl: () =>
      Promise.resolve({
        ok: true,
        stdout:
          "state = running\nprogram = /opt/homebrew/bin/process-compose\narguments = {\n  /opt/homebrew/bin/process-compose\n  -f\n  /home/example/projects/ExampleProject/process-compose.yaml\n  --no-server\n  up\n}",
      }),
    probe: () => Promise.resolve("reachable"),
    ...overrides,
  };
}

Deno.test("runtime facts show ports, independent reachability, and an actually loaded web manager", async () => {
  const facts = await runtimeFactsFor(
    entry,
    "/home/example/projects",
    dependencies({
      probe: (port) =>
        Promise.resolve(port === 10000 ? "reachable" : "unreachable"),
    }),
  );
  assertEquals(facts.ports.frontend, 10000);
  assertEquals(facts.ports.backend, 15000);
  assertEquals(facts.reachability.frontend, "reachable");
  assertEquals(facts.reachability.backend, "unreachable");
  assertEquals(facts.management.state, "managed");
  assertEquals(facts.management.manager, "running");
  assertEquals(facts.management.startup, "configured");
  assertEquals(facts.management.restart, "configured");
});

Deno.test("system runtime reads the daemon plist and checks the system launch domain", async () => {
  let domain = "";
  let readDaemon = false;
  const base = dependencies();
  const facts = await runtimeFactsFor(
    { ...entry, runtime: { ...entry.runtime, launchDomain: "system" } },
    "/home/example/projects",
    dependencies({
      readText: (path) => {
        if (path.startsWith("/Library/LaunchDaemons/")) readDaemon = true;
        return base.readText(path);
      },
      launchctl: (label, launchDomain) => {
        domain = launchDomain ?? "";
        return base.launchctl(label, launchDomain);
      },
    }),
  );
  assertEquals(readDaemon, true);
  assertEquals(domain, "system");
  assertEquals(facts.management.state, "managed");
});

Deno.test("management does not call a plist-only web project supervised", async () => {
  const management = await inspectManagement(
    entry,
    "/home/example/projects",
    dependencies({
      launchctl: () =>
        Promise.resolve({ ok: false, stdout: "Could not find service" }),
    }),
  );
  assertEquals(management.state, "configured");
  assertEquals(management.manager, "not_loaded");
  assertEquals(management.startup, "configured");
  assertEquals(management.restart, "configured");
});

Deno.test("manager accepts the observed --config alias with an exact compose path", async () => {
  const management = await inspectManagement(
    entry,
    "/home/example/projects",
    dependencies({
      readText: (path) => {
        if (path.endsWith("process-compose.yaml")) {
          return Promise.resolve(
            "processes:\n  web:\n    availability:\n      restart: always\n",
          );
        }
        return Promise.resolve(
          `<?xml version="1.0"?><plist><dict><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ProgramArguments</key><array><string>/opt/homebrew/bin/process-compose</string><string>--config</string><string>/home/example/projects/ExampleProject/process-compose.yaml</string></array></dict></plist>`,
        );
      },
      launchctl: () =>
        Promise.resolve({
          ok: true,
          stdout:
            "state = running\nprogram = /opt/homebrew/bin/process-compose\narguments = {\n  /opt/homebrew/bin/process-compose\n  --config\n  /home/example/projects/ExampleProject/process-compose.yaml\n}",
        }),
    }),
  );
  assertEquals(management.state, "managed");
});

Deno.test("reserved endpoint and source-only runtime stay explicitly not applicable", async () => {
  const facts = await runtimeFactsFor(
    {
      ...entry,
      endpoints: { frontend: false, backend: false },
      runtime: {
        kind: "none" as const,
        composeFile: null,
        launchAgentLabel: null,
      },
    },
    "/home/example/projects",
    dependencies(),
  );
  assertEquals(facts.reachability.frontend, "not_applicable");
  assertEquals(facts.reachability.backend, "not_applicable");
  assertEquals(facts.management.state, "not_applicable");
});

Deno.test("inspection errors stay unknown rather than implying an unmanaged service", async () => {
  const management = await inspectManagement(
    entry,
    "/home/example/projects",
    dependencies({
      readText: () => {
        throw new Error("permission denied");
      },
    }),
  );
  assertEquals(management.state, "unknown");
  assertEquals(management.manager, "unknown");
});

Deno.test("manager arguments require the exact compose path inside its argument block", async () => {
  const management = await inspectManagement(
    entry,
    "/home/example/projects",
    dependencies({
      launchctl: () =>
        Promise.resolve({
          ok: true,
          stdout:
            "state = running\nprogram = /opt/homebrew/bin/process-compose\narguments = {\n  /opt/homebrew/bin/process-compose\n  -f\n  /home/example/projects/ExampleProject/process-compose.yaml.old\n}\nlog = /home/example/projects/ExampleProject/process-compose.yaml",
        }),
    }),
  );
  assertEquals(management.state, "unknown");
  assertEquals(management.manager, "unknown");
});

Deno.test("runtime observation is disabled without an explicit registry", async () => {
  let reads = 0;
  const runtime = createRuntimeProvider(
    "/home/example/projects",
    null,
    dependencies({
      readText: () => {
        reads++;
        throw new Error("must not read");
      },
    }),
  );
  await runtime.refresh(["ExampleProject"]);
  assertEquals(runtime.factsFor("ExampleProject").kind, "unknown");
  assertEquals(reads, 0);
});

Deno.test("runtime registry binds observations to its declared project path", async () => {
  const deps = dependencies();
  const runtime = createRuntimeProvider(
    "/home/example/projects",
    "/synthetic/registry.json",
    {
      ...deps,
      readText: (path) =>
        path === "/synthetic/registry.json"
          ? Promise.resolve(
            JSON.stringify({
              schemaVersion: 2,
              projects: [{ ...entry, project: "Friendly label" }],
            }),
          )
          : deps.readText(path),
    },
  );
  await runtime.refresh(["ExampleProject", "Friendly label"]);
  assertEquals(runtime.factsFor("ExampleProject").kind, "web");
  assertEquals(runtime.factsFor("Friendly label").kind, "unknown");
});

Deno.test("native and source projects never imply HTTP failure", async () => {
  for (const kind of ["native", "none"] as const) {
    const facts = await runtimeFactsFor(
      {
        ...entry,
        runtime: { kind, composeFile: null, launchAgentLabel: null },
      },
      "/home/example/projects",
      dependencies({
        probe: () => {
          throw new Error("must not probe");
        },
      }),
    );
    assertEquals(facts.reachability.frontend, "not_applicable");
    assertEquals(facts.reachability.backend, "not_applicable");
  }
});

Deno.test("malformed runtime registry remains unknown without port probes", async () => {
  const runtime = createRuntimeProvider(
    "/home/example/projects",
    "/synthetic/registry.json",
    dependencies({
      readText: () =>
        Promise.resolve(
          JSON.stringify({
            schemaVersion: 2,
            projects: [{ ...entry, frontend: "10000" }],
          }),
        ),
      probe: () => {
        throw new Error("must not probe");
      },
    }),
  );
  await runtime.refresh(["ExampleProject"]);
  assertEquals(
    runtime.factsFor("ExampleProject").reachability.frontend,
    "unknown",
  );
});
