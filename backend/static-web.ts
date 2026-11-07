import { join, relative, sep } from "node:path";

const CACHE_BYTES = 16 * 1024 * 1024;
const FILE_BYTES = 1024 * 1024;
const MAX_WARM_ENTRIES = 4096;
const TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  json: "application/json; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  wasm: "application/wasm",
  gz: "application/gzip",
  txt: "text/plain; charset=utf-8",
};

type WarmFile = {
  bytes: Uint8Array<ArrayBuffer>;
  gzip?: Uint8Array<ArrayBuffer>;
  etag: string;
};

/** Build assets only. User data and API responses never enter this cache. */
export async function createStaticApp(options: {
  root: string;
  backend?: string;
  cacheBytes?: number;
}) {
  const root = await Deno.realPath(options.root);
  const indexPath = await Deno.realPath(join(root, "index.html"));
  if (!inside(root, indexPath)) throw new Error("Build index escapes its root");
  const index = await Deno.stat(indexPath);
  if (!index.isFile) throw new Error("Build output has no index.html");
  const cacheBytes = options.cacheBytes ?? CACHE_BYTES;
  if (!Number.isSafeInteger(cacheBytes) || cacheBytes < 0) {
    throw new Error("cacheBytes must be a nonnegative safe integer");
  }
  const warm = new Map<string, WarmFile>();
  let usedBytes = 0;
  let visited = 0;

  async function prepare(directory: string, depth = 0): Promise<void> {
    if (depth > 16 || usedBytes >= cacheBytes) return;
    for await (const entry of Deno.readDir(directory)) {
      if (++visited > MAX_WARM_ENTRIES) return;
      if (entry.name.startsWith(".") || entry.isSymlink) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory) {
        await prepare(path, depth + 1);
      } else if (entry.isFile && /\.(?:html|js|css|svg|json)$/.test(path)) {
        const stat = await Deno.stat(path);
        // Reserve twice the source size before compression to bound memory.
        if (stat.size > FILE_BYTES || usedBytes + stat.size * 2 > cacheBytes) {
          continue;
        }
        const bytes = await Deno.readFile(path);
        const compressed = new Uint8Array(
          await new Response(
            new Blob([bytes]).stream().pipeThrough(
              new CompressionStream("gzip"),
            ),
          ).arrayBuffer(),
        );
        const gzip = compressed.length < bytes.length ? compressed : undefined;
        const digest = new Uint8Array(
          await crypto.subtle.digest("SHA-256", bytes),
        );
        const etag = Array.from(digest, (b) => b.toString(16).padStart(2, "0"))
          .join("");
        warm.set(path, { bytes, gzip, etag });
        usedBytes += bytes.length + (gzip?.length ?? 0);
      }
    }
  }
  if (cacheBytes > 0) await prepare(root);

  const missing = () => new Response("Not found", { status: 404 });
  const fetchRequest = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (/^\/(?:api(?:\/|$)|health$)/.test(url.pathname)) {
      if (!options.backend) return missing();
      const target = new URL(url.pathname + url.search, options.backend);
      try {
        const headers = new Headers(request.headers);
        headers.delete("host");
        const response = await fetch(
          new Request(target, {
            method: request.method,
            headers,
            body: request.body,
            signal: request.signal,
            redirect: "manual",
          }),
        );
        const responseHeaders = new Headers(response.headers);
        responseHeaders.set("cache-control", "no-store");
        return new Response(response.body, {
          status: response.status,
          headers: responseHeaders,
        });
      } catch {
        return new Response("Backend unavailable", {
          status: 502,
          headers: { "cache-control": "no-store" },
        });
      }
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed", {
        status: 405,
        headers: { allow: "GET, HEAD" },
      });
    }
    let pathname: string;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      return new Response("Bad path", { status: 400 });
    }
    if (
      pathname.includes("\0") || pathname.includes("\\") ||
      pathname.split("/").some((part) => part.startsWith("."))
    ) return missing();
    let path = join(root, pathname === "/" ? "index.html" : pathname);
    let cached = warm.get(path);
    let stat = index;
    // Prepared assets are one immutable build snapshot. They remain usable
    // until restart even if a separate build replaces their files on disk.
    if (!cached) {
      try {
        path = await Deno.realPath(path);
        if (!inside(root, path)) return missing();
        stat = await Deno.stat(path);
        if (!stat.isFile) return missing();
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
        if (
          !request.headers.get("accept")?.includes("text/html") ||
          /^\/(assets|fonts|ocr)(\/|$)/.test(pathname)
        ) return missing();
        path = join(root, "index.html");
        stat = index;
      }
      cached = warm.get(path);
    }
    const gzip = cached?.gzip &&
      acceptsGzip(request.headers.get("accept-encoding"));
    const bytes = gzip ? cached?.gzip : cached?.bytes;
    const etag = cached
      ? `"${cached.etag}${gzip ? "-gzip" : ""}"`
      : `W/"${stat.mtime?.getTime() ?? 0}-${stat.size}"`;
    const extension = path.split(".").at(-1) ?? "";
    const immutable = relative(root, path).startsWith(`assets${sep}`) &&
      /-[A-Za-z0-9_-]{8,}\.[^.]+$/.test(path);
    const headers = new Headers({
      "content-type": TYPES[extension] ?? "application/octet-stream",
      "cache-control": immutable
        ? "public, max-age=31536000, immutable"
        : "no-cache",
      "etag": etag,
      "x-content-type-options": "nosniff",
    });
    if (cached?.gzip) headers.set("vary", "Accept-Encoding");
    if (gzip) headers.set("content-encoding", "gzip");
    if (
      request.headers.get("if-none-match")?.split(/\s*,\s*/).some((tag) =>
        tag === etag || tag === "*"
      )
    ) {
      return new Response(null, { status: 304, headers });
    }
    headers.set("content-length", String(bytes?.length ?? stat.size));
    if (request.method === "HEAD") return new Response(null, { headers });
    const body = bytes ?? (await Deno.open(path, { read: true })).readable;
    return new Response(body, { headers });
  };
  return { fetch: fetchRequest, warm: { files: warm.size, bytes: usedBytes } };
}

function inside(root: string, path: string) {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep);
}

function acceptsGzip(value: string | null) {
  const encodings = new Map(
    (value ?? "").split(",").map((part) => {
      const [name, ...params] = part.trim().toLowerCase().split(";");
      const q = params.find((p) => p.trim().startsWith("q="));
      return [name, q === undefined ? 1 : Number(q.trim().slice(2))] as const;
    }),
  );
  return (encodings.get("gzip") ?? encodings.get("*") ?? 0) > 0;
}
