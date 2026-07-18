#!/usr/bin/env bash
set -euo pipefail

series_file="${1:-}"
if [[ -z "$series_file" || ! -f "$series_file" ]]; then
  echo "Usage: downstream/scripts/check-patch-series.sh <series.json>" >&2
  exit 2
fi

repo_root="$(git rev-parse --show-toplevel)"
series_path="$(cd "$(dirname "$series_file")" && pwd)/$(basename "$series_file")"
source_commit="$(node -e 'const f=require(process.argv[1]); process.stdout.write(f.sourceCommit)' "$series_path")"
mapfile -t patches < <(node -e 'const f=require(process.argv[1]); for (const p of f.patches) console.log(p)' "$series_path")
patch_root="$(dirname "$series_path")"
worktree="$(mktemp -d)"

cleanup() {
  git -C "$repo_root" worktree remove --force "$worktree" >/dev/null 2>&1 || true
}
trap cleanup EXIT

git -C "$repo_root" worktree add --detach "$worktree" "$source_commit" >/dev/null
for patch in "${patches[@]}"; do
  git -C "$worktree" am --3way "$patch_root/$patch" >/dev/null
done

git -C "$worktree" status --porcelain=v1 | grep -q . && {
  echo "Patch series left a dirty worktree" >&2
  exit 1
}
printf 'Applied %s patches at %s; resulting commit %s\n' "${#patches[@]}" "$source_commit" "$(git -C "$worktree" rev-parse HEAD)"
