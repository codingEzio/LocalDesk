import { isAbsolute, join, resolve } from "node:path";

/** Personal state is independent from the checkout; explicit paths stay explicit. */
export function dataDirectory(root: string): string {
  const home = Deno.env.get("HOME") || Deno.env.get("USERPROFILE");
  const explicit = Deno.env.get("LOCALDESK_DATA");
  if (explicit) {
    if (explicit.startsWith("~/")) {
      if (!home) {
        throw new Error("A user home is required for ~/LOCALDESK_DATA");
      }
      return resolve(home, explicit.slice(2));
    }
    return resolve(root, explicit);
  }
  if (!home) {
    throw new Error(
      "Configure LOCALDESK_DATA when the user home is unavailable",
    );
  }
  if (Deno.build.os === "darwin") {
    return join(home, "Library", "Application Support", "LocalDesk");
  }
  if (Deno.build.os === "windows") {
    const base = Deno.env.get("LOCALAPPDATA") || join(home, "AppData", "Local");
    if (!isAbsolute(base)) throw new Error("LOCALAPPDATA must be absolute");
    return join(base, "LocalDesk");
  }
  const xdg = Deno.env.get("XDG_DATA_HOME");
  if (xdg && !isAbsolute(xdg)) {
    throw new Error("XDG_DATA_HOME must be absolute");
  }
  return join(xdg || join(home, ".local", "share"), "localdesk");
}

export function settingsOverride(root: string): string {
  const explicit = Deno.env.get("LOCALDESK_CONFIG");
  return explicit
    ? resolve(root, explicit)
    : join(dataDirectory(root), "settings.local.json");
}
