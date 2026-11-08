#!/usr/bin/env python3
"""Check an explicit source candidate; never publish, sign, install or run the app."""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parent.parent
MANIFEST = "public-source.json"
RECEIPT = "candidate-receipt.json"
TEXT_SUFFIXES = {".swift", ".sh", ".py", ".md", ".json", ".conf", ".txt", ".svg", ".java", ".xml", ".kts", ".properties", ".ts", ".yaml", ".toml", ".kt", ".bat", ".svelte", ".css", ".html", ".lock"}
PATTERNS = [
    re.compile(r"/(?:Users|home)/[^\s/]+/"),
    re.compile("Apple " + r"Development:\s*[^\n\"<>]+"),
    re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
    re.compile(r"\b(?:ghp_|github_pat_|sk-proj-)[A-Za-z0-9_]{12,}"),
]


def digest(data):
    return hashlib.sha256(data).hexdigest()


def encoded(value):
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n").encode()


def safe_relative(value):
    path = PurePosixPath(value)
    if (not value or path.is_absolute() or str(path) != value
            or any(part in {".", "..", ".git", "Local", ".DS_Store", "node_modules", "dist"} for part in path.parts)
            or "\\" in value or any(ord(c) < 32 for c in value)):
        raise ValueError("Unsafe manifest path")
    name = path.name
    if ((name.startswith(".env") and name != ".env.example")
            or name in {"settings.local.json", "skills.local.json", "auth.json", "credentials.json"}
            or path.suffix.lower() in {".db", ".sqlite", ".sqlite3", ".jsonl", ".pem", ".key", ".p12", ".pfx", ".keystore"}):
        raise ValueError("Private source path rejected before reading")
    return path


def no_links(root, relative):
    current = root
    for part in relative.parts:
        current = current / part
        if current.is_symlink():
            raise ValueError(f"Symlink rejected: {relative}")


def scan(name, data):
    if Path(name).suffix in TEXT_SUFFIXES or Path(name).name in {"justfile", ".gitignore", "LICENSE", "build", "check-wire", "gradlew"}:
        text = data.decode("utf-8")
        if name in {"tests/projects/db.test.ts", "tests/projects/runtime_facts.test.ts"}:
            text = text.replace("/home/" + "example/", "/synthetic/")
        if any(pattern.search(text) for pattern in PATTERNS):
            raise ValueError(f"Review private source content: {name}")


def inventory(root):
    files, directories = set(), set()
    for current, dirs, names in os.walk(root, followlinks=False):
        for name in dirs + names:
            path = Path(current) / name
            if path.is_symlink():
                raise ValueError("Candidate contains a symlink")
            relative = path.relative_to(root).as_posix()
            if path.is_dir():
                directories.add(relative)
            elif path.is_file():
                files.add(relative)
            else:
                raise ValueError("Candidate contains a non-regular file")
    return files, directories


def verify_candidate(target, receipt):
    if target.is_symlink() or not target.is_dir():
        raise ValueError("Candidate directory is unsafe")
    expected = {row["path"] for row in receipt["files"]} | {RECEIPT}
    parents = set()
    for name in expected:
        parents.update(str(p) for p in PurePosixPath(name).parents if str(p) != ".")
    files, directories = inventory(target)
    if files != expected or directories != parents:
        raise ValueError("Candidate inventory differs; nothing was overwritten")
    if (target / RECEIPT).read_bytes() != encoded(receipt):
        raise ValueError("Candidate receipt differs; nothing was overwritten")
    for row in receipt["files"]:
        path = target / row["path"]
        if (digest(path.read_bytes()) != row["sha256"] or path.stat().st_size != row["bytes"]
                or stat.S_IMODE(path.stat().st_mode) != row["mode"]):
            raise ValueError(f"Candidate readback differs: {row['path']}")
    if stat.S_IMODE((target / RECEIPT).stat().st_mode) != 0o644:
        raise ValueError("Candidate receipt mode differs")


ARCHIVE_ROOT = "localdesk-source/"
MAX_ARCHIVE_BYTES = 64 * 1024 * 1024
MAX_ENTRY_BYTES = 2 * 1024 * 1024


def verify_archive(path, receipt):
    if path.is_symlink() or not path.is_file() or path.stat().st_size > MAX_ARCHIVE_BYTES:
        raise ValueError("Archive must be a bounded regular file")
    rows = receipt["files"]
    if digest(encoded(rows)) != receipt["seal"]:
        raise ValueError("Receipt seal differs from its file manifest")
    expected = {}
    for row in rows:
        safe_relative(row["path"])
        if row["path"] in expected or row["mode"] not in {0o644, 0o755}:
            raise ValueError("Invalid archive manifest")
        expected[row["path"]] = row
    if not expected or len(expected) > 4096:
        raise ValueError("Archive entry count outside bounds")
    with zipfile.ZipFile(path) as archive:
        entries = archive.infolist()
        names = [entry.filename for entry in entries]
        wanted = {ARCHIVE_ROOT + name for name in expected} | {ARCHIVE_ROOT + RECEIPT}
        if len(names) != len(set(names)) or set(names) != wanted:
            raise ValueError("Archive entries differ from manifest")
        if sum(entry.file_size for entry in entries) > MAX_ARCHIVE_BYTES:
            raise ValueError("Uncompressed archive exceeds bounds")
        for entry in entries:
            name = entry.filename.removeprefix(ARCHIVE_ROOT)
            safe_relative(name)
            mode = entry.external_attr >> 16
            if (entry.flag_bits & 1 or entry.is_dir() or not stat.S_ISREG(mode)
                    or entry.file_size > MAX_ENTRY_BYTES or entry.create_system != 3):
                raise ValueError("Unsafe archive entry type or size")
            data = archive.read(entry)
            if name == RECEIPT:
                if stat.S_IMODE(mode) != 0o644 or data != encoded(receipt):
                    raise ValueError("Archive receipt differs")
            else:
                row = expected[name]
                if (digest(data) != row["sha256"] or len(data) != row["bytes"]
                        or stat.S_IMODE(mode) != row["mode"]):
                    raise ValueError("Archive entry bytes or mode differ: " + name)


def create_archive(candidate, receipt):
    output = candidate.with_suffix(".zip")
    if not output.exists() and not output.is_symlink():
        descriptor, temporary_name = tempfile.mkstemp(prefix="delete_after_use_zip_", dir=candidate.parent)
        os.close(descriptor)
        temporary = Path(temporary_name)
        try:
            with zipfile.ZipFile(temporary, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
                modes = {row["path"]: row["mode"] for row in receipt["files"]}
                modes[RECEIPT] = 0o644
                for name, mode in sorted(modes.items()):
                    entry = zipfile.ZipInfo(ARCHIVE_ROOT + name, date_time=(1980, 1, 1, 0, 0, 0))
                    entry.create_system = 3
                    entry.external_attr = (stat.S_IFREG | mode) << 16
                    entry.compress_type = zipfile.ZIP_DEFLATED
                    archive.writestr(entry, (candidate / name).read_bytes(), compresslevel=9)
            temporary.chmod(0o644)
            verify_archive(temporary, receipt)
            if output.exists() or output.is_symlink():
                raise ValueError("Archive appeared during export; retry without overwriting")
            temporary.rename(output)
        finally:
            temporary.unlink(missing_ok=True)
    verify_archive(output, receipt)
    checksum = digest(output.read_bytes())
    sidecar = output.with_suffix(".zip.sha256")
    text = checksum + "  " + output.name + "\n"
    if sidecar.exists() or sidecar.is_symlink():
        if sidecar.is_symlink() or sidecar.read_text() != text:
            raise ValueError("Archive checksum sidecar differs")
    else:
        with sidecar.open("x") as stream:
            stream.write(text)
    return output, checksum


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--export", action="store_true", help="Export under ignored Local/public-candidates")
    parser.add_argument("--index", action="store_true", help="Also inspect selected Git index blobs and modes")
    parser.add_argument("--release", action="store_true", help="Fail while publication blockers remain")
    parser.add_argument("--verify-archive", type=Path, help="Verify a source ZIP without Git or preparation-only mappings")
    parser.add_argument("--sha256", help="Expected archive hash obtained separately from the ZIP")
    args = parser.parse_args()
    if args.verify_archive:
        if (args.export or args.index or args.release or not args.sha256
                or not re.fullmatch(r"[a-f0-9]{64}", args.sha256)):
            raise ValueError("Archive verification requires only --verify-archive and --sha256")
        if args.verify_archive.stat().st_size > MAX_ARCHIVE_BYTES:
            raise ValueError("Archive exceeds bounds")
        if digest(args.verify_archive.read_bytes()) != args.sha256:
            raise ValueError("Archive SHA-256 differs from expected hash")
        with zipfile.ZipFile(args.verify_archive) as archive:
            raw = archive.getinfo(ARCHIVE_ROOT + RECEIPT)
            if raw.file_size > MAX_ENTRY_BYTES:
                raise ValueError("Receipt exceeds bounds")
            receipt = json.loads(archive.read(raw))
        verify_archive(args.verify_archive, receipt)
        print(json.dumps({"archiveVerified": True, "sha256": args.sha256, "seal": receipt["seal"], "files": len(receipt["files"])}, indent=2))
        return
    if args.sha256:
        raise ValueError("--sha256 requires --verify-archive")
    manifest_path = ROOT / MANIFEST
    if manifest_path.is_symlink():
        raise ValueError("Manifest must not be a symlink")
    manifest = json.loads(manifest_path.read_text())
    mappings = manifest["files"]
    receipt_path = ROOT / RECEIPT
    if receipt_path.is_symlink():
        raise ValueError("Candidate receipt must not be a symlink")
    if receipt_path.is_file():
        # A receipt must never switch a preparation checkout to its private targets.
        targets = {row["target"] for row in mappings}
        prep_only = {row["source"] for row in mappings if row["source"] != row["target"]} - targets
        for name in prep_only:
            relative = safe_relative(name)
            no_links(ROOT, relative)
            if (ROOT / relative).exists():
                raise ValueError("Receipt and preparation-only sources cannot coexist")
        if receipt_path.stat().st_size > MAX_ENTRY_BYTES:
            raise ValueError("Candidate receipt exceeds bounds")
        original = json.loads(receipt_path.read_bytes())
        rows = original["files"]
        if (original["schemaVersion"] != 1 or digest(encoded(rows)) != original["seal"]
                or original["releaseBlockers"] != manifest["releaseBlockers"]
                or [(row["source"], row["path"]) for row in rows]
                != [(row["source"], row["target"]) for row in mappings]):
            raise ValueError("Candidate receipt does not match the source manifest")
        for row in rows:
            relative = safe_relative(row["path"])
            no_links(ROOT, relative)
            path = ROOT / relative
            if (not path.is_file() or digest(path.read_bytes()) != row["sha256"]
                    or path.stat().st_size != row["bytes"]
                    or stat.S_IMODE(path.stat().st_mode) != row["mode"]):
                raise ValueError(f"Candidate receipt content differs: {relative}")
        # Verified exported source has target paths instead of preparation mappings.
        mappings = sorted(
            ({"source": row["target"], "target": row["target"]} for row in mappings),
            key=lambda row: row["source"],
        )
    names = [row["source"] for row in mappings]
    targets = [row["target"] for row in mappings]
    if len(targets) != len(set(targets)):
        raise ValueError("Duplicate target")
    for target in targets:
        safe_relative(target)
    if not names or names != sorted(set(names)) or MANIFEST not in names:
        raise ValueError("Manifest must contain a sorted unique file list including itself")
    if args.index:
        # A canonical source checkout must not silently exclude newly tracked or
        # unignored files from review. Exported sealed copies use their receipt.
        result = subprocess.run(
            ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
            cwd=ROOT, check=True, capture_output=True,
        )
        discovered = set(result.stdout.decode("utf-8").split("\0")) - {""}
        if discovered != set(names):
            raise ValueError("Git source inventory differs from the reviewed manifest")
    if args.release and manifest["releaseBlockers"]:
        raise ValueError("Release blocked: " + "; ".join(manifest["releaseBlockers"]))
    rows = []
    for name, target in zip(names, targets):
        relative = safe_relative(name)
        no_links(ROOT, relative)
        path = ROOT / name
        if not path.is_file():
            raise ValueError(f"Missing regular source file: {name}")
        data = path.read_bytes()
        scan(name, data)
        mode = stat.S_IMODE(path.stat().st_mode)
        if mode not in {0o644, 0o755}:
            raise ValueError(f"Unexpected source file mode: {name}")
        if args.index:
            result = subprocess.run(["git", "ls-files", "--stage", "--", name], cwd=ROOT,
                                    check=True, capture_output=True, text=True)
            fields = result.stdout.strip().split(maxsplit=3)
            expected_mode = "100755" if mode == 0o755 else "100644"
            if len(fields) != 4 or fields[0] != expected_mode or fields[2] != "0":
                raise ValueError(f"Missing/conflicted/mismatched index entry: {name}")
            staged = subprocess.run(["git", "show", f":{name}"], cwd=ROOT,
                                    check=True, capture_output=True).stdout
            scan(name, staged)
            if staged != data:
                raise ValueError(f"Index and working source differ: {name}")
        rows.append({"path": target, "source": name, "sha256": digest(data), "bytes": len(data), "mode": mode})
    seal = digest(encoded(rows))
    receipt = {"schemaVersion": 1, "seal": seal, "files": rows,
               "releaseBlockers": manifest["releaseBlockers"],
               "limitations": ["Selected files only; pattern scan is not a complete privacy/rights audit.",
                               "No Git history, runtime, installation or publication clearance."]}
    if args.export:
        output = ROOT / "Local" / "public-candidates"
        no_links(ROOT, PurePosixPath("Local/public-candidates"))
        output.mkdir(parents=True, exist_ok=True)
        target = output / seal
        if not target.exists() and not target.is_symlink():
            temporary = Path(tempfile.mkdtemp(prefix="delete_after_use_candidate_", dir=output))
            try:
                for row in rows:
                    destination = temporary / row["path"]
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    destination.write_bytes((ROOT / row["source"]).read_bytes())
                    destination.chmod(row["mode"])
                (temporary / RECEIPT).write_bytes(encoded(receipt))
                (temporary / RECEIPT).chmod(0o644)
                verify_candidate(temporary, receipt)
                if target.exists() or target.is_symlink():
                    raise ValueError("Candidate appeared during export; retry without overwriting")
                temporary.rename(target)
            finally:
                if temporary.exists():
                    shutil.rmtree(temporary)
        verify_candidate(target, receipt)
        archive, checksum = create_archive(target, receipt)
        print(f"Candidate: {target.relative_to(ROOT)}")
        print(f"Archive: {archive.relative_to(ROOT)}")
        print(f"Archive SHA-256: {checksum}")
    print(json.dumps({"seal": seal, "files": len(rows), "indexReviewed": args.index,
                      "releaseBlockers": manifest["releaseBlockers"]}, indent=2))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, UnicodeError, zipfile.BadZipFile, subprocess.CalledProcessError) as error:
        print(f"Source review failed: {error}", file=sys.stderr)
        sys.exit(1)
