# LocalDesk source releases

[简体中文](RELEASE.zh-CN.md) · [繁體中文](RELEASE.zh-TW.md)

Original LocalDesk code and documentation use MIT, Copyright (c) 2026 LocalDesk
contributors. The bundled modified font and fetched dependencies retain their
own terms. Preserve LICENSE, NOTICE.md and the entire font/notices directory.
Creating an export does not publish a repository, change remote visibility or
operate an installed service.

## Payload and behavior

The source-only ZIP contains the explicit `public-source.json` target list plus
`candidate-receipt.json`: app source, portable empty-source defaults, synthetic
tests, manifests/lockfiles, MIT/provenance notices and the optional pixel font.
It contains no Git history, private overrides, accounts/chats, Local data,
node_modules, caches, frontend dist, native tool binaries or source maps.
Original private history is retained separately; distributing this curated tree
does not require rewriting it.

Settings can connect/disconnect workspace and project sources immediately and
persist their state. New source reads/work stop after disconnect; history stays
local. Active/queued jobs block disconnect and can be stopped in Activity.
Disconnected and missing sources have different states. Changing source paths
still requires a restart. No model is configured in portable defaults.

## Reproduce and verify

In the source checkout, `deno task source-check --index` reviews named
source/index bytes. `deno task source-export --index` creates a sealed
directory, a ZIP and a `.zip.sha256` sidecar under ignored
`Local/public-candidates/`. The ZIP has a fixed `localdesk-source/` root and
normalized timestamps; source file permissions, bytes, complete entry list and
receipt are read back. Existing mismatched outputs are rejected rather than
overwritten. Python 3 standard library is the only exporter dependency.

Verify the delivered ZIP hash against the separately supplied expected hash. The
extracted verifier also works without Git or preparation-only source files:

```sh
shasum -a 256 /path/to/candidate.zip
python3 scripts/public_source.py --verify-archive /path/to/candidate.zip --sha256 EXPECTED_HASH
```

Archive verification rejects duplicate/extra/escaping/private entries, changed
bytes/modes, symlinks and oversized entries. It caps a file at 2 MiB, entries at
4096 and compressed/uncompressed totals at 64 MiB. The receipt binds exact file
hashes and modes; a hash is not an author signature or blanket rights clearance.

Extract outside another repository, then use the pinned package manager:

```sh
pnpm --dir frontend install --frozen-lockfile --ignore-scripts
pnpm --dir frontend build
deno task check
deno lint backend scripts tests
deno task test
```

Git executable is still required by synthetic project tests and product Git
features; the extracted source itself needs no .git directory. Frozen first
installation/fetch requires network. The pnpm package-manager version and both
lockfiles remain pinned. Build output includes the original app LICENSE.txt and
NOTICE.txt plus THIRD-PARTY-LICENSES.md for the code actually bundled, plus
fonts/notices. Keep those with any distributed web build. No built web package
or runtime/tool binaries are included in this ZIP.

## Scope and remaining decisions

macOS is the verified host. Existing source-connection UI/runtime evidence is
retained for unchanged behavior; this release preparation checks the new source
archive, fresh dependency installation/build and synthetic flows. It does not
claim a real model request, other OS/device, reboot or installed-service
upgrade. Dependency metadata is not full legal review of unshipped optional
platform binaries. A later binary/tool bundle needs its own license/artifact
review. Publication and any remote write remain separate owner decisions. The
original repositories' license and publication status are not changed by
LocalDesk MIT.
