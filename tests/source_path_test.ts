import { assertEquals } from "@std/assert";
import { blockedWorkspaceRelative } from "../backend/source_path.ts";

Deno.test("workspace source paths reject escapes and private directories across platforms", () => {
  for (const path of ["", "config", "Personal/Settings", "tools/example"]) {
    assertEquals(blockedWorkspaceRelative(path), false, path);
  }
  for (
    const path of [
      "../outside",
      "..\\outside",
      "/outside",
      "D:\\outside",
      "D:outside",
      "\\\\server\\share",
      "Local/private",
      "local\\private",
      ".git/config",
      ".GIT\\config",
    ]
  ) {
    assertEquals(blockedWorkspaceRelative(path), true, path);
  }
});
