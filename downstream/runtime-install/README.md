# Active stable 2026.9.8 inputs

The active packaged runtime recipe uses [current-host](current-host/README.md).
The files alongside this README and the description below are preserved historical
inputs; do not use their older host archive integrity with the new package.

# Retained packaged-runtime candidate

This profile consumes the existing successful package run recorded in `candidate.json`.
It does not rebuild OpenClaw source or enter the historical July release recipe.
The existing artifact workflow's `runtime-image` selection verifies the workflow/artifact provenance, envelope digest,
host source receipt and every component archive before building. Publication is limited
to a run-specific candidate tag after network-isolated authentication/runtime smoke and
the existing critical-vulnerability gate; it does not deploy or move production aliases.

`Dockerfile.packaged-runtime` separates the installed host from managed external plugins
and QMD. Host and plugin installations use checked-in npm 12 lockfiles; QMD uses its
existing archive-owned shrinkwrap. All use strict, explicit lifecycle policies.
Codex and Discord use their official September archives (no package shrinkwrap);
QMD retains its existing patched archive and package shrinkwrap. Host peers
are links to the one installed host, normalized to absolute image-owned targets so
hydration preserves them. The host is initialized once, not again through plugin links.

To regenerate a lock after an explicitly selected artifact change, use the pinned image
Node/npm toolchain, the same absolute archive paths, matching `*.package.json` as
`package.json`, and the same prefix/install strategy as the recipe. Generate the host
lock using its actual installation. For the managed plugins, run an initial isolated
`npm install --install-strategy=nested --omit=dev --ignore-scripts`, followed by
`npm install --install-strategy=nested --package-lock-only --omit=dev --ignore-scripts`.
The second pass incorporates official bundled-tree metadata; a package-lock-only first
pass alone is insufficient for these archives. Do not duplicate QMD's source-owned
shrinkwrap as another checked-in root lock. Review changed package identities/lifecycle declarations,
then prove a clean `npm ci` with `--strict-allow-scripts`; never repair locks during CI.

The image-owned installation validator checks both plugins against the managed root
lock before hydration rewrites temporary archive specs. NAS retains its historical
shrinkwrap branch for rollback images, but modern images use this validator. A matching
Command Center artifact, real-data rehearsal, final acceptance, independent evaluation
and normal backup/rollback admission remain separate requirements.

## Frozen 2026.9.9 Code selection (recipe-only successor)

`runtime-image` accepts `runtime_profile=code`; `paired-life` is still the
unchanged default. Code consumes the **existing** EA product/package, not a
package built from the tooling PR. It selects `current-code/candidate.json`,
`current-code/{host,plugins}.package.json` and freshly generated matching locks.
Those files are deliberately not synthesized from the historical 9.8 locks.
Until the owner supplies and seals actual inputs, Code assembly refuses; it does
not fall back to `current-host` or silently build the tooling source as product.

The closed Code selection requires:

- Role `code`, platform `linux/amd64`, OpenClaw/Codex companion version `2026.9.9`.
- Product EA `ea4135dbeced9c393ab4f6ebde8bf3e751ea5fa2`, original package producer
  `37873292633` / artifact `11591748081`, its successful workflow/artifact metadata,
  original package-candidate receipt and archive SHA `acf8cd1c…`.
- Complete retained prepublish registry directory, raw manifest SHA `f156c4bc…`,
  authenticated artifact metadata, manifest source identity, and the
  manifest-declared Codex tarball SHA `4dbfc268…`. The existing registry validator
  verifies **every** entry and rejects extra files before selecting Codex.
- Codex engine `0.160.0`, `0.160.0-linux-x64` platform package, actual raw platform
  package manifest and executable SHA-256, and its exact package-relative binary
  path. These identities come from the actual selected platform bytes, not old
  `.158` metadata or a model catalogue.
- SHA-256 of both locks regenerated with the pinned Node image/npm 12.0.1 and
  existing two-pass procedure above. Review lifecycle declarations against the
  actual archives; run the clean strict `npm ci` proof. Do not hand-edit a lock.

No CC archive/receipt or QMD is selected by Code. The paired profile retains both
its CC input validation and QMD runtime. Code's image-owned validator rechecks
host/source, both lock bytes, engine and platform manifest/executable bytes. Its
isolated smoke additionally loads the frozen host's OpenAI and Workboard plugins;
this is **not** a credentialed provider turn. Both targets retain filesystem,
Chromium, Python, npm/tar, Codex registration, loopback RPC, vulnerability scan,
SBOM/provenance and tested-image readback gates.

After the exact `current-code` inputs are independently reviewed and committed,
Root's existing dispatcher can select this **tooling** ref with
`artifact_kind=runtime-image`, `runtime_profile=code`, `publish=false`. Product
source remains EA. Image publication requires a separate exact tested-image
Root disposition. No workflow invocation deploys Code or Life.

Code activation additionally requires owner-controlled copied-state canonical
compatibility and installed-9.8 first-hop interruption/failure/rollback proof,
plus real configured-provider Codex initialize/turn/stream/terminal/cancel/exit
proof in the existing isolated credential owner. Do not run Doctor/lint against
live Code, hydrate CI with production credentials, mark ownership to force
readiness, or reuse Life's release approval. Life/CC is a separate later target.
