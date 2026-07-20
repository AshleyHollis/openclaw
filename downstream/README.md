# AshleyHollis OpenClaw downstream

This directory contains the public, reproducible overlay used to build the OpenClaw image for the TerraMaster NAS. It deliberately contains no NAS credentials, deployment credentials, Discord tokens, model credentials, or private infrastructure state.

The workflow is intentionally split into three trust boundaries:

1. `validate-downstream.yml` validates release manifests and proves that each patch series applies to its frozen source commit.
2. `build-downstream-artifact.yml` verifies the exact host, patched Codex, and pinned QMD runtime tarballs; freezes their upstream registry metadata; proves Codex registration, QMD CLI availability, and a scoped loopback RPC with registry networking disabled; then builds, scans, and optionally publishes the image with an SBOM and provenance attestation. QMD is a runtime tool, not an OpenClaw plugin, and its derivative tarball adds only a validated production shrinkwrap to `@tobilu/qmd@2.1.0`.
3. Patch repair is owner-attended and uses a ChatGPT-subscription-authenticated Codex app or CLI session against the frozen candidate checkout. GitHub Actions never receives an OpenAI Platform API key. The owner supplies only a sanitized failure summary, reviews the resulting diff, and lets the normal downstream validation workflow prove the repair before promotion. Application source and tests are the only standing repair scope; dependencies, workflows, downstream automation, infrastructure, security policy, secrets, and runtime changes still require fresh review.

For a headless or remote checkout, authenticate the CLI once with `codex login --device-auth` and require `codex login status` to report `Logged in using ChatGPT`. Run Codex interactively from the exact candidate checkout, or pass a reviewed prompt on standard input with `codex exec -`. Do not use `codex login --with-api-key`; never copy Codex OAuth state into GitHub Actions or another shared runner.

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
