#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 3 ]]; then
  echo "usage: repack-official-tarball.sh PACKAGE_ROOT OUTPUT_TGZ SOURCE_DATE_EPOCH" >&2
  exit 2
fi

package_root="$(realpath -- "$1")"
output="$(realpath -m -- "$2")"
source_date_epoch="$3"

if [[ "$(basename -- "$package_root")" != package || ! -f "$package_root/package.json" ]]; then
  echo "PACKAGE_ROOT must be an extracted npm package/ directory" >&2
  exit 1
fi
if [[ ! "$source_date_epoch" =~ ^[0-9]+$ ]]; then
  echo "SOURCE_DATE_EPOCH must be a non-negative integer" >&2
  exit 1
fi
case "$output" in
  "$package_root" | "$package_root"/*)
    echo "OUTPUT_TGZ must be outside PACKAGE_ROOT" >&2
    exit 1
    ;;
esac
if ! tar --version | head -n 1 | grep -Fq "GNU tar"; then
  echo "deterministic repacking requires GNU tar" >&2
  exit 1
fi

unsafe_entry="$(find "$package_root" -xdev \( -type l -o \( ! -type d ! -type f \) \) -print -quit)"
if [[ -n "$unsafe_entry" ]]; then
  echo "package tree contains an unsupported filesystem entry: $unsafe_entry" >&2
  exit 1
fi
linked_file="$(find "$package_root" -xdev -type f -links +1 -print -quit)"
if [[ -n "$linked_file" ]]; then
  echo "package tree contains a hard-linked file: $linked_file" >&2
  exit 1
fi

node - "$package_root/package.json" <<'NODE'
const manifest = require(process.argv[2]);
for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
  for (const [name, value] of Object.entries(manifest[field] ?? {})) {
    if (/^(?:workspace|link|file):/u.test(value)) {
      throw new Error(`${field}.${name} uses forbidden local dependency ${value}`);
    }
  }
}
NODE

mkdir -p -- "$(dirname -- "$output")"
temporary="$(mktemp "${output}.tmp.XXXXXX")"
trap 'rm -f -- "$temporary"' EXIT

export LC_ALL=C
tar \
  --create \
  --sort=name \
  --mtime="@$source_date_epoch" \
  --owner=0 \
  --group=0 \
  --numeric-owner \
  --mode='u+rwX,go+rX,go-w' \
  --format=posix \
  --pax-option=delete=atime,delete=ctime \
  --directory="$(dirname -- "$package_root")" \
  "$(basename -- "$package_root")" \
  | gzip -n -9 > "$temporary"

mv -f -- "$temporary" "$output"
trap - EXIT
sha256sum "$output"
