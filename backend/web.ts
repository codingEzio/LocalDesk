import { createStaticApp } from "./static-web.ts";
import { localOriginPolicy } from "./origin.ts";
import {
  createLanPolicy,
  type InterfaceAddress,
  isLoopbackPeer,
} from "./lan_network.ts";

type WebOptions = {
  token: string;
  frontendPort: number;
  localAddresses: string[];
  shareCatalogOnLan: boolean;
  lanInterfaces?: string[];
  networkInterfaces?: () => InterfaceAddress[];
  fetch: (request: Request) => Promise<Response>;
};

/** The public listener never delegates local authority to a remote peer. */
export function createWebHandler(options: WebOptions) {
  const reject = (error: string) =>
    Response.json({ error }, {
      status: 403,
      headers: { "cache-control": "no-store", "x-frame-options": "DENY" },
    });
  return async (req: Request, peerAddress: string): Promise<Response> => {
    // Use one current snapshot for host, origin and LAN membership. Only
    // loopback receives local authority even if an interface IP is recycled.
    let interfaces: InterfaceAddress[] = [];
    try {
      interfaces = options.networkInterfaces?.() ?? [];
    } catch { /* No interface information means no remote access. */ }
    const trustedOrigin = localOriginPolicy(options.frontendPort, [
      ...options.localAddresses,
      ...interfaces.map((item) => item.address),
    ]);
    const url = new URL(req.url);
    if (!trustedOrigin(url.origin)) return reject("Unknown host");
    // Deno normally derives request.url from Host; keep this explicit for adapters.
    const host = req.headers.get("host");
    if (host && host.toLowerCase() !== url.host.toLowerCase()) {
      return reject("Unknown host");
    }
    const origin = req.headers.get("origin");
    if (origin !== null && !trustedOrigin(origin)) {
      return reject("Local origin required");
    }
    const isLocal = isLoopbackPeer(peerAddress);
    const headers = new Headers(req.headers);
    headers.delete("authorization");
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      const readOnlyCatalog = req.method === "GET" &&
        (url.pathname === "/api/state" || url.pathname === "/api/workbench");
      if (
        !isLocal && !(options.shareCatalogOnLan && readOnlyCatalog &&
          createLanPolicy(options.lanInterfaces ?? [], () => interfaces)(
            peerAddress,
            url.hostname,
          ))
      ) {
        return reject(
          "Open localhost on the LocalDesk host to access local data",
        );
      }
      if (req.method !== "GET" && req.method !== "HEAD" && origin === null) {
        return reject("Local origin required");
      }
      if (isLocal) headers.set("authorization", `Bearer ${options.token}`);
    }
    const res = await options.fetch(new Request(req, { headers }));
    res.headers.set("x-frame-options", "DENY");
    res.headers.set("referrer-policy", "same-origin");
    return res;
  };
}

if (import.meta.main) {
  const { capability, ports, root, settings } = await import("./config.ts");
  const app = await createStaticApp({
    root: root + "/frontend/dist",
    backend: `http://127.0.0.1:${ports.backend}`,
  });
  const handler = createWebHandler({
    token: await capability(),
    frontendPort: ports.frontend,
    localAddresses: [
      "127.0.0.1",
      "::1",
      "::ffff:127.0.0.1",
    ],
    shareCatalogOnLan: settings.shareCatalogOnLan,
    lanInterfaces: settings.lanInterfaces,
    networkInterfaces: () => Deno.networkInterfaces(),
    fetch: app.fetch,
  });
  const server = Deno.serve({
    hostname: Deno.env.get("LOCALDESK_HOST") ?? settings.frontendHost,
    port: ports.frontend,
  }, (request, info) => handler(request, info.remoteAddr.hostname));
  const shutdown = () => void server.shutdown();
  Deno.addSignalListener("SIGTERM", shutdown);
  Deno.addSignalListener("SIGINT", shutdown);
  await server.finished;
}
