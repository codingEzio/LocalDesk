# Dependencies and source provenance

Current source-distribution review: 2026-10-22. Historical audit results below
retain their dates. The lockfiles are the dependency resolution authority.
Original LocalDesk code/docs use MIT; included third-party materials retain
their own terms. Third-party licenses and notices retain their separate terms.

| Component                       | Purpose and source                                                    | Version or identity                                                         | Delivery and network                                                               |
| ------------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Deno                            | Backend HTTP, processes, files, SQLite through built-in `node:sqlite` | Runtime requirement documented in README                                    | Install separately; no backend production npm package                              |
| Node.js / pnpm                  | Frontend package installation and build                               | `pnpm@11.25.0` in frontend manifest; Node compatibility follows pinned Vite | Install separately; registry access on first install, cached builds can be offline |
| Svelte                          | Reactive interface; official package, MIT                             | 5.57.0                                                                      | Frontend output contains runtime code                                              |
| Vite / Svelte plugin            | Frontend compilation; official packages, MIT                          | 8.3.0 / 7.3.0                                                               | Build tools through pnpm                                                           |
| `@lucide/svelte`                | Interface icons; Lucide, ISC                                          | 1.46.0                                                                      | Used icons bundled into frontend output                                            |
| `@std/assert` / `@std/internal` | Existing isolated backend tests; JSR standard library, MIT            | 1.0.19 / 1.0.14 in `deno.lock`                                              | Development checks; first fetch requires network                                   |
| Git                             | Local repository metadata and source audit                            | Existing executable on PATH                                                 | Install separately; these reads do not need a remote                               |
| Codex CLI                       | Optional local agent execution using the user's signed-in account     | User-installed compatible version, not bundled                              | Model requests require network and an account; no credentials are bundled          |
| DeparturePixelZh Compact        | Optional pixel typography                                             | WOFF2 SHA-256 below                                                         | Bundled with complete notices; no remote font request                              |

Implementation was reused locally from Z-SetupDesk commit
`e7a370fa7eabd66b317e926bde9db88417667dc5`, with new configuration and project
identity. Its project scanner, Git, runtime and LOC modules originated in local
Z-ProjStatus commit `893fe163c5f8dc8c0a605c66f6a08e558c66441c`. The owner
selected MIT for the curated LocalDesk copy; this does not change either
original repository or imply it was published. LocalDesk must own its runtime
implementation rather than import files from a sibling private workspace.
Process Compose and macOS launchd are optional local service infrastructure, not
requirements for reading the source or building it.

## Lockfile and license review

The copied pnpm lockfile contains 65 package records including optional platform
packages. It has no explicit resolved private URL or local file/link/workspace
dependency. The source project's current macOS installation supplied 41 unique
package metadata records: 33 MIT, 2 ISC, 3 Apache-2.0, 2 MPL-2.0 and 1
BSD-3-Clause. The MPL-2.0 entries were `lightningcss` and
`lightningcss-darwin-arm64`, both 1.33.0. Those records were read locally;
packages were not uploaded.

This metadata check covers the packages installed on that Mac, not every
optional architecture. It is not a vulnerability audit or a determination of all
future distribution obligations. Keep dependency copyright/license files with
any distributed dependencies and assess the actual release artifact before
shipping. Do not describe the whole dependency tree as MIT.

## Dependency vulnerability check

The 2026-10-13 `pnpm --dir frontend audit --json` reported seven advisories in
copied build dependencies: six in devalue 5.9.2 and one in source-map-js 1.2.1.
LocalDesk's lockfile updates only those two transitive packages to devalue 5.9.4
and source-map-js 1.2.2. Their existing licenses remain MIT and BSD-3-Clause. No
new direct dependency was added. The follow-up audit reported zero known
advisories at all severity levels; this is the advisory database result at that
time, not a guarantee of vulnerability absence. The production build was rerun.

References:
[devalue advisory](https://github.com/advisories/GHSA-j22f-vq7h-c4qm) and
[source-map-js advisory](https://github.com/advisories/GHSA-68fv-2mgg-jv7q). Raw
before/after audit JSON is retained in ignored `Local/` during preparation.

## Bundled font

The 1,389,672-byte `frontend/public/fonts/DeparturePixelZhCompact-Regular.woff2`
matches the Compact entry in `frontend/public/fonts/provenance.json`:

```text
5622b5b65966cecdf29f35162fed055189ab0e369fbf925ef90b9e43c2e51cf4
```

The font combines Departure Mono, Cubic 11 and Nerd Fonts Symbols Mono sources.
Its own NOTICE, OFL text, all `licenses/` files and source provenance are
included together. Those notices also record icon-source terms including CC BY
4.0, Apache-2.0, MIT and other licenses. Preserve the complete directory when
copying or packaging the font. Reserved family names, attribution and
third-party marks remain governed by their source terms; the MIT application
license does not replace them. Emoji use platform fallback and are not bundled.

Font notices and provenance were checked for personal absolute paths; none were
found, so no attribution or provenance rewrite was needed. The source audit
script verifies the binary and recorded SHA-256. This verifies file identity,
not the correctness of every upstream license claim.

## Skill metadata YAML

`jsr:@std/yaml@1.0.12` (Deno standard library, MIT), imported by
`backend/skills.ts`, parses and serializes YAML frontmatter and UI metadata.
Source: https://jsr.io/@std/yaml/1.0.12. Deno resolves it through JSR and pins
module integrity in deno.lock. First resolution requires network; cached runtime
use does not require an external service. No package executable is installed.

## Source candidate exporter

Python 3 (standard library only, separately installed) is required for
`deno task source-check` and `deno task source-export`. It reads only explicit
source mappings and writes ignored local candidates; no packages or network are
needed. It is not an application runtime dependency.

## Current artifact and license obligations

The curated source ZIP includes original code/docs, manifests, exact lockfiles
and the bundled font/notices. It does not include Git history, node_modules, JSR
caches, a frontend build, native tool binaries or private configuration/data.
All 65 exact npm lock records are inventoried in
[DEPENDENCY-LICENSES.json](docs/DEPENDENCY-LICENSES.json), including optional
platform packages, using official registry metadata. This is a declaration
review; license texts for optional binaries not shipped here were not all
independently reviewed. The three pinned JSR modules are MIT and fetched from
JSR on demand.

Production frontend builds now use Vite's existing
[build.license](https://vite.dev/config/build-options.html#build-license) option
to produce a directly servable `THIRD-PARTY-LICENSES.md`. Keep that generated
file with built assets; it records the dependency code actually bundled and its
license text. The build also copies original app LICENSE.txt and NOTICE.txt from
the root source; keep them with distributed assets. Build-only native
lightningcss uses MPL-2.0; it transforms CSS but its executable code is not
shipped in this source ZIP or copied into application assets. Do not infer that
a package being a development dependency makes redistribution obligations
disappear: packaging its bindings/source later needs an artifact-specific
review. See
[Mozilla's distribution FAQ](https://www.mozilla.org/en-US/MPL/2.0/FAQ/).

The unchanged modified font is distributed with all 25 upstream license/credit
files, OFL.txt, NOTICE.md and provenance.json. The
[OFL redistribution guidance](https://openfontlicense.org/how-to-modify-ofl-fonts/)
requires preserving original copyright, license and reserved-name declarations;
the font uses the distinct DeparturePixelZh Compact family. The existing notice
records merge/metric/remapping changes and icon-source attribution, including CC
BY 4.0, Apache-2.0, MIT and permissive source notices. A local notice version
label was corrected to match the pinned Cubic input's recorded embedded version
1.451; font bytes and original upstream notices were not changed. No universal
legal clearance or trademark permission is claimed.

## Localized documentation diagrams / 2026-10-26

The12original `public/assets/flow-{sources,queue}-{locale}.svg` files document
read-only discovery and explicit model-work flow in6README languages. The
curated payload maps them to assets/. They are new project-owned documentation
under MIT, with the complete project grant embedded in each SVG; no third-party
logo, user data or app screenshot is included. The website copies the same bytes.
SVG text references viewer/system fonts (including locale-specific fallbacks);
no font file is embedded, copied or downloaded by the SVG. The source diagrams
were rendered locally for glyph/line-fit review. macOS preview/render proof is
not an all-platform font-availability claim. No new runtime package is required.
