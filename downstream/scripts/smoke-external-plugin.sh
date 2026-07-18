#!/usr/bin/env bash
set -euo pipefail

artifact="${1:-}"
plugin_artifact="${2:-}"
plugin_id="${3:-}"
expected_version="${4:-}"
if [[ -z "$artifact" || -z "$plugin_artifact" || -z "$plugin_id" || -z "$expected_version" ]]; then
  echo "Usage: smoke-external-plugin.sh <openclaw.tgz> <plugin.tgz> <plugin-id> <openclaw-version>" >&2
  exit 2
fi

root="$(mktemp -d)"
gateway_pid=""
cleanup() {
  if [[ -n "$gateway_pid" ]] && kill -0 "$gateway_pid" 2>/dev/null; then
    kill "$gateway_pid" 2>/dev/null || true
    wait "$gateway_pid" 2>/dev/null || true
  fi
  rm -rf -- "$root"
}
trap cleanup EXIT

prefix="$root/prefix"
export HOME="$root/home"
export OPENCLAW_STATE_DIR="$root/state"
export OPENCLAW_CONFIG_PATH="$OPENCLAW_STATE_DIR/openclaw.json"
export OPENCLAW_SKIP_CHANNELS=1
export OPENCLAW_SKIP_CRON=1
mkdir -p "$HOME" "$OPENCLAW_STATE_DIR"

npm install --prefix "$prefix" --ignore-scripts=false "$artifact"
cli="$prefix/node_modules/.bin/openclaw"
"$cli" --version | grep -F "$expected_version"

port="$(node -e 'const s=require("node:net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close();});')"
token="$(node -e 'console.log(require("node:crypto").randomBytes(32).toString("hex"))')"
PORT="$port" TOKEN="$token" node <<'NODE'
const fs = require("node:fs");
const config = {
  gateway: {
    mode: "local",
    bind: "loopback",
    port: Number(process.env.PORT),
    auth: { mode: "token", token: process.env.TOKEN },
  },
};
fs.writeFileSync(process.env.OPENCLAW_CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, {
  mode: 0o600,
});
NODE

"$cli" plugins install "$plugin_artifact" --pin
"$cli" plugins enable "$plugin_id"

# `export` reaches CLI-metadata registration before this stable CLI rejects the
# unavailable command. This catches plugins that access proxied-only runtime
# services during base registration.
set +e
"$cli" export >"$root/cli-metadata.log" 2>&1
set -e
plugin_error_pattern="(\\[plugins\\].*(failed|error)|${plugin_id}.*(failed|error)|TypeError:.*openSyncKeyedStore)"
if grep -Eqi "$plugin_error_pattern" "$root/cli-metadata.log"; then
  sed -E 's/[0-9a-f]{64}/<redacted-token>/g' "$root/cli-metadata.log" >&2
  echo "External plugin failed CLI-metadata registration" >&2
  exit 1
fi

"$cli" gateway run --bind loopback --port "$port" --token "$token" >"$root/gateway.log" 2>&1 &
gateway_pid=$!

rpc_ok=false
for _ in $(seq 1 40); do
  if "$cli" cron status --json --url "ws://127.0.0.1:$port" --token "$token" >"$root/rpc.json" 2>"$root/rpc.log"; then
    rpc_ok=true
    break
  fi
  if ! kill -0 "$gateway_pid" 2>/dev/null; then
    break
  fi
  sleep 0.5
done
if [[ "$rpc_ok" != true ]]; then
  sed -E 's/[0-9a-f]{64}/<redacted-token>/g' "$root/gateway.log" >&2
  sed -E 's/[0-9a-f]{64}/<redacted-token>/g' "$root/rpc.log" >&2
  echo "Scoped loopback RPC smoke failed" >&2
  exit 1
fi
if grep -Eqi "$plugin_error_pattern" "$root/gateway.log"; then
  sed -E 's/[0-9a-f]{64}/<redacted-token>/g' "$root/gateway.log" >&2
  echo "External plugin failed gateway registration" >&2
  exit 1
fi

echo "External plugin registration and scoped loopback RPC passed"
