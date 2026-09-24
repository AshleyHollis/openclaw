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
