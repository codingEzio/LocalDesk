import { assertEquals } from "@std/assert";
import { parseStatusSnapshot } from "../../backend/projects/backend/git.ts";

Deno.test("Git v2 snapshot retains branch counts and ignores header-like filenames", () => {
  const output = [
    "# branch.oid 0123456789abcdef",
    "# branch.head main",
    "# branch.upstream origin/main",
    "# branch.ab +3 -2",
    "# future-header may be ignored",
    "1 .M N... 100644 100644 100644 abc abc file.txt",
    "2 R. N... 100644 100644 100644 abc abc R100 renamed.txt",
    "# branch.head old-name.txt",
    "u UU N... 100644 100644 100644 100644 abc def abc conflict.txt",
    "? file\n# branch.head misleading.txt",
    "! ignored.txt",
    "",
  ].join("\0");
  assertEquals(parseStatusSnapshot(output), {
    branch: "main",
    changed_count: 4,
    upstream: "origin/main",
    ahead_count: 3,
    behind_count: 2,
  });
});

Deno.test("unborn and detached snapshots retain unknown tracking state", () => {
  assertEquals(
    parseStatusSnapshot("# branch.oid (initial)\0# branch.head main\0"),
    {
      branch: "main",
      changed_count: 0,
      upstream: null,
      ahead_count: null,
      behind_count: null,
    },
  );
  assertEquals(
    parseStatusSnapshot("# branch.oid abc\0# branch.head (detached)\0"),
    {
      branch: null,
      changed_count: 0,
      upstream: null,
      ahead_count: null,
      behind_count: null,
    },
  );
});

Deno.test("snapshot counts all 10,000 changes and never treats a rename source as a change", () => {
  const files = Array.from({ length: 10_000 }, (_, index) => `? file-${index}`)
    .join("\0");
  assertEquals(
    parseStatusSnapshot(`# branch.head main\0${files}\0`).changed_count,
    10_000,
  );
  assertEquals(
    parseStatusSnapshot(
      "2 R. N... 100644 100644 100644 abc abc R100 new\0? old\0",
    ).changed_count,
    1,
  );
});
