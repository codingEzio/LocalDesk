import { lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import process from "node:process";

function resolvedLocation(path: string): string {
  let current = path;
  for (;;) {
    try {
      return resolve(realpathSync(current), relative(current, path));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      try {
        if (lstatSync(current).isSymbolicLink()) {
          throw new Error(
            "LOCALDESK_DATA contains an unresolved symbolic link",
          );
        }
        throw error;
      } catch (entryError) {
        if ((entryError as NodeJS.ErrnoException).code !== "ENOENT") {
          throw entryError;
        }
      }
      const parent = dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}

function within(parent: string, path: string): boolean {
  const part = relative(parent, path);
  return part === "" ||
    (!isAbsolute(part) && part !== ".." && !part.startsWith(".." + sep));
}

/** Personal state is independent from the checkout; explicit paths stay explicit. */
export function dataDirectory(root: string): string {
  const home = process.env.HOME || process.env.USERPROFILE;
  const explicit = process.env.LOCALDESK_DATA;
  let data: string;
  if (explicit) {
    if (explicit.startsWith("~/")) {
      if (!home) {
        throw new Error("A user home is required for ~/LOCALDESK_DATA");
      }
      data = resolve(home, explicit.slice(2));
    } else {
      data = resolve(root, explicit);
    }
  } else if (!home) {
    throw new Error(
      "Configure LOCALDESK_DATA when the user home is unavailable",
    );
  } else if (process.platform === "darwin") {
    data = join(home, "Library", "Application Support", "LocalDesk");
  } else if (process.platform === "win32") {
    const base = process.env.LOCALAPPDATA || join(home, "AppData", "Local");
    if (!isAbsolute(base)) throw new Error("LOCALAPPDATA must be absolute");
    data = join(base, "LocalDesk");
  } else {
    const xdg = process.env.XDG_DATA_HOME;
    if (xdg && !isAbsolute(xdg)) {
      throw new Error("XDG_DATA_HOME must be absolute");
    }
    data = join(xdg || join(home, ".local", "share"), "localdesk");
  }
  const checkout = resolve(root), ignored = join(checkout, "Local");
  const physicalRoot = resolvedLocation(checkout),
    physicalData = resolvedLocation(data);
  if (
    (within(checkout, data) && !within(ignored, data)) ||
    (within(physicalRoot, physicalData) &&
      !within(join(physicalRoot, "Local"), physicalData))
  ) {
    throw new Error(
      "LOCALDESK_DATA must be outside the checkout or under its ignored Local directory",
    );
  }
  return data;
}

export function settingsOverride(root: string): string {
  const explicit = process.env.LOCALDESK_CONFIG;
  return explicit
    ? resolve(root, explicit)
    : join(dataDirectory(root), "settings.local.json");
}
