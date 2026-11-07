# LocalDesk notices and source attribution

LocalDesk original code and documentation: Copyright (c) 2026 LocalDesk
contributors, MIT License; see LICENSE. No third-party license is replaced.

## Selected implementation provenance

Selected owner-authored implementation came from SetupDesk at
`e7a370fa7eabd66b317e926bde9db88417667dc5`. Its project scanner, Git, runtime
and line-count modules originated in ProjStatus at
`893fe163c5f8dc8c0a605c66f6a08e558c66441c`. LocalDesk then added its own
portable configuration, identity, local data ownership, durable execution and
source connection boundaries. The owner's MIT selection covers the selected
LocalDesk copy and subsequent LocalDesk changes. It does not relicense or
publish those original repositories; they are not runtime dependencies.

## Materials included in the source archive

The optional DeparturePixelZh Compact font is a modified font, not MIT code. Its
WOFF2 and the complete `frontend/public/fonts/` directory are distributed
together. Preserve its OFL text, NOTICE.md, provenance.json and every licenses/
file. These retain source copyright, reserved names, icon attribution and
modification descriptions. No platform emoji font is included. Third-party marks
do not imply endorsement or grant trademark rights.

## Materials fetched or produced later

The source archive includes manifests and lockfiles, not npm/JSR package source,
platform bindings, Deno, Node.js, pnpm, Git, Process Compose or Codex CLI
binaries. [Dependency declarations](docs/DEPENDENCY-LICENSES.json) identify
exact locked packages and public metadata sources. They are an inventory, not
replacement license text. Those fetched packages retain their own included
notices.

Vite generates `frontend/dist/THIRD-PARTY-LICENSES.md` from dependency code
actually included in a production build. Builds also copy the original MIT
LICENSE.txt and NOTICE.txt. Ship those files and the generated dependency notice
with built assets, and ship the complete built `fonts/` directory. Bundling a
build tool or its native bindings would require a separate artifact review; the
source-only ZIP does not do so.
