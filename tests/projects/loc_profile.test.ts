import { assertEquals } from "@std/assert";
import {
  classifyPart,
  classifyPath,
  detectProfile,
  type LocProfileId,
  skipProject,
} from "../../backend/projects/backend/loc_profile.ts";

Deno.test("skip hidden and archived directories", () => {
  for (const name of [".hidden", "_archived"]) {
    assertEquals(skipProject(name), true, name);
    assertEquals(detectProfile(name, []), "skip");
  }
  assertEquals(skipProject("Example"), false);
});

Deno.test("directory hints select portable profile families", () => {
  const cases: [string, string[], LocProfileId][] = [
    ["Device", ["Mac/Package.swift", "main"], "hwstatus"],
    ["Site", ["src/sites.js", "extension_chrome"], "sitekit"],
    ["Browser", ["extension_chrome", "extension_safari"], "dual-extension"],
    ["Safari", ["Browser Extension"], "safari-ext"],
    ["Web", ["src", "public"], "deno-vanilla"],
    ["Blog", ["bloglib", "worker.js"], "python-blog"],
    ["Tool", ["src", "pyproject.toml"], "python-tool"],
    ["Editor", ["src", "extension.js", "package.json"], "vscode-ext"],
    ["Phone", ["Sources", "project.yml"], "ios"],
    ["App", ["frontend/src", "backend"], "web-svelte"],
    ["Rust", ["Cargo.toml", "src"], "rust"],
    ["Swift", ["Package.swift", "Sources"], "swift-spm"],
  ];
  for (const [name, hints, profile] of cases) {
    assertEquals(detectProfile(name, hints), profile, name);
  }
  assertEquals(detectProfile("Unknown", ["README.md"]), "skip");
});

function kind(
  profile: LocProfileId,
  relative: string,
): ReturnType<typeof classifyPath> {
  return classifyPath(profile, relative);
}

Deno.test("web-svelte counts app source and tests, not OCR vendor or fonts", () => {
  assertEquals(kind("web-svelte", "frontend/src/App.svelte"), "core");
  assertEquals(kind("web-svelte", "backend/server.ts"), "core");
  assertEquals(kind("web-svelte", "db/schema.ts"), "core");
  assertEquals(kind("web-svelte", "version.ts"), "core");
  assertEquals(kind("web-svelte", "tests/api.test.ts"), "test");
  assertEquals(
    kind("web-svelte", "frontend/public/ocr/worker.min.js"),
    "ignore",
  );
  assertEquals(kind("web-svelte", "frontend/public/fonts/x.woff2"), "ignore");
  assertEquals(
    kind("web-svelte", "frontend/node_modules/svelte/index.js"),
    "ignore",
  );
  assertEquals(kind("web-svelte", "frontend/dist/assets/index.js"), "ignore");
  assertEquals(kind("web-svelte", "frontend/vite.config.ts"), "ignore");
  assertEquals(kind("web-svelte", "Local/projstatus.sqlite3"), "ignore");
});

Deno.test("deno-vanilla ignores generated motion.js and Local dumps", () => {
  assertEquals(kind("deno-vanilla", "src/server.ts"), "core");
  assertEquals(kind("deno-vanilla", "public/app.js"), "core");
  assertEquals(kind("deno-vanilla", "public/locales/en.json"), "core");
  assertEquals(kind("deno-vanilla", "public/motion.js"), "ignore");
  assertEquals(kind("deno-vanilla", "public/fonts/x.woff2"), "ignore");
  assertEquals(kind("deno-vanilla", "tests/auth_test.ts"), "test");
  assertEquals(kind("deno-vanilla", "scripts/collect.ts"), "ignore");
  assertEquals(kind("deno-vanilla", "Local/capture.md"), "ignore");
});

Deno.test("sitekit counts src once and treats generated extension trees as dist", () => {
  assertEquals(kind("sitekit", "src/sites.js"), "core");
  assertEquals(kind("sitekit", "scripts/build.js"), "core");
  assertEquals(
    kind(
      "sitekit",
      "extension_safari/host/ExampleSite/ExampleSite/AppDelegate.swift",
    ),
    "core",
  );
  assertEquals(kind("sitekit", "extension_chrome/background.js"), "ignore");
  assertEquals(
    kind("sitekit", "extension_safari/web-extension/popup.js"),
    "ignore",
  );
  assertEquals(kind("sitekit", "tests/sites.test.js"), "test");
});

Deno.test("dual-extension sums both authored browser trees", () => {
  assertEquals(kind("dual-extension", "extension_chrome/src/core.js"), "core");
  assertEquals(
    kind("dual-extension", "extension_safari/web-extension/src/core.js"),
    "core",
  );
  assertEquals(
    kind(
      "dual-extension",
      "extension_safari/host/ExampleBrowser/ExampleBrowser/AppDelegate.swift",
    ),
    "core",
  );
  assertEquals(kind("dual-extension", "tests/chrome_core.test.js"), "test");
  assertEquals(
    kind("dual-extension", "extension_chrome/fonts/x.woff2"),
    "ignore",
  );
});

Deno.test("safari-ext counts extension resources and thin host Swift", () => {
  assertEquals(
    kind("safari-ext", "ExampleSafari Extension/Resources/content.js"),
    "core",
  );
  assertEquals(
    kind(
      "safari-ext",
      "ExampleSafari Extension/SafariWebExtensionHandler.swift",
    ),
    "core",
  );
  assertEquals(kind("safari-ext", "ExampleSafari/AppDelegate.swift"), "core");
  assertEquals(
    kind("safari-ext", "ExampleSafari/Resources/Script.js"),
    "ignore",
  );
  assertEquals(kind("safari-ext", "script/settings.test.js"), "test");
});

Deno.test("swift-spm counts sources and drops vendor from core", () => {
  assertEquals(kind("swift-spm", "Sources/ExampleApp/App.swift"), "core");
  assertEquals(kind("swift-spm", "Sources/ExampleCore/src/store.cpp"), "core");
  assertEquals(
    kind("swift-spm", "Sources/ExampleCore/vendor/toml.hpp"),
    "ignore",
  );
  assertEquals(kind("swift-spm", "Sources/ExampleCheck/main.swift"), "core");
  assertEquals(
    kind("swift-spm", "Tests/ExampleAppTests/StoreTests.swift"),
    "test",
  );
  assertEquals(kind("swift-spm", "Package.swift"), "ignore");
});

Deno.test("hwstatus splits Mac and firmware and never counts managed_components", () => {
  assertEquals(kind("hwstatus", "Mac/Sources/ExampleDevice/App.swift"), "core");
  assertEquals(kind("hwstatus", "main/main.c"), "core");
  assertEquals(kind("hwstatus", "components/bsp/src/board.c"), "core");
  assertEquals(kind("hwstatus", "Renderer/render.c"), "core");
  assertEquals(
    kind("hwstatus", "Mac/Tests/ExampleDeviceTests/A.swift"),
    "test",
  );
  assertEquals(kind("hwstatus", "tests/test_quota.c"), "test");
  assertEquals(
    kind("hwstatus", "managed_components/lvgl__lvgl/src/lv_init.c"),
    "ignore",
  );
  assertEquals(kind("hwstatus", "docs/README.md"), "ignore");
  assertEquals(
    classifyPart("hwstatus", "Mac/Sources/ExampleDevice/App.swift"),
    "mac",
  );
  assertEquals(classifyPart("hwstatus", "main/main.c"), "firmware");
  assertEquals(classifyPart("hwstatus", "Renderer/render.c"), "firmware");
  assertEquals(classifyPart("web-svelte", "backend/server.ts"), null);
});

Deno.test("rust and blog profiles ignore build output and authored content", () => {
  assertEquals(kind("rust", "src/lib.rs"), "core");
  assertEquals(kind("rust", "clients/swift/Sources/Client.swift"), "core");
  assertEquals(kind("rust", "tests/api.rs"), "test");
  assertEquals(kind("rust", "target/release/atlas"), "ignore");
  assertEquals(kind("rust", "native/database/atlas.sqlite3"), "ignore");
  assertEquals(kind("rust", "unprocessed/legacy.py"), "ignore");
  assertEquals(kind("python-blog", "bloglib/build.py"), "core");
  assertEquals(kind("python-blog", "templates/blog.css"), "core");
  assertEquals(kind("python-blog", "worker.js"), "core");
  assertEquals(kind("python-blog", "public/index.html"), "ignore");
  assertEquals(kind("python-blog", "data/posts/hello.md"), "ignore");
  assertEquals(kind("python-blog", "tests/test_build.py"), "test");
  assertEquals(kind("python-tool", "src/merge.py"), "core");
  assertEquals(kind("python-tool", "tests/test_merge.py"), "test");
  assertEquals(kind("ios", "Sources/App.swift"), "core");
  assertEquals(kind("ios", "Tests/AppTests.swift"), "test");
  assertEquals(kind("vscode-ext", "src/extension.js"), "core");
  assertEquals(kind("vscode-ext", "native/scanner.c"), "core");
  assertEquals(kind("vscode-ext", "test/complete_test.js"), "test");
});
