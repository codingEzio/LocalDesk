# Skills and purpose management

Open `/?view=skills` from the Skills sidebar entry or the Agent skills card.
The page reads YAML canonical names/descriptions, source kind, UI metadata,
purpose assignments and actual targets. Search name/description and filter by
purpose. The reviewed purpose groups are seeded by config/skill_categories.json;
uncategorized is the explicit fallback. Existing folders are not reorganized.

Select a skill, edit its name/description or purpose, then Preview. Review the
complete before/after files and selected references before Apply. Names are
lowercase hyphenated canonical identifiers, at most 64 characters. Name and
folder move together; body text, UI invocation, local references and directory
aliases follow the planned rename. Linked/vendor entries cannot be renamed or
have their target metadata edited, but their purpose can be assigned locally.
Category management supports adding categories, editing each UI language label,
and removing unused categories; Uncategorized is retained. Category writes and
skill changes are read back and shared by both apps using that same source.

## Source and persistence

Portable default: resolve plugins/skills.json's path under settings.workspace.
An optional **ignored** <data>/skills.local.json may set an absolute skillsRoot
and up to 16 absolute referenceRoots. No browser request can choose arbitrary
filesystem roots. Reference roots default to the selected workspace plus skill
source. Restart/reload is not required to reread this configuration. This Mac's
local overrides select the same Setup skill directory in both applications.

`.skill-categories.json` lives in the selected skill root and is the durable,
versioned source of categories and assignments. Before it exists, the tracked
seed supplies the groups. Unknown skills are Uncategorized. The file is only
created by an explicit save, not by browsing. It contains classification data,
not skill bodies or credentials. Keep it with the skill source when backing up
or moving that collection; application Local data is not its authority.

## Preview, conflicts and recovery

The local-only /api/skills routes require the frontend's private capability;
mutations also require a valid local Origin. LAN catalog sharing never exposes
skill text or previews. Methods:

- GET /api/skills (optional ?fresh=1): current source, references scope, categories/revision, items
  and recovery state. An item revision is its current SKILL.md SHA256.
- POST /api/skills/preview: folder, name, description, category, expected item
  revision. Returns id, expiry and complete file diffs. It does not change the
  source. Selected references can be excluded; required identity/category/link
  files cannot. Generated document owners, copies and lock hashes are one coupled group.
- POST /api/skills/apply: preview id and selected file indices. Rechecks source,
  roots, reference fingerprint, file existence/hash/parents, destination and
  case-insensitive conflicts before journaling and writing.
- POST /api/skills/categories: current category revision and category definitions.
- POST /api/skills/assignment: revision, folder and category, including links.
- POST /api/skills/recover: recover an interrupted operation in its owning app.

Reference searches are literal identifier-boundary matches, not a claim of
semantic code refactoring. Bare product IDs are shown without default selection;
SKILL links, exact invocations and named skill references are selected. Historical
TASKS/CHANGELOG/PROJECT_RECORD matches are not selected by default. Archives,
other worktree containers, symlink traversal, Local/Data/credentials and generated
build/vendor trees are excluded. Files over maxFileBytes are outside the scan.
Inspect the configured scope and preview rather than assuming whole-machine
coverage. Moving source/reference files during a preview invalidates it.

Runtime policy is centralized in config/skill_management.json: maxScanFiles
30,000; maxScanBytes 128 MiB; maxFileBytes 2 MiB; maxChangedFiles 256;
maxPlanBytes 16 MiB; maxRetainedPlans 20; previewTtlMs 900,000. Invalid/missing
policy fails visibly. Limits are positive integer values; exceeding a scan or
plan limit stops before a source mutation. Narrow reference roots when needed.

The source-level exclusive lock serializes both apps. Prepared before/after
journals are private under Local/skill-management. Atomic file replacement
preserves permissions and syncs bytes; readback checks the result. A failure
rolls back only bytes/links still matching that operation. Concurrent foreign
edits stop recovery and remain untouched. Restart exposes pending recovery;
a live foreign lock is never stolen. A crash before journaling can leave a
stale lock; recovery verifies its dead owner and clears it. Up to 20 recent
preview/receipt records plus the active recovery journal are retained.

Renames across multiple files are recoverable, not a filesystem-wide atomic
transaction. External non-cooperating writers must remain idle through Apply.
No operation installs or executes a discovered skill, invokes a coding model,
creates a Git commit, pushes, or publishes the source.

Pinned path migrations that require moving a consumer dependency are rejected
and directed to the owning project's dependency sync; the manager never invents
a second generated source authority. Local reference targets changed by the
preview must resolve under the planned directory move.


## Isolated transaction regression — 2026-10-15

Run from this app's root:

```sh
SKILLS_E2E_EVIDENCE=Local/skill-management/isolated-e2e deno test -A tests/skills_e2e_test.ts
```

This starts the real backend/main.ts HTTP server from a disposable source-only
copy on temporary loopback ports, with synthetic skills, references, category
state, capability and runtime. It does not copy ignored settings, Local state,
real skills or user reference contents. No discovered skill or Codex job runs.
The test changes only the disposable skills.ts copy to inject a deterministic
failure after an alias write, pause for SIGKILL, or simulate an external edit.
No fault switch is present in production code or exposed through its API.

Covered: rename and persisted metadata/default-prompt/reference/category/alias
readback; permission preservation and unselected references; stale SKILL,
reference and alias conflicts; destination collisions; automatic rollback after
writes; preservation of foreign edits with retained recovery lock; explicit
conflict resolution and recovery; process kill, restart, pending-state readback
and rollback through the recovery API. Assertions include original directory,
bytes, links, missing original sidecar and writer-lock cleanup after rollback.

A regression found identifiers containing `skill` could themselves satisfy the
context keyword heuristic and default-select bare product IDs. Context detection
now removes the matched identifier before checking the keyword. Explicit skill
invocations and SKILL.md links retain their existing selection behavior.

This is HTTP-to-filesystem E2E evidence, not new browser interaction coverage.
Generated dependency-pin groups remain covered by the prior preview evidence;
this fixture does not claim an applied generated-document migration.


## Skills viewport contract

The Skills page fills the remaining main-column space and owns vertical
scrolling. The fixed application shell, status/footer and composer must remain
outside that scroller. Long skill lists and expanded rename diffs must keep
all preview controls reachable, including Back to editing. At narrow widths
the existing single-column layout applies without horizontal page overflow.

Live UI acceptance on 2026-10-15 compared every purpose filter and all 76 entry
names with the API, checked case-insensitive name search, description search,
empty results and combined purpose/search filters. Linked aliases retain their
entry names in the list and expose the canonical YAML name in a disabled editor.
Description and rename previews were generated and discarded without Apply or
category Save. The 1024x730 and 390x844 viewport checks expanded a diff, toggled
an optional reference and clicked Back to editing. Both apps passed after the
scroll fix. This is browser viewport evidence, not physical phone proof.
