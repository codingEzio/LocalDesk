import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

// Review source candidates only. Never inspect ignored runtime/account data.
const root = fileURLToPath(new URL("../", import.meta.url));
const maxBytes = 2 * 1024 * 1024;
const fontPath = "frontend/public/fonts/DeparturePixelZhCompact-Regular.woff2";
const provenancePath = "frontend/public/fonts/provenance.json";
const fontSha =
  "5622b5b65966cecdf29f35162fed055189ab0e369fbf925ef90b9e43c2e51cf4";
const personalHome = /\/(?:Users|home)\/(?!example\/)[^\s/]+\//;
const findings: { file: string; line?: number; reason: string }[] = [];
const flag = (file: string, reason: string, line?: number) =>
  findings.push({ file, ...(line ? { line } : {}), reason });
const result = await new Deno.Command("git", {
  args: [
    "-C",
    root,
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "-z",
  ],
  stdout: "piped",
  stderr: "null",
}).output();
let scope =
  "Git tracked and nonignored untracked candidates; no history or ignored data";
let files: string[];
if (result.success && result.stdout.length) {
  files = [
    ...new Set(
      new TextDecoder().decode(result.stdout).split("\0").filter(Boolean),
    ),
  ].sort();
} else {
  // Exported source has no private Git history. Audit its explicit receipt list,
  // not generated dependencies/builds or arbitrary filesystem neighbours.
  try {
    const receipt = JSON.parse(
      await Deno.readTextFile(join(root, "candidate-receipt.json")),
    );
    if (
      !Array.isArray(receipt.files) ||
      receipt.files.some((row: { path: unknown }) =>
        typeof row.path !== "string"
      )
    ) {
      throw new Error("Invalid source receipt");
    }
    files = [
      ...new Set<string>(
        receipt.files.map((row: { path: string }) => row.path),
      ),
      "candidate-receipt.json",
    ].sort();
    scope =
      "Receipt-listed source files only; no Git history, generated dependencies or runtime data";
  } catch {
    console.error(
      "Source audit needs a Git source index or exported candidate receipt.",
    );
    Deno.exit(1);
  }
}
const tokenPatterns = [
  /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/,
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/,
];
let textFiles = 0;
let fontVerified = false;
let provenance: unknown;
let actualFontSha = "";
for (const file of files) {
  if (
    isAbsolute(file) || file.includes("\\") ||
    file.split("/").some((part) => !part || part === ".." || part === ".")
  ) {
    flag(file, "unsafe source path; not read");
    continue;
  }
  const parts = file.split("/");
  const name = parts.at(-1)!;
  if (
    parts.some((p) => ["Local", ".git", "node_modules", "dist"].includes(p))
  ) {
    flag(
      file,
      "runtime or generated data included in source candidates; not read",
    );
    continue;
  }
  if (
    (name.startsWith(".env") && name !== ".env.example") ||
    /\.(?:db|sqlite|sqlite3|jsonl|pem|key|p12|pfx|keystore)$/i.test(name) ||
    /^(?:id_rsa|id_ed25519|id_ecdsa|auth\.json|credentials(?:\.json)?|settings\.local\.json)$/i
      .test(name)
  ) {
    flag(file, "private data or credential file path; not read");
    continue;
  }
  try {
    const path = join(root, file);
    let parent = root;
    for (const part of parts) {
      parent = join(parent, part);
      if ((await Deno.lstat(parent)).isSymlink) {
        throw new Error("Source symlink");
      }
    }
    const info = await Deno.lstat(path);
    if (info.isSymlink || !info.isFile) {
      flag(file, "non-regular source candidate; not read");
      continue;
    }
    if (info.size > maxBytes) {
      flag(file, "source candidate exceeds the 2 MiB review bound; not read");
      continue;
    }
    const bytes = await Deno.readFile(path);
    if (file === fontPath) {
      actualFontSha = [
        ...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
      ]
        .map((v) => v.toString(16).padStart(2, "0")).join("");
      continue;
    }
    if (bytes.includes(0)) {
      flag(file, "unreviewed binary source candidate");
      continue;
    }
    const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    textFiles++;
    source.split(/\r?\n/).forEach((line, index) => {
      if (personalHome.test(line)) {
        flag(file, "personal absolute home path", index + 1);
      }
      if (tokenPatterns.some((pattern) => pattern.test(line))) {
        flag(file, "credential-shaped text requires review", index + 1);
      }
    });
    if (file === provenancePath) provenance = JSON.parse(source);
  } catch {
    flag(file, "source candidate could not be read or decoded");
  }
}
const variants = (provenance as
  | { variants?: { files?: Record<string, string> }[] }
  | undefined)?.variants;
const declaredSha = Array.isArray(variants)
  ? variants.find((v) => v.files?.[fontPath.split("/").at(-1)!])?.files
    ?.[fontPath.split("/").at(-1)!]
  : undefined;
if (actualFontSha !== fontSha || declaredSha !== fontSha) {
  flag(
    fontPath,
    "font bytes or provenance do not match the reviewed source hash",
  );
} else {
  fontVerified = true;
}
for (const finding of findings) console.error(JSON.stringify(finding));
console.log(JSON.stringify({
  sourceCandidates: files.length,
  textFiles,
  fontVerified,
  findings: findings.length,
  scope,
}));
Deno.exit(findings.length ? 1 : 0);
