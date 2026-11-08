import { assertEquals, assertMatch } from "@std/assert";
import { createWebHandler } from "../backend/web.ts";
import { createStaticApp } from "../backend/static-web.ts";
import { createLanPolicy } from "../backend/lan_network.ts";

Deno.test("web privacy boundary denies LAN catalog by default and rejects foreign origins", async () => {
  const forwarded: Request[] = [];
  const handler = createWebHandler({
    token: "synthetic-token",
    frontendPort: 4100,
    localAddresses: ["127.0.0.1", "192.0.2.1"],
    shareCatalogOnLan: false,
    fetch: (request) => {
      forwarded.push(request);
      return Promise.resolve(new Response("ok"));
    },
  });
  for (
    const path of [
      "/api",
      "/api/state",
      "/api/workbench",
      "/api/jobs",
      "/api/chats",
    ]
  ) {
    assertEquals(
      (await handler(new Request(`http://192.0.2.1:4100${path}`), "192.0.2.2"))
        .status,
      403,
    );
  }
  assertEquals(
    (await handler(
      new Request("http://attacker.test:4100/api/state"),
      "127.0.0.1",
    )).status,
    403,
  );
  assertEquals(
    (await handler(
      new Request("http://localhost:4100/api/state", {
        headers: { origin: "http://attacker.test" },
      }),
      "127.0.0.1",
    )).status,
    403,
  );
  assertEquals(
    (await handler(
      new Request("http://localhost:4100/api/refresh", { method: "POST" }),
      "127.0.0.1",
    )).status,
    403,
  );
  assertEquals(forwarded.length, 0);
  assertEquals(
    (await handler(
      new Request("http://localhost:4100/api/state", {
        headers: { authorization: "Bearer attacker" },
      }),
      "127.0.0.1",
    )).status,
    200,
  );
  assertEquals(
    forwarded.at(-1)?.headers.get("authorization"),
    "Bearer synthetic-token",
  );
});

Deno.test("explicit LAN sharing exposes only known read-only catalog routes without authority", async () => {
  const forwarded: Request[] = [];
  const handler = createWebHandler({
    token: "synthetic-token",
    frontendPort: 4100,
    localAddresses: ["127.0.0.1", "192.0.2.1"],
    shareCatalogOnLan: true,
    isLanPeer: createLanPolicy(["wifi"], () => [{
      name: "wifi",
      address: "192.0.2.1",
      cidr: "192.0.2.1/24",
    }]),
    fetch: (request) => {
      forwarded.push(request);
      return Promise.resolve(new Response("ok"));
    },
  });
  for (const path of ["/api/state", "/api/workbench"]) {
    assertEquals(
      (await handler(
        new Request(`http://192.0.2.1:4100${path}`, {
          headers: { authorization: "Bearer synthetic-token" },
        }),
        "192.0.2.2",
      )).status,
      200,
    );
    assertEquals(forwarded.at(-1)?.headers.get("authorization"), null);
  }
  for (
    const path of ["/api/jobs", "/api/chats", "/api/jobs/one", "/api/future"]
  ) {
    assertEquals(
      (await handler(new Request(`http://192.0.2.1:4100${path}`), "192.0.2.2"))
        .status,
      403,
    );
  }
  assertEquals(
    (await handler(
      new Request("http://192.0.2.1:4100/api/refresh", {
        method: "POST",
        headers: { origin: "http://192.0.2.1:4100" },
      }),
      "192.0.2.2",
    )).status,
    403,
  );
});

Deno.test("LAN access requires a current selected interface and its actual subnet", async () => {
  const interfaces = [
    { name: "wifi", address: "192.0.2.1", cidr: "192.0.2.1/24" },
    { name: "wifi", address: "fd12:abcd::1", cidr: "fd12:abcd::1/64" },
    { name: "wifi", address: "fe80::1", cidr: "fe80::1/64" },
    { name: "bridge", address: "10.8.0.1", cidr: "10.8.0.1/24" },
  ];
  const policy = createLanPolicy(["wifi"], () => interfaces);
  const handler = createWebHandler({
    token: "private-token",
    frontendPort: 4100,
    localAddresses: ["127.0.0.1", ...interfaces.map((item) => item.address)],
    shareCatalogOnLan: true,
    isLanPeer: policy,
    fetch: () => Promise.resolve(new Response("ok")),
  });
  const request = (host: string, peer: string, headers?: HeadersInit) =>
    handler(
      new Request(`http://${host}:4100/api/workbench`, { headers }),
      peer,
    );
  assertEquals((await request("192.0.2.1", "192.0.2.7")).status, 200);
  assertEquals((await request("192.0.2.1", "::ffff:c000:207")).status, 200);
  assertEquals((await request("[fd12:abcd::1]", "fd12:abcd::2")).status, 200);
  for (
    const [host, peer] of [
      ["192.0.2.1", "192.0.3.7"],
      ["192.0.2.1", "203.0.113.7"],
      ["192.0.2.1", "::ffff:203.0.113.7"],
      ["192.0.2.1", "10.8.0.2"],
      ["10.8.0.1", "10.8.0.2"],
      ["localhost", "203.0.113.7"],
      ["[fd12:abcd::1]", "fd12:abce::2"],
      ["[fd12:abcd::1]", "fe80::2%wifi"],
      ["[fe80::1]", "fe80::2"],
    ]
  ) {
    assertEquals(
      (await request(host, peer, {
        "x-forwarded-for": "192.0.2.7",
        authorization: "Bearer private-token",
      })).status,
      403,
      `${host} / ${peer}`,
    );
  }
  assertEquals((await request("localhost", "127.0.0.1")).status, 200);
  const missing = createLanPolicy([], () => interfaces);
  assertEquals(missing("192.0.2.7", "192.0.2.1"), false);
  const missingPolicy = createWebHandler({
    token: "private-token",
    frontendPort: 4100,
    localAddresses: ["127.0.0.1", "192.0.2.1"],
    shareCatalogOnLan: true,
    fetch: () => Promise.resolve(new Response("ok")),
  });
  assertEquals(
    (await missingPolicy(
      new Request("http://192.0.2.1:4100/api/workbench"),
      "192.0.2.7",
    )).status,
    403,
  );
  interfaces[0].cidr = "192.0.2.1/0";
  assertEquals(policy("192.0.2.7", "192.0.2.1"), false);
  interfaces[0].cidr = "192.0.3.1/24";
  assertEquals(policy("192.0.2.7", "192.0.2.1"), false);
  interfaces[0] = { name: "wifi", address: "192.0.3.1", cidr: "192.0.3.1/24" };
  assertEquals(policy("192.0.2.7", "192.0.2.1"), false);
  assertEquals(policy("192.0.3.7", "192.0.3.1"), true);
  assertEquals(
    createLanPolicy(["wifi"], () => {
      throw Error("unavailable");
    })(
      "192.0.2.7",
      "192.0.2.1",
    ),
    false,
  );
});

Deno.test("portable static assets retain cache, compression, traversal and SPA behavior", async () => {
  const root = await Deno.makeTempDir({ prefix: "localdesk-static-test-" });
  try {
    await Deno.mkdir(`${root}/assets`);
    await Deno.writeTextFile(
      `${root}/index.html`,
      "<main>LocalDesk</main>".repeat(50),
    );
    await Deno.writeTextFile(
      `${root}/assets/main-12345678.js`,
      "export const value = 1;".repeat(50),
    );
    const app = await createStaticApp({ root });
    const request = (path: string, init?: RequestInit) =>
      app.fetch(new Request(`http://localhost${path}`, init));
    const compressed = await request("/assets/main-12345678.js", {
      headers: { "accept-encoding": "gzip" },
    });
    assertEquals(compressed.status, 200);
    assertEquals(compressed.headers.get("content-encoding"), "gzip");
    assertMatch(compressed.headers.get("cache-control")!, /immutable/);
    const etag = compressed.headers.get("etag")!;
    await compressed.arrayBuffer();
    assertEquals(
      (await request("/assets/main-12345678.js", {
        headers: { "accept-encoding": "gzip", "if-none-match": etag },
      })).status,
      304,
    );
    const head = await request("/", { method: "HEAD" });
    assertEquals(await head.text(), "");
    assertEquals(head.headers.get("cache-control"), "no-cache");
    assertEquals((await request("/%2ehidden")).status, 404);
    assertEquals((await request("/%5csecret")).status, 404);
    assertEquals(
      (await request("/assets/missing.js", {
        headers: { accept: "text/html" },
      })).status,
      404,
    );
    assertEquals(
      (await request("/overview", { headers: { accept: "text/html" } })).status,
      200,
    );
    assertEquals((await request("/", { method: "POST" })).status, 405);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
import { localOriginPolicy } from "../backend/origin.ts";

Deno.test("API and shell origin policy agrees for IPv6 and default HTTP ports", () => {
  const ipv6 = localOriginPolicy(10013, ["127.0.0.1", "::1", "192.168.0.2"]);
  if (!ipv6("http://[::1]:10013") || !ipv6("http://192.168.0.2:10013")) {
    throw new Error("Known IPv6/IPv4 local origins must be accepted");
  }
  const http = localOriginPolicy(80, ["127.0.0.1", "::1"]);
  if (!http("http://localhost") || !http("http://[::1]")) {
    throw new Error("Canonical default-port origins must be accepted");
  }
  for (
    const origin of [
      "https://localhost",
      "http://localhost:81",
      "http://foreign.invalid",
      "null",
    ]
  ) {
    if (http(origin)) throw new Error("Untrusted origin accepted");
  }
});
