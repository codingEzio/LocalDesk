# Configuration

Defaults are in `config/settings.json`. Private `<data>/settings.local.json`
overrides only named fields. `<data>` is the resolved product profile directory: macOS
Application Support/LocalDesk; Linux XDG_DATA_HOME/localdesk or ~/.local/share/localdesk;
Windows LOCALAPPDATA/LocalDesk or ~/AppData/Local/LocalDesk. Only macOS is verified.
`LOCALDESK_DATA` overrides that directory; relative values resolve from the checkout.
All jobs, capability, chats, module/source preferences, SQLite and skill-management
records live there. `settings.local.json` and `skills.local.json` also live there.
The two default source folders are `<data>/workspace` and `<data>/projects`; JSON
`null` selects those owned empty defaults. Explicit source paths retain their meaning. If `LOCALDESK_CONFIG` is set, that file replaces
the usual local override; an absent explicitly selected file is an error.
Relative file and directory paths, including the override path, resolve from the
project root, not the shell's current directory. `~/` uses HOME (USERPROFILE
fallback). Invalid values fail visibly. Configuration changes require a process
restart; UI Refresh updates discovery and model availability, not server
configuration. Source connection switches in Settings apply immediately without
a restart; they do not change the configured paths.

| Setting                        | Default           | Purpose and limits                                                                                                                                                                                |
| ------------------------------ | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workspace`                    | `null` → `<data>/workspace` | Selected configuration/source folder. Setup creates only this default; a custom directory must exist.                                                                                             |
| `projectsRoot`                 | `null` → `<data>/projects`  | Immediate child projects available to the workbench. Excluded/archive directories and escaping targets cannot become chat workspaces.                                                             |
| `frontendPort` / `backendPort` | `10000` / `15000` | Distinct integers 1–65535. Conflicts fail. Managed workspace assignments override these in the ignored local file.                                                                                |
| `frontendHost`                 | `0.0.0.0`         | LAN shell by default. Direct dev/server commands can explicitly use loopback for tests. Process Compose enforces LAN binding via `LOCALDESK_HOST`.                                                |
| `shareCatalogOnLan`            | `false`           | Explicitly enables only GET catalog/state and workbench sharing. Directory/Git metadata then becomes visible on LAN; jobs/chats/control remain local.                                             |
| `runtimeRegistry`              | `null`            | Optional absolute/relative registry file for project runtime observations. Absent means unknown runtime, not HTTP failure. This does not allocate ports or manage services.                       |
| `codexPath`                    | `codex`           | Resolve a bare executable on PATH or configure a path. No executable means browsing only.                                                                                                         |
| `modelsFile`                   | `null`            | Auto-resolve `models_cache.json` under CODEX_HOME, otherwise the home `.codex` directory. No credentials are read. Missing/invalid catalog blocks model execution.                                |
| `sessionArchiveDirectory`      | `null`            | Same Codex-home resolution for `archived_sessions`; only owned thread filename checks are used for idempotent archive handling.                                                                   |
| `preset`                       | `default`         | Name of the default entry in `presets`; if entries exist the name must match.                                                                                                                     |
| `presets`                      | `[]`              | Explicit `{name, model, effort, tier}` choices; tier is `default` or `priority`. The current local model catalog validates availability, effort and Fast support. Empty means no model execution. |
| `approvalMode`                 | `sandbox`         | Workspace-write with escalation denied for noninteractive requests. `review` explicitly opts into Codex automatic approval review. No sandbox/trust bypass mode.                                  |
| `sessionOperationTimeoutMs`    | `45000`           | CLI archive/restore deadline; 1–300000 ms.                                                                                                                                                        |
| `scanIntervalMs`               | `15000`           | Catalog scan interval; 1–86400000 ms. Overlapping scans do not accumulate.                                                                                                                        |
| `projectScanIntervalMs`        | `30000`           | Interval after completion of the preceding project scan; 1–86400000 ms.                                                                                                                           |
| `maxQueuedJobs`                | `8`               | Running plus queued work limit; 1–100, one job executes at a time.                                                                                                                                |
| `maxPromptCharacters`          | `12000`           | Instruction length limit; 1–1000000.                                                                                                                                                              |
| `maxJobMinutes`                | `45`              | Per-job deadline; 1–1440 minutes.                                                                                                                                                                 |
| `maxOutputBytes`               | `2097152`         | Captured output budget; 1–16777216 bytes. Output-limit failure is visible.                                                                                                                        |
| `discoveryDirectories`         | `["plugins"]`     | Project-relative plugin-manifest directories; no absolute or escaping paths.                                                                                                                      |

These upper bounds limit queue/memory/time mistakes; they are not performance
claims at their maximum. Defaults preserve the original bounded serial workflow.
Other fixed capture bounds remain in `backend/jobs.ts`: 300 visible events,
12000 characters per event, and bounded diagnostic capture.

## Presets and personal folders

`deno task setup --workspace /path/to/configuration --projects /path/to/projects`
writes an ignored local override after validating the selected directories.
`deno task doctor --models` lists the signed-in CLI's local catalog; it does not
request a model response. `deno task setup --model MODEL_ID --effort EFFORT`
creates a default preset with Fast off. For multiple presets, edit the ignored
override directly. Shell aliases are not executed or parsed.

`<data>` stores job JSON/JSONL, responses, module preferences, SQLite state
and skill records. Ignored `Local/` retains operational service artifacts and logs.
Changing LOCALDESK_DATA selects another profile; it does not move or merge state.
An existing capability is preserved when moving a profile. Never start a review
copy against a personal profile or enable actual models during synthetic tests. Browser localStorage stores per-chat unsent drafts
and display preferences under LocalDesk-specific keys. The signed-in CLI also
retains its own session history. No retention deletion runs automatically.

## Connect and disconnect private integrations

The public core needs no sibling checkout, account, machine registry or personal
folder. `deno task setup` creates only empty product-owned sources. Configure
existing sources explicitly with `--workspace` and `--projects`; optional
`runtimeRegistry` observations follow the projects connection. The existing
ignored `<data>/skills.local.json` can select `skillsRoot` and `referenceRoots`;
these skill sources and all skill operations follow the workspace connection. No
external plugin code is loaded or executed by discovery.

Settings → Source connections provides two live switches:

- **Workspace sources**: catalog discovery, skill reads/edits and new workspace
  chats/jobs. Module visibility switches only hide cards and still scan; use the
  source connection switch to stop reads.
- **Projects and runtime**: project/Git/line-count/runtime discovery and new
  project chats/jobs. Runtime facts remain unknown when no registry is
  configured.

Both start connected to the explicitly configured paths (empty local folders by
portable default). Their persisted booleans live only in ignored
`<data>/integrations.json`; a malformed store fails startup rather than silently
reconnecting. `POST /api/integrations` accepts
`{id: "workspace" | "projects",
connected: boolean}` through the existing local
capability/origin boundary.

Disconnect first rejects new source operations, then waits at most 30 seconds
for already-started scans/skill operations/queue acceptance to finish. Timeout
or persistence failure leaves the prior connection unchanged and reports an
error; it never claims the source is disconnected while reads remain. Any queued
or running job blocks either disconnect: use Activity to stop queued work and
then stop running work, or let it finish. This protects existing execution
context. Stopping does not undo prior side effects. A restart marks interrupted
jobs as before; retained queued jobs still validate that their source is
connected before execution. No job is rebound to a different folder.

Successful disconnect hides the current source snapshot, stops new scans and
rejects source-bound operations, including skill edits and new jobs. It does not
remove source files, job/chat history, module preferences or project SQLite
history. Saved chats/results remain readable and are labeled as retained
history; they are not current source observations. Reconnect scans the same
configured path and exposes fresh results with the retained history.
Missing/inaccessible paths are **connected but unavailable**, with scan errors;
they do not masquerade as deliberately disconnected sources. Changing a path in
server configuration still requires a restart. These switches are source-access
controls for LocalDesk, not an operating-system sandbox or a mechanism to revoke
a third-party process.

## macOS service

`deno task service --dry-run` generates and validates machine-specific files in
ignored `Local/runtime`. `--install` additionally writes this app's own
LaunchAgent, starts it and checks its process ancestry/listeners/HTTP. Existing
loaded labels, conflicting installed plists and occupied ports are rejected. No
unrelated service is restarted. An acceptance failure stops only the label
started by that invocation and reports the failure.

Optional `--workspace-registry /path/to/PROJECT_PORTS.json` enables the local
workspace integration. It validates the existing X-LocalDesk row and uses its
wrapper and registered ports; it does not create/edit the registry. The
workspace's policy may reclaim a verified stale process belonging to this same
project on a later service restart. It never grants ownership of another
project's listener. An ignored `deploy/` plist copy supports the workspace's
source validation. The registry's runtime metadata must already point to
`X-LocalDesk/Local/runtime/process-compose.yaml` and the chosen label before
installation. Standalone users need neither that registry nor its wrapper.

The service preserves HOME/PATH and optional CODEX_HOME/LOCALDESK_CONFIG.
Process output rotates at 5 MiB with two backups and a seven-day age bound;
separate manager debug/stdout streams go to `/dev/null`. There are no HTTP probe
subprocesses. RunAtLoad/KeepAlive configuration is not evidence of a real
logout/reboot test; current acceptance scope is recorded in TASKS.md.

## Managed profile and executable updates

A managed workspace may put `<data>` outside the project but within its private
runtime area so its workspace-relative SQLite readiness record remains valid.
Use the same LOCALDESK_DATA for setup, start, doctor and service commands. The
installed LaunchAgent explicitly carries that resolved path. A bare command
without the override selects the OS default profile instead.

The service installer records the logical executable found on PATH, preserving
its stable shim/symlink across package-version replacements. It does not pin the
version-resolved Deno.execPath() in future LaunchAgents. Dry-run never installs
or starts a service; install still refuses loaded labels and conflicting plists.
An authorized update must first stop its own manager and retain the old definition.
ProjectStore keeps a latest-scan cache: each scan replaces projects/scan_runs.
It is not an append-only audit history. Durable jobs/chats/skill records are separate.
