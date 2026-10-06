# Exact stable 2026.9.8 fork image inputs

This overlay, not the historical files in its parent directory, is consumed by
`downstream/Dockerfile.packaged-runtime`. It pins the supplied host package at
version `2026.9.8`, produced from source `26a9c0faa4124e53ae2eab34291d68a7245f630c`.
The archive is 117,898,761 bytes with SHA-256
`e6203c9ba1d01d928f51cb71d7b4ecc77515fa6742f8168d9b5d8175610d6b36`. The public
npm package of the same version is not interchangeable. The matching Command
Center is source `94f1e178a1117abaf9f99b358310f986b99acb46`, archive SHA-256
`89e172a6eb91b1aba98ac419bffde802bad41cd51ba3fd91acb6aebace903117`, build
digest `52324b66d04861332be6cc1ae502055ea2bac558db179ca779bf35d8e5e10eb2`, and
receipt SHA-256 `9ce8b80d993107b0cdf6b6c248899e857f82ddf98932937f555e7f51adbf516b`.

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
