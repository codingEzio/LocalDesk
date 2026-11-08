# Source candidate boundary

Original LocalDesk code/docs are MIT; third-party materials retain their terms.
Private messages,
model/account catalogs, sessions, preferences, runtime settings, deployed
services and existing workspaces are outside this review. They are neither
copied nor used as fixtures.

`public-source.json` lists the canonical checkout's explicit source paths.
`deno task source-check --index` checks selected working files against the Git
index and rejects tracked or unignored files missing from the manifest;
`deno task source-export --index` writes an
immutable hash-bound copy, ZIP and SHA-256 sidecar under ignored
`Local/public-candidates`. ZIP entries, bytes and Unix file modes are read back;
`--verify-archive PATH --sha256 EXPECTED` also works from an extracted copy
without Git. Repeating an export verifies inventory, contents and file modes
before reuse. Existing output with changed contents, added files/directories or
symlinks is rejected.

The exported tree omits private task/error history, personal project profile
overrides and dated account/service acceptance. It retains application source,
portable profile detection and defaults, synthetic tests, dependency
lockfiles, font provenance and all notices. No Git history is exported, rewritten
or cleared. The checkout is editable; each source export creates a new receipt.
An extracted sealed copy is verified against its receipt, hashes and modes and
rejects mixing with preparation-only files. `--index` requires a Git index.

The exporter also rejects runtime/cache directories, local override names and
database/key file paths before reading them. Python 3 standard library is
required for the export commands.

Both source scanners are bounded heuristics, not proof of secret absence. The
generic audit uses a source-only local Git index when available. Without Git it
audits only the exported receipt list and reports that narrower scope; generated
dependencies/builds and runtime data are excluded. Its generic home-path scan
permits the documented fictional example-user home fixtures. The export scanner
permits that literal only in the two existing pure project tests that use it.
Font bytes must match their recorded SHA-256. Checks do not replace the explicit
MIT grant or prove every upstream redistribution claim.

Preparation checks use an isolated source copy, fresh HOME, temporary
directories and dependency caches, outside another repository and without a .git
directory. The existing HTTP tests create only synthetic skills, project
repositories, jobs and model catalogs, use a fake CLI and bind temporary
loopback ports. Their restart/cancellation tests concern owned fixture children,
never an installed service. No real Codex invocation, account discovery, paid
request, source workspace scan or browser profile is used.

Run frozen dependency installation, frontend build, Deno typecheck/lint, tests
and source audit in that isolated copy. Do not run setup/start/service/doctor
against a normal checkout as part of source preparation. Product usage
documentation describes those explicit runtime operations separately. Build/test
success does not establish installed UI, account execution, permission or
other-host acceptance. The curated source payload and included notices are
reviewed separately from private Git history. Publishing or distributing a new
artifact, or claiming another platform, requires its own review.
