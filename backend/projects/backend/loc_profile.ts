export type LocProfileId =
  | "skip"
  | "web-svelte"
  | "deno-vanilla"
  | "python-tool"
  | "python-blog"
  | "swift-spm"
  | "safari-ext"
  | "dual-extension"
  | "sitekit"
  | "hwstatus"
  | "rust"
  | "ios"
  | "vscode-ext";

export type LocKind = "core" | "test" | "ignore";
export type LocPartId = "mac" | "firmware";

export const IGNORE_DIR_NAMES = new Set([
  "node_modules",
  "dist",
  ".build",
  "target",
  "DerivedData",
  ".venv",
  "__pycache__",
  "Local",
  ".git",
  ".vite",
  "managed_components",
  "vendor",
  "fonts",
  "Licenses",
  "licenses",
  "Assets.xcassets",
  ".next",
  ".blog-cache",
  ".wrangler",
  "xcuserdata",
  ".ruff_cache",
]);

const CODE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".svelte",
  ".css",
  ".html",
  ".swift",
  ".m",
  ".mm",
  ".h",
  ".hpp",
  ".hh",
  ".cpp",
  ".cc",
  ".cxx",
  ".c",
  ".rs",
  ".py",
  ".go",
]);

export function skipProject(name: string): boolean {
  if (name.startsWith(".") || name.startsWith("_")) return true;
  return false;
}

export function detectProfile(
  name: string,
  hints: readonly string[],
): LocProfileId {
  if (skipProject(name)) return "skip";
  const has = (prefix: string) =>
    hints.some((hint) => hint === prefix || hint.startsWith(`${prefix}/`));
  if (has("frontend/src")) return "web-svelte";
  if (has("bloglib")) return "python-blog";
  if (has("Cargo.toml")) return "rust";
  if (has("Mac/Package.swift") && has("main")) return "hwstatus";
  if (has("src/sites.js") || has("src/sites")) return "sitekit";
  if (has("extension_chrome") && has("extension_safari")) {
    return "dual-extension";
  }
  if (hints.some((hint) => hint.includes("Extension"))) return "safari-ext";
  if (has("Package.swift")) return "swift-spm";
  if (
    hints.some((hint) => hint.endsWith(".xcodeproj")) ||
    (has("project.yml") && has("Sources"))
  ) {
    return "ios";
  }
  if (has("pyproject.toml") && has("src")) return "python-tool";
  if (
    has("package.json") && has("src") && (has("native") || has("extension.js"))
  ) {
    return "vscode-ext";
  }
  if (has("src") && has("public")) return "deno-vanilla";
  return "skip";
}

export function posixPath(relativePath: string): string {
  return relativePath.replaceAll("\\", "/").replace(/^\.\//, "");
}

export function isIgnoredDirName(name: string): boolean {
  if (name.startsWith(".")) return true;
  return IGNORE_DIR_NAMES.has(name);
}

export function isCodeFile(relativePath: string): boolean {
  const path = posixPath(relativePath);
  const slash = path.lastIndexOf("/");
  const name = slash >= 0 ? path.slice(slash + 1) : path;
  const dot = name.lastIndexOf(".");
  if (dot < 0) return false;
  const ext = name.slice(dot).toLowerCase();
  if (CODE_EXTENSIONS.has(ext)) return true;
  if (ext === ".json" && path.includes("/locales/")) return true;
  return false;
}

function startsWithPath(path: string, prefix: string): boolean {
  const value = posixPath(path);
  return value === prefix || value.startsWith(`${prefix}/`);
}

function fileName(path: string): string {
  const value = posixPath(path);
  const slash = value.lastIndexOf("/");
  return slash >= 0 ? value.slice(slash + 1) : value;
}

function ignoredByTree(path: string): boolean {
  return posixPath(path).split("/").some((segment) =>
    isIgnoredDirName(segment)
  );
}

function sourceKind(path: string, core: boolean, test: boolean): LocKind {
  if (!isCodeFile(path) || ignoredByTree(path)) return "ignore";
  if (test) return "test";
  if (core) return "core";
  return "ignore";
}

export function classifyPath(
  profile: LocProfileId,
  relativePath: string,
): LocKind {
  if (profile === "skip") return "ignore";
  const path = posixPath(relativePath);
  if (ignoredByTree(path)) return "ignore";
  switch (profile) {
    case "web-svelte":
      return sourceKind(
        path,
        startsWithPath(path, "backend") ||
          startsWithPath(path, "frontend/src") ||
          startsWithPath(path, "db") ||
          path === "version.ts",
        startsWithPath(path, "tests") || startsWithPath(path, "Tests"),
      );
    case "deno-vanilla":
      return sourceKind(
        path,
        startsWithPath(path, "src") ||
          (startsWithPath(path, "public") && fileName(path) !== "motion.js"),
        startsWithPath(path, "tests"),
      );
    case "python-tool":
      return sourceKind(
        path,
        startsWithPath(path, "src"),
        startsWithPath(path, "tests"),
      );
    case "python-blog":
      return sourceKind(
        path,
        startsWithPath(path, "bloglib") ||
          startsWithPath(path, "templates") ||
          path === "worker.js",
        startsWithPath(path, "tests"),
      );
    case "swift-spm":
      return sourceKind(
        path,
        startsWithPath(path, "Sources"),
        startsWithPath(path, "Tests"),
      );
    case "safari-ext": {
      const extensionResource = /Extension\/Resources\//.test(path);
      const testScript = startsWithPath(path, "script") &&
        path.includes(".test.");
      return sourceKind(
        path,
        extensionResource || path.endsWith(".swift"),
        testScript || startsWithPath(path, "tests"),
      );
    }
    case "dual-extension":
      return sourceKind(
        path,
        startsWithPath(path, "extension_chrome") ||
          startsWithPath(path, "extension_safari/web-extension") ||
          (startsWithPath(path, "extension_safari/host") &&
            path.endsWith(".swift")),
        startsWithPath(path, "tests"),
      );
    case "sitekit":
      return sourceKind(
        path,
        startsWithPath(path, "src") ||
          path === "scripts/build.js" ||
          (startsWithPath(path, "extension_safari/host") &&
            path.endsWith(".swift")),
        startsWithPath(path, "tests"),
      );
    case "hwstatus":
      return sourceKind(
        path,
        startsWithPath(path, "Mac/Sources") ||
          startsWithPath(path, "main") ||
          startsWithPath(path, "components/bsp") ||
          startsWithPath(path, "bootloader_components") ||
          startsWithPath(path, "Renderer"),
        startsWithPath(path, "Mac/Tests") || startsWithPath(path, "tests"),
      );
    case "rust":
      return sourceKind(
        path,
        startsWithPath(path, "src") || startsWithPath(path, "clients/swift"),
        startsWithPath(path, "tests"),
      );
    case "ios":
      return sourceKind(
        path,
        startsWithPath(path, "Sources"),
        startsWithPath(path, "Tests") || startsWithPath(path, "UITests"),
      );
    case "vscode-ext":
      return sourceKind(
        path,
        startsWithPath(path, "src") || startsWithPath(path, "native"),
        startsWithPath(path, "test") || startsWithPath(path, "tests"),
      );
    default:
      return "ignore";
  }
}

export function classifyPart(
  profile: LocProfileId,
  relativePath: string,
): LocPartId | null {
  if (profile !== "hwstatus") return null;
  if (classifyPath(profile, relativePath) !== "core") return null;
  const path = posixPath(relativePath);
  if (startsWithPath(path, "Mac/Sources")) return "mac";
  if (
    startsWithPath(path, "main") ||
    startsWithPath(path, "components/bsp") ||
    startsWithPath(path, "bootloader_components") ||
    startsWithPath(path, "Renderer")
  ) {
    return "firmware";
  }
  return null;
}
