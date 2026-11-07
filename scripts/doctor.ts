import { dirname } from "node:path";
import { loadSettings } from "../backend/settings.ts";
const settings = await loadSettings(dirname(import.meta.dirname!));
const modelsOnly = Deno.args.includes("--models");
if (Deno.args.some((a) => a !== "--models")) {
  throw new Error("usage: deno task doctor [--models]");
}
if (!modelsOnly) {
  console.log(
    `Deno ${Deno.version.deno}; LocalDesk ports ${settings.frontendPort}/${settings.backendPort}`,
  );
  for (
    const [command, args] of [["pnpm", ["--version"]], ["process-compose", [
      "version",
    ]], [settings.codexPath, ["--version"]]] as const
  ) {
    try {
      const out = await new Deno.Command(command, {
        args: [...args],
        stdout: "piped",
        stderr: "null",
      }).output();
      console.log(
        `${command.split("/").at(-1)}: ${
          out.success
            ? new TextDecoder().decode(out.stdout).trim()
            : "unavailable"
        }`,
      );
    } catch {
      console.log(
        `${
          command.split("/").at(-1)
        }: not installed (Codex is optional for browsing)`,
      );
    }
  }
}
try {
  const catalog = JSON.parse(await Deno.readTextFile(settings.modelsFile));
  if (!Array.isArray(catalog.models)) throw new Error("Invalid model catalog");
  console.log(JSON.stringify(
    {
      fetchedAt: catalog.fetched_at,
      models: catalog.models.filter((m: { visibility: string }) =>
        m.visibility === "list"
      ).map((
        m: { slug: string; supported_reasoning_levels: { effort: string }[] },
      ) => ({
        model: m.slug,
        efforts: m.supported_reasoning_levels.map((e) => e.effort),
      })),
    },
    null,
    2,
  ));
} catch (error) {
  console.log(
    `Model catalog unavailable: ${
      error instanceof Error ? error.message : error
    }. Browsing works without it.`,
  );
  if (modelsOnly) Deno.exit(1);
}
