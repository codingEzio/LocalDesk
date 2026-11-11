import { basename, join, resolve } from "node:path";
import { homedir } from "node:os";
import { loadRegistry, type PortProject } from "../../runtime-registry.ts";
export type { PortProject } from "../../runtime-registry.ts";

export type RuntimeKind = "web" | "native" | "none" | "unknown";
export type Reachability =
  | "reachable"
  | "unreachable"
  | "not_applicable"
  | "unknown";
export type ManagementState =
  | "managed"
  | "configured"
  | "not_applicable"
  | "unknown";
export type ManagerState =
  | "running"
  | "loaded"
  | "not_loaded"
  | "not_applicable"
  | "unknown";
export type ConfigurationState =
  | "configured"
  | "missing"
  | "not_applicable"
  | "unknown";

export type RuntimeFacts = {
  kind: RuntimeKind;
  ports: {
    frontend: number | null;
    backend: number | null;
    frontend_endpoint: boolean | null;
    backend_endpoint: boolean | null;
  };
  reachability: { frontend: Reachability; backend: Reachability };
  management: {
    state: ManagementState;
    manager: ManagerState;
    startup: ConfigurationState;
    restart: ConfigurationState;
  };
};

export type RuntimeDependencies = {
  readText: (path: string) => Promise<string>;
  launchctl: (
    label: string,
    domain?: "gui" | "system",
  ) => Promise<{ ok: boolean; stdout: string }>;
  probe: (port: number, role: "frontend" | "backend") => Promise<Reachability>;
  launchAgentPath?: (label: string, domain?: "gui" | "system") => string;
};

export type RuntimeProvider = {
  refresh: (projectNames: string[]) => Promise<void>;
  factsFor: (projectName: string) => RuntimeFacts;
};

const NOT_APPLICABLE_MANAGEMENT = {
  state: "not_applicable",
  manager: "not_applicable",
  startup: "not_applicable",
  restart: "not_applicable",
} as const;

export function unknownRuntimeFacts(): RuntimeFacts {
  return {
    kind: "unknown",
    ports: {
      frontend: null,
      backend: null,
      frontend_endpoint: null,
      backend_endpoint: null,
    },
    reachability: { frontend: "unknown", backend: "unknown" },
    management: {
      state: "unknown",
      manager: "unknown",
      startup: "unknown",
      restart: "unknown",
    },
  };
}

export function createRuntimeProvider(
  workspaceRoot: string,
  registryPath: string | null = null,
  dependencies = systemDependencies(),
): RuntimeProvider {
  let facts = new Map<string, RuntimeFacts>();
  return {
    async refresh(projectNames) {
      try {
        if (registryPath === null) {
          facts = new Map();
          return;
        }
        const registry = await loadRegistry(
          registryPath,
          dependencies.readText,
        );
        // A registry label is not proof that a different directory owns its ports.
        const byPath = new Map(
          registry.projects.filter((entry) =>
            entry.path !== null && entry.lifecycle === "active"
          )
            .map((entry) => [resolve(workspaceRoot, entry.path!), entry]),
        );
        const entries = await mapBounded(projectNames, 8, async (name) =>
          [
            name,
            await runtimeFactsFor(
              byPath.get(resolve(workspaceRoot, name)),
              workspaceRoot,
              dependencies,
            ),
          ] as const);
        facts = new Map(entries);
      } catch {
        facts = new Map(
          projectNames.map((name) => [name, unknownRuntimeFacts()]),
        );
      }
    },
    factsFor(projectName) {
      return facts.get(projectName) ?? unknownRuntimeFacts();
    },
  };
}

async function mapBounded<T, R>(
  items: T[],
  limit: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await work(items[index]);
      }
    }),
  );
  return results;
}

export async function runtimeFactsFor(
  entry: PortProject | undefined,
  workspaceRoot: string,
  dependencies = systemDependencies(),
): Promise<RuntimeFacts> {
  if (!entry) return unknownRuntimeFacts();
  const [frontend, backend, management] = await Promise.all([
    inspectEndpoint(
      entry.runtime.kind === "web" && entry.endpoints.frontend,
      entry.frontend,
      "frontend",
      dependencies,
    ),
    inspectEndpoint(
      entry.runtime.kind === "web" && entry.endpoints.backend,
      entry.backend,
      "backend",
      dependencies,
    ),
    inspectManagement(entry, workspaceRoot, dependencies),
  ]);
  return {
    kind: entry.runtime.kind,
    ports: {
      frontend: entry.frontend,
      backend: entry.backend,
      frontend_endpoint: entry.endpoints.frontend,
      backend_endpoint: entry.endpoints.backend,
    },
    reachability: { frontend, backend },
    management,
  };
}

async function inspectEndpoint(
  expected: boolean,
  port: number | null,
  role: "frontend" | "backend",
  dependencies: RuntimeDependencies,
): Promise<Reachability> {
  if (!expected) return "not_applicable";
  if (port === null) return "unknown";
  try {
    return await dependencies.probe(port, role);
  } catch {
    return "unknown";
  }
}

export async function inspectManagement(
  entry: PortProject,
  workspaceRoot: string,
  dependencies = systemDependencies(),
): Promise<RuntimeFacts["management"]> {
  const { composeFile, kind, launchAgentLabel } = entry.runtime;
  if (kind === "none" || (!composeFile && !launchAgentLabel)) {
    return NOT_APPLICABLE_MANAGEMENT;
  }
  if (!composeFile || !launchAgentLabel) {
    return {
      state: "unknown",
      manager: "unknown",
      startup: "missing",
      restart: "missing",
    };
  }

  const composePath = resolve(workspaceRoot, composeFile);
  const domain = entry.runtime.launchDomain ?? "gui";
  const plistPath = dependencies.launchAgentPath?.(launchAgentLabel, domain) ??
    (domain === "system"
      ? join("/Library/LaunchDaemons", `${launchAgentLabel}.plist`)
      : join(
        homeDirectory(),
        "Library",
        "LaunchAgents",
        `${launchAgentLabel}.plist`,
      ));
  let compose: string;
  let plist: string;
  try {
    [compose, plist] = await Promise.all([
      dependencies.readText(composePath),
      dependencies.readText(plistPath),
    ]);
  } catch {
    return {
      state: "unknown",
      manager: "unknown",
      startup: "unknown",
      restart: "unknown",
    };
  }

  const startup = plistTrue(plist, "RunAtLoad") ? "configured" : "missing";
  const managerPolicy = managerPolicyMatches(kind, plist, composePath)
    ? "configured"
    : "missing";
  const restart = childRestartConfigured(kind, compose)
    ? "configured"
    : "missing";
  let manager: ManagerState;
  try {
    const loaded = await dependencies.launchctl(launchAgentLabel, domain);
    if (!loaded.ok) manager = "not_loaded";
    else if (!loadedManagerMatches(loaded.stdout, composePath)) {
      manager = "unknown";
    } else {manager = /state\s*=\s*running/i.test(loaded.stdout)
        ? "running"
        : "loaded";}
  } catch {
    manager = "unknown";
  }

  const complete = startup === "configured" &&
    managerPolicy === "configured" && restart === "configured";
  if (manager === "unknown") {
    return { state: "unknown", manager, startup, restart };
  }
  return {
    state: complete && (manager === "running" || manager === "loaded")
      ? "managed"
      : complete
      ? "configured"
      : "unknown",
    manager,
    startup,
    restart,
  };
}

function homeDirectory(): string {
  try {
    return Deno.env.get("HOME") ?? homedir();
  } catch {
    return homedir();
  }
}

function plistTrue(source: string, key: string): boolean {
  return new RegExp(`<key>${key}</key>\\s*<true\\s*/>`, "i").test(source);
}

function managerPolicyMatches(
  kind: Exclude<RuntimeKind, "unknown">,
  plist: string,
  composePath: string,
): boolean {
  if (kind === "none" || !plistProgramArgumentsMatch(plist, composePath)) {
    return false;
  }
  return plistTrue(plist, "KeepAlive") ||
    /<key>KeepAlive<\/key>\s*<dict>[\s\S]*?<key>SuccessfulExit<\/key>\s*<false\s*\/>[\s\S]*?<\/dict>/i
      .test(plist);
}

function childRestartConfigured(
  kind: Exclude<RuntimeKind, "unknown">,
  compose: string,
): boolean {
  if (kind === "none") return false;
  const blocks = processBlocks(compose);
  if (blocks.length === 0) return false;
  const policies = blocks.map((block) =>
    block.match(/\n\s+availability:\s*\n\s+restart:\s*(\w+)/)?.[1]
  );
  if (policies.some((policy) => !policy)) return false;
  return kind === "web"
    ? policies.every((policy) => policy === "always")
    : policies.every((policy) =>
      policy === "always" || policy === "on_failure"
    );
}

function processBlocks(source: string): string[] {
  const start = source.search(/^processes:\s*$/m);
  if (start < 0) return [];
  const after = source.slice(start);
  const matches = [...after.matchAll(/^ {2}[^\s#][^:]*:\s*$/gm)];
  return matches.map((match, index) =>
    after.slice(match.index!, matches[index + 1]?.index ?? after.length)
  );
}

function plistProgramArgumentsMatch(
  source: string,
  composePath: string,
): boolean {
  const array = source.match(
    /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/i,
  )?.[1];
  if (!array) return false;
  const values = [...array.matchAll(/<string>([\s\S]*?)<\/string>/gi)].map((
    match,
  ) => match[1]);
  const index = values.findIndex((value) =>
    basename(value.trim()) === "process-compose"
  );
  return index >= 0 && configFlag(values[index + 1]) &&
    values[index + 2] === composePath;
}

function loadedManagerMatches(output: string, composePath: string): boolean {
  const program = output.match(/^\s*program\s*=\s*(.+?)\s*$/mi)?.[1];
  const argumentsBlock = output.match(
    /^\s*arguments\s*=\s*\{\s*$([\s\S]*?)^\s*\}\s*$/mi,
  )?.[1];
  if (
    !program || !argumentsBlock ||
    basename(program.trim()) !== "process-compose"
  ) {
    return false;
  }
  const argumentsList = argumentsBlock.split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const executable = argumentsList[0];
  return executable !== undefined &&
    basename(executable) === "process-compose" &&
    configFlag(argumentsList[1]) && argumentsList[2] === composePath;
}

function configFlag(value: string | undefined): boolean {
  return value === "-f" || value === "--config";
}

function systemDependencies(): RuntimeDependencies {
  return {
    readText: (path) => Deno.readTextFile(path),
    launchctl: async (label, domain = "gui") => {
      const uid = domain === "gui"
        ? await boundedCommandOutput("/usr/bin/id", ["-u"])
        : null;
      if (uid && !uid.success) throw new Error("cannot read uid");
      const target = domain === "system"
        ? `system/${label}`
        : `gui/${new TextDecoder().decode(uid!.stdout).trim()}/${label}`;
      const result = await boundedCommandOutput("/bin/launchctl", [
        "print",
        target,
      ]);
      return {
        ok: result.success,
        stdout: new TextDecoder().decode(result.stdout) +
          new TextDecoder().decode(result.stderr),
      };
    },
    probe: async (port, role) => {
      try {
        const response = await fetch(
          `http://127.0.0.1:${port}${role === "backend" ? "/health" : "/"}`,
          {
            signal: AbortSignal.timeout(700),
          },
        );
        response.body?.cancel();
        return response.ok ? "reachable" : "unreachable";
      } catch (error) {
        return error instanceof Deno.errors.PermissionDenied
          ? "unknown"
          : "unreachable";
      }
    },
  };
}

async function boundedCommandOutput(
  command: string,
  args: string[],
  timeoutMs = 1_000,
) {
  const child = new Deno.Command(command, {
    args,
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    try {
      child.kill("SIGTERM");
    } catch {
      // A process that already exited has no remaining work to cancel.
    }
  }, timeoutMs);
  try {
    const result = await child.output();
    if (timedOut) throw new Error(`${command} timed out`);
    return result;
  } finally {
    clearTimeout(timeout);
  }
}
