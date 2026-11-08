import { assert, assertEquals } from "@std/assert";
import { join } from "node:path";

// The frontend adapter test requires the pinned frontend dependencies. A source-only
// backend test run explicitly reports this test as ignored when Vite is not installed.
let viteAvailable = false;
try {
  viteAvailable =
    Deno.statSync("frontend/node_modules/vite/bin/vite.js").isFile;
} catch (error) {
  if (!(error instanceof Deno.errors.NotFound)) throw error;
}
// All configuration, capability values and network peers below are synthetic.
Deno.test({
  name:
    "Vite proxy uses the selected settings and capability without trusting incoming authority",
  ignore: !viteAvailable,
  fn: async () => {
    const base = await Deno.makeTempDir({ prefix: "localdesk_vite_fixture_" });
    const source = join(base, "source"), frontend = join(source, "frontend");
    const state = join(base, "external-state"), home = join(base, "home");
    const defaultState = Deno.build.os === "darwin"
      ? join(home, "Library", "Application Support", "LocalDesk")
      : Deno.build.os === "windows"
      ? join(home, "AppData", "Local", "LocalDesk")
      : join(home, ".local", "share", "localdesk");
    const servers: Deno.HttpServer[] = [];
    let vite: Deno.ChildProcess | undefined;
    let logs: Promise<string> | undefined;
    let complete = false;
    try {
      for (
        const directory of [
          frontend,
          join(source, "backend"),
          join(source, "config"),
          join(source, "Local"),
          state,
          home,
        ]
      ) {
        await Deno.mkdir(directory, { recursive: true });
      }
      // Only source files needed by the Vite adapter are copied; no user config.
      for (const name of ["vite.config.ts", "package.json"]) {
        await Deno.copyFile(join("frontend", name), join(frontend, name));
      }
      for (
        const name of [
          "web.ts",
          "origin.ts",
          "static-web.ts",
          "config.ts",
          "runtime_paths.ts",
          "settings.ts",
          "atomic_json.ts",
        ]
      ) {
        await Deno.copyFile(
          join("backend", name),
          join(source, "backend", name),
        );
      }
      const dependencies = await Deno.realPath("frontend/node_modules");
      await Deno.symlink(dependencies, join(frontend, "node_modules"));
      const viteCli = join(dependencies, "vite", "bin", "vite.js");
      const reserved = new Set<number>();
      const reservePort = () => {
        while (true) {
          const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
          const port = (listener.addr as Deno.NetAddr).port;
          listener.close();
          if (!reserved.has(port)) {
            reserved.add(port);
            return port;
          }
        }
      };
      let requests = 0;
      let receivedAuthorization = "";
      const fakeApi = Deno.serve({
        hostname: "127.0.0.1",
        port: 0,
        onListen() {},
      }, (request) => {
        requests++;
        receivedAuthorization = request.headers.get("authorization") ?? "";
        return Response.json({ ok: true });
      });
      servers.push(fakeApi);
      const backendPort = (fakeApi.addr as Deno.NetAddr).port;
      reserved.add(backendPort);
      const frontendPort = reservePort();
      // These wrong values make a fallback to the wrong override observably fail.
      const wrongPort = reservePort(), wrongFrontendPort = reservePort();
      const defaults = {
        frontendPort: wrongFrontendPort,
        backendPort: wrongPort,
        frontendHost: "127.0.0.1",
        shareCatalogOnLan: false,
      };
      await Deno.writeTextFile(
        join(source, "config", "settings.json"),
        JSON.stringify(defaults),
      );
      const node = Deno.env.get("LOCALDESK_TEST_NODE") || "node";
      const request = (url: string, headers: Record<string, string>) =>
        fetch(url, { headers, signal: AbortSignal.timeout(1500) });
      const start = async (
        mode: "default" | "isolated" | "relative" | "home" | "explicit",
      ) => {
        const token = `synthetic-${mode}-token`;
        const dataRoot = mode === "default"
          ? defaultState
          : mode === "relative"
          ? join(source, "Local", "relative-state")
          : mode === "home"
          ? join(home, "external-state")
          : state;
        await Deno.mkdir(dataRoot, { recursive: true });
        await Deno.writeTextFile(
          join(source, "Local", "capability"),
          "synthetic-wrong-token",
        );
        await Deno.writeTextFile(join(dataRoot, "capability"), token);
        const legacyOverride = {
          frontendPort: wrongFrontendPort,
          backendPort: wrongPort,
        };
        const dataOverride =
          ["default", "isolated", "relative", "home"].includes(mode)
            ? { frontendPort, backendPort }
            : { frontendPort: wrongFrontendPort, backendPort: wrongPort };
        await Deno.writeTextFile(
          join(source, "config", "settings.local.json"),
          JSON.stringify(legacyOverride),
        );
        await Deno.writeTextFile(
          join(dataRoot, "settings.local.json"),
          JSON.stringify(dataOverride),
        );
        await Deno.writeTextFile(
          join(base, "explicit.json"),
          JSON.stringify({ frontendPort, backendPort }),
        );
        const env: Record<string, string> = {
          PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin",
          HOME: home,
          TMPDIR: base,
        };
        if (mode !== "default") {
          env.LOCALDESK_DATA = mode === "relative"
            ? "Local/relative-state"
            : mode === "home"
            ? "~/external-state"
            : state;
        }
        if (mode === "explicit") {
          env.LOCALDESK_CONFIG = join(base, "explicit.json");
        }
        vite = new Deno.Command(node, {
          args: [
            viteCli,
            "--config",
            join(frontend, "vite.config.ts"),
            "--host",
            "127.0.0.1",
            "--strictPort",
          ],
          cwd: frontend,
          clearEnv: true,
          env,
          stdout: "null",
          stderr: "piped",
        }).spawn();
        logs = new Response(vite.stderr).text();
        let exited = false;
        void vite.status.then(() => {
          exited = true;
        });
        const url = `http://127.0.0.1:${frontendPort}`;
        const deadline = Date.now() +
          Number(Deno.env.get("LOCALDESK_TEST_VITE_START_TIMEOUT_MS") || 15000);
        while (true) {
          try {
            await request(url + "/", {});
            break;
          } catch {
            if (exited) throw new Error("Synthetic Vite exited: " + await logs);
            if (Date.now() >= deadline) {
              throw new Error(
                `${mode}: Vite did not start on the configured frontend port`,
              );
            }
            await new Promise((resolve) => setTimeout(resolve, 30));
          }
        }
        const before = requests;
        const response = await request(url + "/api/state", {
          authorization: "Bearer synthetic-forged",
        });
        assertEquals(
          response.status,
          200,
          `${mode}: proxy should select its configured backend`,
        );
        assertEquals(
          receivedAuthorization,
          `Bearer ${token}`,
          `${mode}: forwarded authority must use the selected capability`,
        );
        assertEquals(requests, before + 1);
        const badOrigin = await request(url + "/api/state", {
          origin: `http://untrusted.invalid:${frontendPort}`,
        });
        assertEquals(
          badOrigin.status,
          403,
          `${mode}: foreign origin must be rejected`,
        );
        assertEquals(
          requests,
          before + 1,
          `${mode}: foreign origin must not reach the backend`,
        );
        const socket = await Deno.connect({
          hostname: "127.0.0.1",
          port: frontendPort,
        });
        await socket.write(
          new TextEncoder().encode(
            `GET /api/state HTTP/1.1\r\nHost: untrusted.invalid:${frontendPort}\r\nConnection: close\r\n\r\n`,
          ),
        );
        const chunk = new Uint8Array(4096);
        const bytesRead = await socket.read(chunk);
        socket.close();
        const firstLine =
          new TextDecoder().decode(chunk.subarray(0, bytesRead ?? 0)).split(
            "\r\n",
          )[0];
        assert(
          firstLine.includes(" 403 "),
          `${mode}: foreign host must be rejected`,
        );
        assertEquals(
          requests,
          before + 1,
          `${mode}: foreign host must not reach the backend`,
        );
        vite.kill("SIGTERM");
        await vite.status;
        await logs;
        vite = undefined;
      };
      for (
        const mode of [
          "default",
          "isolated",
          "relative",
          "home",
          "explicit",
        ] as const
      ) await start(mode);
      const denied = join(base, "denied-override");
      await Deno.mkdir(denied);
      await Deno.writeTextFile(join(denied, "settings.json"), "{}");
      await Deno.chmod(denied, 0o000);
      await Deno.remove(join(defaultState, "settings.local.json"));
      await Deno.symlink(
        join(denied, "settings.json"),
        join(defaultState, "settings.local.json"),
      );
      try {
        const blocked = new Deno.Command(node, {
          args: [
            viteCli,
            "--config",
            join(frontend, "vite.config.ts"),
            "--host",
            "127.0.0.1",
            "--strictPort",
          ],
          cwd: frontend,
          clearEnv: true,
          env: {
            PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin",
            HOME: home,
            TMPDIR: base,
          },
          stdout: "null",
          stderr: "piped",
        }).spawn();
        const blockedText = new Response(blocked.stderr).text();
        const deadline = AbortSignal.timeout(8000);
        const result = await Promise.race([
          blocked.status,
          new Promise<null>((resolve) =>
            deadline.addEventListener("abort", () => resolve(null), {
              once: true,
            })
          ),
        ]);
        if (!result) {
          blocked.kill("SIGTERM");
          await blocked.status;
          throw new Error("Unreadable override unexpectedly started Vite");
        }
        assert(!result.success, "Unreadable optional override must fail");
        assert((await blockedText).includes("EACCES"));
      } finally {
        await Deno.chmod(denied, 0o700);
      }
      const broken = join(source, "Local", "broken-link");
      await Deno.symlink(join(base, "missing-target"), broken);
      for (const unsafe of ["unignored-state", "Local/broken-link/state"]) {
        const invalid = new Deno.Command(node, {
          args: [
            viteCli,
            "--config",
            join(frontend, "vite.config.ts"),
            "--host",
            "127.0.0.1",
            "--strictPort",
          ],
          cwd: frontend,
          clearEnv: true,
          env: {
            PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin",
            HOME: home,
            TMPDIR: base,
            LOCALDESK_DATA: unsafe,
            LOCALDESK_CONFIG: join(base, "explicit.json"),
          },
          stdout: "null",
          stderr: "piped",
        }).spawn();
        const errorText = new Response(invalid.stderr).text();
        const timeout = AbortSignal.timeout(8000);
        const result = await Promise.race([
          invalid.status,
          new Promise<null>((resolve) =>
            timeout.addEventListener("abort", () => resolve(null), {
              once: true,
            })
          ),
        ]);
        if (!result) {
          invalid.kill("SIGTERM");
          await invalid.status;
          throw new Error("Invalid path unexpectedly started Vite");
        }
        assert(!result.success, "Unsafe data root must be rejected");
        assert((await errorText).includes("LOCALDESK_DATA"));
      }
      complete = true;
    } finally {
      if (vite) {
        try {
          vite.kill("SIGTERM");
        } catch { /* Already exited. */ }
        await vite.status;
        await logs;
      }
      for (const server of servers) await server.shutdown();
      if (complete) await Deno.remove(base, { recursive: true });
      else {console.error(
          `Retained synthetic Vite fixture for diagnostics: ${base}`,
        );}
    }
  },
});
