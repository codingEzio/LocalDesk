import { assertEquals } from "@std/assert";
import { dirname, join } from "node:path";
import {
  collectHints,
  countProject,
  countSourceLines,
  formatLocCompact,
} from "../../backend/projects/backend/loc_count.ts";
import { createLocProvider } from "../../backend/projects/backend/loc_job.ts";
import { ProjectStore } from "../../backend/projects/db/store.ts";

function writeFile(root: string, relative: string, content: string) {
  const path = join(root, ...relative.split("/"));
  Deno.mkdirSync(dirname(path), { recursive: true });
  Deno.writeTextFileSync(path, content);
}

Deno.test("countSourceLines counts code, not blanks or whole-line comments", () => {
  assertEquals(
    countSourceLines(
      [
        "const x = 1;",
        "",
        "  // comment",
        "const y = 2; // still code",
        "/*",
        " block",
        "*/",
        "return x;",
      ].join("\n"),
      "c",
    ),
    { code: 3, comment: 4, blank: 1 },
  );
  assertEquals(
    countSourceLines("# header\n\ndef run():\n    return 1\n", "hash"),
    { code: 2, comment: 1, blank: 1 },
  );
});

Deno.test("private line-count policy selects a profile and excludes paths without changing sources", async () => {
  const root = Deno.makeTempDirSync();
  try {
    writeFile(root, "Sources/Main.swift", "struct Main {}\n");
    writeFile(
      root,
      "Sources/Generated/Noise.swift",
      "struct Noise {}\n".repeat(20),
    );
    writeFile(root, "Tests/Main.swift", "func test() {}\n");
    const policy = {
      profiles: { Example: "swift-spm" as const },
      skipProjects: ["PrivateExample"],
      skipPrefixes: ["Sample-"],
      excludePaths: { Example: ["Sources/Generated"] },
    };
    const counted = await countProject(
      "Example",
      root,
      undefined,
      undefined,
      policy,
    );
    assertEquals(counted?.profile, "swift-spm");
    assertEquals(counted?.core, 1);
    assertEquals(counted?.test, 1);
    assertEquals(
      counted?.files.includes("Sources/Generated/Noise.swift"),
      false,
    );
    assertEquals(
      await countProject("PrivateExample", root, undefined, undefined, policy),
      null,
    );
    assertEquals(
      await countProject("Sample-Other", root, undefined, undefined, policy),
      null,
    );
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("line-count policy reaches the persisted workbench statistics", async () => {
  const root = Deno.makeTempDirSync();
  const project = join(root, "project");
  Deno.mkdirSync(project);
  const store = new ProjectStore(join(root, "projects.sqlite3"));
  try {
    writeFile(project, "Sources/Main.swift", "struct Main {}\n");
    writeFile(
      project,
      "Sources/Generated/Noise.swift",
      "struct Noise {}\n".repeat(10),
    );
    const policy = {
      profiles: { Example: "swift-spm" as const },
      skipProjects: [],
      skipPrefixes: [],
      excludePaths: { Example: ["Sources/Generated"] },
    };
    await createLocProvider(store, policy).refresh([{
      name: "Example",
      path: project,
    }]);
    const result = store.listLoc();
    assertEquals(result.length, 1);
    assertEquals(result[0].profile, "swift-spm");
    assertEquals(result[0].core, 1);
    assertEquals(
      Deno.readTextFileSync(join(project, "Sources/Generated/Noise.swift"))
        .split("\n").length,
      11,
    );
  } finally {
    store.close();
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("countProject splits core and test and never reads vendor trees", async () => {
  const root = Deno.makeTempDirSync();
  try {
    writeFile(root, "frontend/src/app.ts", "export const n = 1;\n");
    writeFile(root, "backend/server.ts", "export const ok = true;\n");
    writeFile(root, "tests/api.test.ts", "Deno.test('x', () => {});\n");
    writeFile(
      root,
      "frontend/node_modules/svelte/index.js",
      "export default 1;\n".repeat(5000),
    );
    writeFile(
      root,
      "frontend/public/ocr/worker.min.js",
      "var fake=1;\n".repeat(2000),
    );
    writeFile(root, "version.ts", "export const VERSION = '1';\n");
    const counted = await countProject("ExampleWeb", root);
    assertEquals(counted?.profile, "web-svelte");
    assertEquals(counted?.core, 3);
    assertEquals(counted?.test, 1);
    assertEquals(
      counted?.files.every((file) =>
        !file.includes("node_modules") && !file.includes("/ocr/")
      ),
      true,
    );
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("sitekit fixture does not double-count generated extension trees", async () => {
  const root = Deno.makeTempDirSync();
  try {
    writeFile(root, "src/sites.js", "export const sites = [];\n");
    writeFile(root, "scripts/build.js", "export function build() {}\n");
    writeFile(
      root,
      "extension_chrome/background.js",
      "console.log('generated');\n".repeat(40),
    );
    writeFile(
      root,
      "extension_safari/web-extension/popup.js",
      "console.log('generated');\n".repeat(40),
    );
    writeFile(
      root,
      "extension_safari/host/ExampleSite/ExampleSite/AppDelegate.swift",
      "import Cocoa\n@main\nclass AppDelegate: NSObject {}\n",
    );
    writeFile(root, "tests/sites.test.js", "Deno.test('sites', () => {});\n");
    const counted = await countProject("ExampleSite", root);
    assertEquals(counted?.profile, "sitekit");
    assertEquals(counted?.core, 5);
    assertEquals(counted?.test, 1);
    assertEquals(
      counted?.files.some((file) => file.startsWith("extension_chrome/")),
      false,
    );
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("rust fixture ignores target and sqlite bytes", async () => {
  const root = Deno.makeTempDirSync();
  try {
    writeFile(root, "Cargo.toml", "[package]\nname='atlas'\n");
    writeFile(root, "src/lib.rs", "pub fn ping() -> u8 { 1 }\n");
    writeFile(root, "tests/api.rs", "#[test]\nfn ok() {}\n");
    writeFile(root, "target/release/lib.rs", "fn noise() {}\n".repeat(80));
    Deno.mkdirSync(join(root, "native", "database"), { recursive: true });
    Deno.writeFileSync(
      join(root, "native", "database", "atlas.sqlite3"),
      new Uint8Array(1024),
    );
    const counted = await countProject("ExampleRust", root);
    assertEquals(counted?.profile, "rust");
    assertEquals(counted?.core, 1);
    assertEquals(counted?.test, 2);
    assertEquals(
      counted?.files.some((file) => file.startsWith("target/")),
      false,
    );
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("hwstatus reports mac and firmware parts", async () => {
  const root = Deno.makeTempDirSync();
  try {
    writeFile(root, "Mac/Package.swift", "// synthetic package\n");
    writeFile(root, "Mac/Sources/App.swift", "struct App {}\n");
    writeFile(root, "main/main.c", "int main() { return 0; }\n");
    writeFile(
      root,
      "managed_components/lvgl__lvgl/src/lv.c",
      "void lv(void) {}\n".repeat(20),
    );
    const counted = await countProject("ExampleDevice", root);
    assertEquals(counted?.core, 2);
    assertEquals(
      counted?.parts,
      [
        { id: "mac", core: 1 },
        { id: "firmware", core: 1 },
      ],
    );
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("unchanged fingerprint reuses the previous count", async () => {
  const root = Deno.makeTempDirSync();
  try {
    writeFile(root, "frontend/src/a.ts", "export const a = 1;\n");
    const first = await countProject("ExampleProject", root);
    const second = await countProject(
      "ExampleProject",
      root,
      first ?? undefined,
    );
    assertEquals(second?.counted_at, first?.counted_at);
    assertEquals(second?.fingerprint, first?.fingerprint);
    writeFile(
      root,
      "frontend/src/a.ts",
      "export const a = 1;\nexport const b = 2;\n",
    );
    const third = await countProject(
      "ExampleProject",
      root,
      first ?? undefined,
    );
    assertEquals(third?.core, 2);
    if (third?.counted_at === first?.counted_at) {
      throw new Error("changed source must recount");
    }
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("skipped projects return null instead of a zero loc", async () => {
  const root = Deno.makeTempDirSync();
  try {
    writeFile(root, "kernel/main.c", "int main() { return 0; }\n");
    assertEquals(await countProject("_archive", root), null);
    assertEquals(await countProject(".hidden", root), null);
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("collectHints sees frontend/src and Cargo.toml", async () => {
  const root = Deno.makeTempDirSync();
  try {
    Deno.mkdirSync(join(root, "frontend", "src"), { recursive: true });
    Deno.writeTextFileSync(join(root, "Cargo.toml"), "[package]\n");
    const hints = await collectHints(root);
    assertEquals(hints.includes("frontend/src"), true);
    assertEquals(hints.includes("Cargo.toml"), true);
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("formatLocCompact keeps a short card value", () => {
  assertEquals(formatLocCompact(847), "847");
  assertEquals(formatLocCompact(1000), "1k");
  assertEquals(formatLocCompact(1500), "1.5k");
  assertEquals(formatLocCompact(12341), "12k");
});

// Machine-specific assertions for retired fixture directories
// are superseded by the fixture-based web-svelte/sitekit exclusion cases above.
