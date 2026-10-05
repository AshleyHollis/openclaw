# Exact stable 2026.9.8 fork image inputs

This overlay is consumed by `downstream/Dockerfile.packaged-runtime`.
The corrected host package producer is `554d8353171d4db283bc3df2248ad6addf769968`, version `2026.9.8`, archive
`72900c9640bba9c0a1a48b23b3298689f04939c162d6a479f84b5b266a880488`. Command Center source is
`eafbcd250bb7ed9a4f3d79199b340d37e4afd468`, archive `de92c36a9eabe01e67892398d4a28e90272453df75462f1e24fc58661e5b0edd`.
The public npm host package of the same version is not interchangeable.
`candidate.json` sourceHead identifies the packaged runtime source; the later
assembly-metadata commit is separately identified in the integration handoff.

Actual old/new packed host manifests have identical dependency, optional/peer,
bundle, engine and lifecycle-script fields. The previously qualified npm12.0.1
runtime lock graph is retained; only its exact host archive integrity changed.
Official Codex2026.9.8/CLI0.158.0, QMD2.1.0 and the Codex-only peer lock are unchanged.
Previous clean-install receipts qualify the old archive, not this corrected pair.
Root must run the existing strict clean install and image-owned peer-link checks
against these exact archives; no permission or lifecycle allowlist was weakened.

The assembly context contains openclaw-current.tgz, codex-current.tgz,
qmd-current.tgz and command-center.tgz plus these downstream files.
Run `node downstream/scripts/validate-current-host-image-inputs.mjs CONTEXT_ROOT`
before Root's existing capped assembly owner consumes the host recipe and its
existing separate Command Center carrier recipe. These are engineering package
artifacts, not authenticated Actions artifacts. Required producer authentication,
current-head CI/review and immutable paired OCI digest receipts remain gates.

Source/package checks do not qualify installed behavior. Root must qualify
installed entrypoints, Files/Topic UI, nonempty fictional9.7→9.8 migration,
cause-specific refusal/recovery, two starts, and paired rollback to the actual
previous image/state pair with writer ownership and timer handback. Previous-pair
rollback pins/artifact custody must be supplied by Root, not inferred here.
No merge/deployment, fresh capture, activation or hold release is authorized by
this input packet alone. #340 remains disabled and separate from host gates.
