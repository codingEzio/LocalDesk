import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { resolve } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { createWebHandler } from "../backend/web.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const defaultsPath = resolve(root, "config/settings.json");
const overridePath = resolve(
  root,
  process.env.LOCALDESK_CONFIG || "config/settings.local.json",
);
const settings = {
  ...JSON.parse(readFileSync(defaultsPath, "utf8")),
  ...(process.env.LOCALDESK_CONFIG || existsSync(overridePath)
    ? JSON.parse(readFileSync(overridePath, "utf8"))
    : {}),
};
for (const key of ["frontendPort", "backendPort"]) {
  if (
    !Number.isInteger(settings[key]) || settings[key] < 1 ||
    settings[key] > 65535
  ) {
    throw new Error(`LocalDesk ${key} must be an integer between 1 and 65535`);
  }
}
if (
  typeof settings.frontendHost !== "string" || !settings.frontendHost.trim()
) {
  throw new Error("LocalDesk frontendHost must be a nonempty string");
}
if (settings.frontendPort === settings.backendPort) {
  throw new Error("LocalDesk frontendPort and backendPort must be different");
}
export default defineConfig({
  build: { license: { fileName: "THIRD-PARTY-LICENSES.md" } },
  plugins: [svelte(), {
    name: "localdesk-distribution-notices",
    generateBundle() {
      for (
        const [source, fileName] of [["LICENSE", "LICENSE.txt"], [
          "NOTICE.md",
          "NOTICE.txt",
        ]]
      ) {
        this.emitFile({
          type: "asset",
          fileName,
          source: readFileSync(resolve(root, source), "utf8"),
        });
      }
    },
  }, {
    name: "localdesk-private-api",
    configureServer(server) {
      const localAddresses = [
        "127.0.0.1",
        "::1",
        "::ffff:127.0.0.1",
        ...Object.values(networkInterfaces()).flatMap((entries) =>
          entries?.flatMap((entry) =>
            entry.family === "IPv4"
              ? [entry.address, `::ffff:${entry.address}`]
              : [entry.address]
          ) ?? []
        ),
      ];
      server.middlewares.use((incoming, outgoing, next) => {
        const path = incoming.url?.split("?")[0] ?? "";
        if (
          path !== "/health" && path !== "/api" && !path.startsWith("/api/")
        ) {
          next();
          return;
        }
        void (async () => {
          const token =
            (await readFile(resolve(root, "Local/capability"), "utf8"))
              .trim();
          if (!token) throw new Error("Local capability is unavailable");
          const handler = createWebHandler({
            token,
            frontendPort: settings.frontendPort,
            localAddresses,
            shareCatalogOnLan: settings.shareCatalogOnLan === true,
            async fetch(request) {
              const url = new URL(request.url);
              const target = new URL(
                url.pathname + url.search,
                `http://127.0.0.1:${settings.backendPort}`,
              );
              const headers = new Headers(request.headers);
              headers.delete("host");
              const response = await fetch(target, {
                method: request.method,
                headers,
                body: request.body,
                duplex: "half",
                redirect: "manual",
                signal: request.signal,
              } as RequestInit);
              const responseHeaders = new Headers(response.headers);
              responseHeaders.set("cache-control", "no-store");
              return new Response(response.body, {
                status: response.status,
                headers: responseHeaders,
              });
            },
          });
          const headers = new Headers();
          for (const [key, value] of Object.entries(incoming.headers)) {
            if (value !== undefined) {
              headers.set(key, Array.isArray(value) ? value.join(", ") : value);
            }
          }
          const request = new Request(
            `http://${incoming.headers.host}${incoming.url}`,
            {
              method: incoming.method,
              headers,
              ...(!["GET", "HEAD"].includes(incoming.method ?? "GET")
                ? { body: Readable.toWeb(incoming), duplex: "half" }
                : {}),
            } as RequestInit,
          );
          const response = await handler(
            request,
            incoming.socket.remoteAddress ?? "",
          );
          outgoing.writeHead(
            response.status,
            Object.fromEntries(response.headers),
          );
          if (response.body) {
            Readable.fromWeb(response.body as never).on("error", () => {
              server.config.logger.error(
                "LocalDesk API response stream failed",
              );
              outgoing.destroy();
            }).pipe(outgoing);
          } else outgoing.end();
        })().catch(() => {
          server.config.logger.error(
            "LocalDesk API proxy unavailable; start the API first",
          );
          if (!outgoing.headersSent) {
            outgoing.writeHead(502, {
              "content-type": "application/json",
              "cache-control": "no-store",
            });
          }
          outgoing.end(JSON.stringify({ error: "LocalDesk API unavailable" }));
        });
      });
    },
  }],
  server: {
    host: "0.0.0.0",
    ...(settings.frontendHost !== "0.0.0.0"
      ? { host: settings.frontendHost }
      : {}),
    port: settings.frontendPort,
    strictPort: true,
  },
});
