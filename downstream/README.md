# AshleyHollis OpenClaw downstream

This directory contains the public, reproducible overlay used to build the OpenClaw image for the TerraMaster NAS. It deliberately contains no NAS credentials, deployment credentials, Discord tokens, model credentials, or private infrastructure state.

The workflow is intentionally split into three trust boundaries:

1. `validate-downstream.yml` validates release manifests and proves that each patch series applies to its frozen source commit.
2. `build-downstream-artifact.yml` verifies the exact host and patched Codex tarballs, freezes the upstream Codex package metadata, proves paired CLI registration and a scoped loopback RPC, builds the runtime image, scans it, and optionally publishes it with an SBOM and provenance attestation.
3. `codex-repair.yml` is a manually triggered repair path. Codex receives only an OpenAI API key and a credential-free checkout. A separate job rejects changes outside application source and tests before it can create a pull request.

`releases/latest.json` is a pointer, not a deployment instruction. The private `nas-infra` repository promotes only manifests whose status is `qualified` and whose image reference contains a SHA-256 digest. A previously qualified artifact may be changed to `blocked` when a missed acceptance gate is discovered; `blockingIssues` records why it must not be selected.

## Local validation

```bash
node downstream/scripts/validate-release.mjs downstream/releases/2026.7.1-2.json
bash downstream/scripts/check-patch-series.sh downstream/patches/2026.7.1-2/series.json
```

The patch-series check uses a temporary worktree and never modifies the caller's checkout.

## Lifecycle-free correction packaging

Correction releases start from the verified official npm tarball extracted as a `package/` directory. After replacing only the qualified build output and approved package metadata, repack it without invoking npm lifecycle scripts:

```bash
bash downstream/scripts/repack-official-tarball.sh \
  /absolute/stage/package \
  /absolute/output/openclaw.tgz \
  "$SOURCE_DATE_EPOCH"
```

The repacker requires GNU tar, fixes ordering, timestamps, ownership, and portable modes, and uses timestamp-free gzip output. It rejects links, special files, hard-linked files, output inside the staged tree, and `workspace:`, `link:`, or `file:` runtime dependencies. Run it twice from the same staged tree and require identical SHA-256 values before exact-tarball install and smoke testing.
