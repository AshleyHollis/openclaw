# AshleyHollis OpenClaw downstream

This directory contains the public, reproducible overlay used to build the OpenClaw image for the TerraMaster NAS. It deliberately contains no NAS credentials, deployment credentials, Discord tokens, model credentials, or private infrastructure state.

The workflow is intentionally split into three trust boundaries:

1. `validate-downstream.yml` validates release manifests and proves that each patch series applies to its frozen source commit.
2. `build-downstream-candidate.yml` builds and tests a selected stable candidate, packages it with OpenClaw's maintained package tooling, smoke-tests that exact tarball, and optionally publishes an immutable GHCR image.
3. `codex-repair.yml` is a manually triggered repair path. Codex receives only an OpenAI API key and a credential-free checkout. A separate job rejects changes outside application source and tests before it can create a pull request.

`releases/latest.json` is a pointer, not a deployment instruction. The private `nas-infra` repository promotes only manifests whose status is `qualified` and whose image reference contains a SHA-256 digest.

## Local validation

```bash
node downstream/scripts/validate-release.mjs downstream/releases/2026.7.1-2.json
bash downstream/scripts/check-patch-series.sh downstream/patches/2026.7.1-2/series.json
```

The patch-series check uses a temporary worktree and never modifies the caller's checkout.
