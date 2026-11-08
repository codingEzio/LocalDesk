import type { LocCount, LocPart } from "./loc_count.ts";
import { refreshLocCounts } from "./loc_count.ts";
import type { LocStat, ProjectStore } from "../db/store.ts";
import type { LocPolicy } from "./loc_profile.ts";

export type LocProvider = {
  refresh: (projects: { name: string; path: string }[]) => Promise<void>;
};

function asParts(parts: LocStat["parts"]): LocPart[] | undefined {
  if (!parts) return undefined;
  const filtered = parts.filter((part): part is LocPart =>
    part.id === "mac" || part.id === "firmware"
  );
  return filtered.length > 0 ? filtered : undefined;
}

function asCount(stat: LocStat): LocCount {
  return {
    name: stat.name,
    profile: stat.profile as LocCount["profile"],
    core: stat.core,
    test: stat.test,
    counted_at: stat.counted_at,
    fingerprint: stat.fingerprint,
    parts: asParts(stat.parts),
    files: [],
  };
}

export function createLocProvider(
  store: ProjectStore,
  policy?: LocPolicy,
): LocProvider {
  let inflight: Promise<void> | null = null;
  let pending: { name: string; path: string }[] | null = null;

  const run = async (projects: { name: string; path: string }[]) => {
    const previous = new Map(
      store.listLoc().map((stat) => [stat.name, asCount(stat)]),
    );
    const { counts, drop } = await refreshLocCounts(projects, previous, {
      policy,
    });
    for (const count of counts) {
      store.upsertLoc({
        name: count.name,
        profile: count.profile,
        core: count.core,
        test: count.test,
        counted_at: count.counted_at,
        fingerprint: count.fingerprint,
        parts: count.parts ?? null,
      });
    }
    store.deleteLoc(drop);
  };

  return {
    refresh(projects) {
      pending = projects;
      if (inflight) return inflight;
      inflight = (async () => {
        while (pending) {
          const batch = pending;
          pending = null;
          await run(batch);
        }
      })().finally(() => {
        inflight = null;
      });
      return inflight;
    },
  };
}
