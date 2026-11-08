import { isAbsolute, win32 } from "node:path";

/** Reject workspace escapes and private metadata on both POSIX and Windows. */
export function blockedWorkspaceRelative(path: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  const parts = normalized.split("/").filter((part) => part && part !== ".");
  const first = parts[0]?.toLowerCase() ?? "";
  return isAbsolute(path) || win32.isAbsolute(path) || /^[a-z]:/i.test(path) ||
    parts.includes("..") || first === "local" || first.startsWith(".git");
}
