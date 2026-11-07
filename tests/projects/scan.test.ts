import { assertEquals } from "@std/assert";
import { join } from "node:path";
import { shouldSkipDir } from "../../backend/projects/backend/exclude.ts";
import { inspectRepo } from "../../backend/projects/backend/git.ts";
import { scanRoot } from "../../backend/projects/backend/scan.ts";
import { git } from "./git_fixture.ts";

type GitDetails = {
  branch: string | null;
  changed_count: number | null;
  ahead_count: number | null;
  behind_count: number | null;
  upstream: string | null;
};

function details(value: unknown): GitDetails {
  return value as GitDetails;
}

Deno.test("skips dot dirs and archive directory names", () => {
  assertEquals(shouldSkipDir(".cursor"), true);
  assertEquals(shouldSkipDir(".archive"), true);
  assertEquals(shouldSkipDir("ExampleProject"), false);
  assertEquals(shouldSkipDir("ExampleOther"), false);
  assertEquals(shouldSkipDir("_abandoned"), true);
  assertEquals(shouldSkipDir("ExampleApp"), false);
  assertEquals(shouldSkipDir("ZoneHub"), false);
});

Deno.test("scanRoot skips an explicit compatibility-directory marker", async () => {
  const root = await Deno.makeTempDir();
  try {
    const compatibility = join(root, "ExampleLegacy");
    await Deno.mkdir(compatibility);
    await Deno.writeTextFile(
      join(compatibility, ".project-status-ignore"),
      "Retired project compatibility path.\n",
    );
    await Deno.mkdir(join(root, "ExampleIncluded"));

    const rows = await scanRoot(root);
    assertEquals(rows.map((row) => row.name), ["ExampleIncluded"]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("scanRoot does not treat an enclosing repository as a child project", async () => {
  const root = Deno.makeTempDirSync();
  try {
    await git(root, "init", "-b", "main");
    Deno.mkdirSync(join(root, "plain"));
    const rows = await scanRoot(root);
    assertEquals(rows.map((row) => row.name), ["plain"]);
    assertEquals(rows[0].is_git, false);
    assertEquals(rows[0].has_remote, false);
    assertEquals(rows[0].changed_count, null);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("scanRoot reports git states for direct children only", async () => {
  const root = Deno.makeTempDirSync();
  const remoteDir = Deno.makeTempDirSync();
  try {
    Deno.mkdirSync(join(root, "ExampleIncluded"));
    await git(join(root, "ExampleIncluded"), "init", "-b", "main");
    Deno.mkdirSync(join(root, ".hidden"));
    Deno.mkdirSync(join(root, "_abandoned"));
    Deno.mkdirSync(join(root, "plain"));
    Deno.writeTextFileSync(join(root, "plain", "readme.txt"), "hi");

    const clean = join(root, "clean");
    await git(clean, "init", "-b", "main");
    await git(clean, "config", "user.email", "test@example.com");
    await git(clean, "config", "user.name", "Test");
    Deno.writeTextFileSync(join(clean, "a.txt"), "a");
    await git(clean, "add", "a.txt");
    await git(clean, "commit", "-m", "a");

    const dirty = join(root, "dirty");
    await git(dirty, "init", "-b", "main");
    await git(dirty, "config", "user.email", "test@example.com");
    await git(dirty, "config", "user.name", "Test");
    Deno.writeTextFileSync(join(dirty, "a.txt"), "a");
    await git(dirty, "add", "a.txt");
    await git(dirty, "commit", "-m", "a");
    Deno.writeTextFileSync(join(dirty, "a.txt"), "changed");

    const multi = join(root, "multi");
    await git(multi, "init", "-b", "main");
    await git(multi, "config", "user.email", "test@example.com");
    await git(multi, "config", "user.name", "Test");
    Deno.writeTextFileSync(join(multi, "a.txt"), "a");
    await git(multi, "add", "a.txt");
    await git(multi, "commit", "-m", "a");
    await git(multi, "branch", "other");

    const remoteBare = join(remoteDir, "remote.git");
    await git(remoteDir, "init", "--bare", "-b", "main", remoteBare);

    const ahead = join(root, "ahead");
    await git(ahead, "init", "-b", "main");
    await git(ahead, "config", "user.email", "test@example.com");
    await git(ahead, "config", "user.name", "Test");
    Deno.writeTextFileSync(join(ahead, "a.txt"), "a");
    await git(ahead, "add", "a.txt");
    await git(ahead, "commit", "-m", "a");
    await git(ahead, "remote", "add", "origin", remoteBare);
    await git(ahead, "push", "-u", "origin", "main");
    Deno.writeTextFileSync(join(ahead, "a.txt"), "b");
    await git(ahead, "add", "a.txt");
    await git(ahead, "commit", "-m", "b");

    const noUpstream = join(root, "noupstream");
    await git(noUpstream, "init", "-b", "main");
    await git(noUpstream, "config", "user.email", "test@example.com");
    await git(noUpstream, "config", "user.name", "Test");
    Deno.writeTextFileSync(join(noUpstream, "a.txt"), "a");
    await git(noUpstream, "add", "a.txt");
    await git(noUpstream, "commit", "-m", "a");
    await git(noUpstream, "remote", "add", "origin", remoteBare);

    const nested = join(root, "plain", "nested-git");
    await git(nested, "init", "-b", "main");

    const rows = await scanRoot(root);
    const byName = Object.fromEntries(rows.map((row) => [row.name, row]));
    assertEquals(
      rows.map((row) => row.name).toSorted(),
      [
        "ExampleIncluded",
        "ahead",
        "clean",
        "dirty",
        "multi",
        "noupstream",
        "plain",
      ],
    );
    assertEquals(byName.plain.is_git, false);
    assertEquals(byName.plain.has_remote, false);
    assertEquals(byName.plain.is_dirty, false);
    assertEquals(byName.plain.is_unpushed, false);
    assertEquals(byName.plain.has_multiple_branches, false);
    assertEquals(details(byName.plain).branch, null);
    assertEquals(details(byName.plain).changed_count, null);
    assertEquals(details(byName.plain).ahead_count, null);
    assertEquals(details(byName.plain).behind_count, null);
    assertEquals(details(byName.plain).upstream, null);

    assertEquals(byName.clean.is_git, true);
    assertEquals(byName.clean.has_remote, false);
    assertEquals(byName.clean.is_dirty, false);
    assertEquals(byName.clean.is_unpushed, false);
    assertEquals(byName.clean.has_multiple_branches, false);

    assertEquals(byName.dirty.is_git, true);
    assertEquals(byName.dirty.is_dirty, true);
    assertEquals(byName.dirty.is_unpushed, false);
    assertEquals(details(byName.dirty).branch, "main");
    assertEquals(details(byName.dirty).changed_count, 1);
    assertEquals(details(byName.dirty).ahead_count, null);
    assertEquals(details(byName.dirty).behind_count, null);
    assertEquals(details(byName.dirty).upstream, null);

    assertEquals(byName.multi.has_multiple_branches, true);

    assertEquals(byName.ahead.has_remote, true);
    assertEquals(byName.ahead.is_dirty, false);
    assertEquals(byName.ahead.is_unpushed, true);
    assertEquals(details(byName.ahead).branch, "main");
    assertEquals(details(byName.ahead).changed_count, 0);
    assertEquals(details(byName.ahead).ahead_count, 1);
    assertEquals(details(byName.ahead).behind_count, 0);
    assertEquals(details(byName.ahead).upstream, "origin/main");

    assertEquals(byName.noupstream.has_remote, true);
    assertEquals(byName.noupstream.is_unpushed, true);
    assertEquals(details(byName.noupstream).branch, "main");
    assertEquals(details(byName.noupstream).changed_count, 0);
    assertEquals(details(byName.noupstream).ahead_count, null);
    assertEquals(details(byName.noupstream).behind_count, null);
    assertEquals(details(byName.noupstream).upstream, null);
  } finally {
    Deno.removeSync(root, { recursive: true });
    Deno.removeSync(remoteDir, { recursive: true });
  }
});

Deno.test("inspectRepo counts renames as one porcelain change", async () => {
  const root = Deno.makeTempDirSync();
  try {
    await git(root, "init", "-b", "main");
    await git(root, "config", "user.email", "test@example.com");
    await git(root, "config", "user.name", "Test");
    Deno.writeTextFileSync(join(root, "before.txt"), "content");
    await git(root, "add", "before.txt");
    await git(root, "commit", "-m", "initial");
    await git(root, "mv", "before.txt", "after.txt");

    const row = await inspectRepo("rename", root);
    assertEquals(row.is_dirty, true);
    assertEquals(details(row).changed_count, 1);
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("inspectRepo reports behind and diverged local upstream refs", async () => {
  const root = Deno.makeTempDirSync();
  const remoteDir = Deno.makeTempDirSync();
  try {
    const remote = join(remoteDir, "remote.git");
    await git(remoteDir, "init", "--bare", "-b", "main", remote);

    const behind = join(root, "behind");
    await git(behind, "init", "-b", "main");
    await git(behind, "config", "user.email", "test@example.com");
    await git(behind, "config", "user.name", "Test");
    Deno.writeTextFileSync(join(behind, "a.txt"), "a");
    await git(behind, "add", "a.txt");
    await git(behind, "commit", "-m", "initial");
    await git(behind, "remote", "add", "origin", remote);
    await git(behind, "push", "-u", "origin", "main");

    const other = join(root, "other");
    await git(root, "clone", remote, other);
    await git(other, "config", "user.email", "test@example.com");
    await git(other, "config", "user.name", "Test");
    Deno.writeTextFileSync(join(other, "remote.txt"), "remote");
    await git(other, "add", "remote.txt");
    await git(other, "commit", "-m", "remote");
    await git(other, "push", "origin", "main");
    await git(behind, "fetch", "origin");

    const behindRow = await inspectRepo("behind", behind);
    assertEquals(behindRow.is_unpushed, false);
    assertEquals(details(behindRow).branch, "main");
    assertEquals(details(behindRow).ahead_count, 0);
    assertEquals(details(behindRow).behind_count, 1);
    assertEquals(details(behindRow).upstream, "origin/main");

    const diverged = join(root, "diverged");
    await git(root, "clone", remote, diverged);
    await git(diverged, "config", "user.email", "test@example.com");
    await git(diverged, "config", "user.name", "Test");
    Deno.writeTextFileSync(join(diverged, "local.txt"), "local");
    await git(diverged, "add", "local.txt");
    await git(diverged, "commit", "-m", "local");
    Deno.writeTextFileSync(join(other, "remote-2.txt"), "remote-2");
    await git(other, "add", "remote-2.txt");
    await git(other, "commit", "-m", "remote-2");
    await git(other, "push", "origin", "main");
    await git(diverged, "fetch", "origin");

    const divergedRow = await inspectRepo("diverged", diverged);
    assertEquals(divergedRow.is_unpushed, true);
    assertEquals(details(divergedRow).ahead_count, 1);
    assertEquals(details(divergedRow).behind_count, 1);
    assertEquals(details(divergedRow).upstream, "origin/main");
  } finally {
    Deno.removeSync(root, { recursive: true });
    Deno.removeSync(remoteDir, { recursive: true });
  }
});
