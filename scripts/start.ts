import { dirname, join } from "node:path";
import { loadSettings } from "../backend/settings.ts";
const root = dirname(import.meta.dirname!);
const settings = await loadSettings(root);
for (
  const path of [
    settings.workspace,
    settings.projectsRoot,
    join(root, "frontend/dist"),
  ]
) {
  if (!(await Deno.stat(path)).isDirectory) {
    throw new Error("Run deno task setup and pnpm --dir frontend build first");
  }
}
// Fail before starting either process if a configured port is already occupied.
const sockets: Deno.TcpListener[] = [];
try {
  for (const port of [settings.frontendPort, settings.backendPort]) {
    sockets.push(Deno.listen({ hostname: "0.0.0.0", port }));
  }
} finally {
  for (const socket of sockets) socket.close();
}
const child = new Deno.Command("process-compose", {
  args: ["-f", join(root, "process-compose.yaml"), "--no-server", "up"],
  cwd: root,
  env: { LOCALDESK_DENO: Deno.execPath() },
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
}).spawn();
const stop = () => {
  try {
    child.kill("SIGTERM");
  } catch { /* Already stopped. */ }
};
Deno.addSignalListener("SIGTERM", stop);
Deno.addSignalListener("SIGINT", stop);
const status = await child.status;
Deno.removeSignalListener("SIGTERM", stop);
Deno.removeSignalListener("SIGINT", stop);
Deno.exit(status.code);
