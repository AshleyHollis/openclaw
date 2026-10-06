# Exact stable 2026.9.8 fork image inputs

This overlay, not the historical files in its parent directory, is consumed by
`downstream/Dockerfile.packaged-runtime`. It pins the supplied host package at
version `2026.9.8`, produced from source `26a9c0faa4124e53ae2eab34291d68a7245f630c`.
The archive is 117,898,761 bytes with SHA-256
`e6203c9ba1d01d928f51cb71d7b4ecc77515fa6742f8168d9b5d8175610d6b36`. The public
npm package of the same version is not interchangeable. The matching Command
Center is source `2253d49b5b90c8c1c8c506a0a38efe300c389da4`, archive SHA-256
`edebaa262afcc804da7b6fbf8f364a9564b61579d83761e0dc3196bc20991822`, build
digest `c5e1336205263985c52f6275c81ae94a6e5684a619615fa7589c9bc634998af8`, and
receipt SHA-256 `6b4d8f2b4e2126f581ac40a8e446c6a819ab6112728ad1f16d1c190bdbf06fca`.

`candidate.json` binds exact host, Command Center, official Codex and retained QMD
archives. The checked-in host lock is the reviewed lock for this exact archive;
its SHA-256 is
`d9989035c508b703229a9e06463256d8b1302fdf616b97831b8283dc47962e2f`. The host
and Codex-only npm 12.0.1 locks retain explicit lifecycle policies. Unused
Discord is absent from this active recipe and manifest. Historical parent
locks/pins are retained, not silently rewritten to consume a different archive.
QMD's unchanged archive owns its shrinkwrap; no new QMD root lock was added.

The external assembly context contains `openclaw-current.tgz`, `codex-current.tgz`,
`qmd-current.tgz`, and `command-center.tgz` plus the reviewed downstream files.
Run `node downstream/scripts/validate-current-host-image-inputs.mjs CONTEXT_ROOT`
before Root's existing capped buildx owner uses the recipe. Command Center is
an independently checked carrier archive, not installed into the host image by
this Dockerfile. Root must retain its existing separate carrier assembly recipe
and exact archive/receipt checks; this overlay does not invent another carrier.

Source/clean-install checks are not an image build, isolated runtime rehearsal
or installed proof. External image assembly must retain immutable image digest,
producer/source and archive receipts, caps and existing native image smoke.
Fictional rehearsal must exercise the resulting host plus exact CC carrier,
nonempty 9.7 state, two 9.8 starts, saved record/UUID preservation, dependency
refusal, locks, failure recovery and installed health/timer handback separately.
No production deployment or alias movement is authorized by this packet.
