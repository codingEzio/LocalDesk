import type { ProjectSnapshot } from "../db/store.ts";

export const DEFAULT_GIT_TIMEOUT_MS = 8_000;

export type StatusSnapshot = {
  branch: string | null;
  changed_count: number;
  upstream: string | null;
  ahead_count: number | null;
  behind_count: number | null;
};

/** One NUL-delimited Git status observation supplies file and branch facts. */
export function parseStatusSnapshot(output: string): StatusSnapshot {
  const snapshot: StatusSnapshot = {
    branch: null,
    changed_count: 0,
    upstream: null,
    ahead_count: null,
    behind_count: null,
  };
  const entries = output.split("\0");
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    if (entry.startsWith("# branch.head ")) {
      const branch = entry.slice("# branch.head ".length);
      snapshot.branch = branch === "(detached)" ? null : nullableLine(branch);
    } else if (entry.startsWith("# branch.upstream ")) {
      snapshot.upstream = nullableLine(
        entry.slice("# branch.upstream ".length),
      );
    } else if (entry.startsWith("# branch.ab ")) {
      const match = /^# branch\.ab \+(\d+) -(\d+)$/.exec(entry);
      if (match) {
        const ahead = Number(match[1]);
        const behind = Number(match[2]);
        if (Number.isSafeInteger(ahead) && Number.isSafeInteger(behind)) {
          snapshot.ahead_count = ahead;
          snapshot.behind_count = behind;
        }
      }
    } else if (/^[12u?] /.test(entry)) {
      snapshot.changed_count++;
      if (entry.startsWith("2 ")) index++;
    }
  }
  return snapshot;
}

export async function inspectRepo(
  name: string,
  path: string,
  timeoutMs = DEFAULT_GIT_TIMEOUT_MS,
): Promise<ProjectSnapshot> {
  const blank: ProjectSnapshot = {
    name,
    path,
    is_git: false,
    has_remote: false,
    is_dirty: false,
    is_unpushed: false,
    has_multiple_branches: false,
    branch: null,
    changed_count: null,
    ahead_count: null,
    behind_count: null,
    upstream: null,
  };
  // Git searches parent directories; only report this directory's own worktree.
  const top = await runGit(path, ["rev-parse", "--show-toplevel"], timeoutMs);
  if (!top.ok) return blank;
  try {
    if (await Deno.realPath(path) !== await Deno.realPath(top.stdout.trim())) {
      return blank;
    }
  } catch {
    return blank;
  }

  const remotes = await runGit(path, ["remote"], timeoutMs);
  const hasRemote = remotes.ok && remotes.stdout.trim().length > 0;
  const status = await runGit(
    path,
    [
      "status",
      "--porcelain=v2",
      "--branch",
      "--ahead-behind",
      "-z",
      "--untracked-files=all",
    ],
    timeoutMs,
  );
  const snapshot = status.ok
    ? parseStatusSnapshot(status.stdout)
    : await inspectBranchFallback(path, timeoutMs);
  const branches = await runGit(
    path,
    ["for-each-ref", "--format=%(refname)", "refs/heads/"],
    timeoutMs,
  );
  const branchCount = branches.ok
    ? branches.stdout.split("\n").filter(Boolean).length
    : 0;

  return {
    name,
    path,
    is_git: true,
    has_remote: hasRemote,
    is_dirty: snapshot.changed_count !== null && snapshot.changed_count > 0,
    is_unpushed: hasRemote &&
      (snapshot.ahead_count === null || snapshot.ahead_count > 0),
    has_multiple_branches: branchCount > 1,
    ...snapshot,
  };
}

// A failed status command must not erase branch facts that Git can still read.
async function inspectBranchFallback(path: string, timeoutMs: number) {
  const branch = await runGit(path, ["branch", "--show-current"], timeoutMs);
  const upstream = await runGit(
    path,
    ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
    timeoutMs,
  );
  const tracking = upstream.ok ? nullableLine(upstream.stdout) : null;
  const counts = tracking === null ? null : parseAheadBehind(
    await runGit(
      path,
      ["rev-list", "--left-right", "--count", "HEAD...@{u}"],
      timeoutMs,
    ),
  );
  return {
    branch: branch.ok ? nullableLine(branch.stdout) : null,
    changed_count: null,
    upstream: tracking,
    ahead_count: counts?.ahead_count ?? null,
    behind_count: counts?.behind_count ?? null,
  };
}

function nullableLine(value: string): string | null {
  const line = value.trim();
  return line.length > 0 ? line : null;
}

function parseAheadBehind(
  result: { ok: boolean; stdout: string },
): { ahead_count: number; behind_count: number } | null {
  if (!result.ok) return null;
  const values = result.stdout.trim().split(/\s+/).map((value) =>
    Number.parseInt(value, 10)
  );
  if (
    values.length < 2 ||
    values.some((value) => !Number.isSafeInteger(value) || value < 0)
  ) {
    return null;
  }
  return { ahead_count: values[0], behind_count: values[1] };
}

async function runGit(
  repo: string,
  args: string[],
  timeoutMs: number,
): Promise<{ ok: boolean; stdout: string }> {
  try {
    const command = new Deno.Command("git", {
      args: ["--no-optional-locks", "-C", repo, ...args],
      stdout: "piped",
      stderr: "piped",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const output = await command.output();
    return {
      ok: output.success,
      stdout: new TextDecoder().decode(output.stdout),
    };
  } catch {
    return { ok: false, stdout: "" };
  }
}
