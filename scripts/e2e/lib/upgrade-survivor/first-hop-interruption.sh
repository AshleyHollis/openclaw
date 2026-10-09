#!/usr/bin/env bash

run_first_hop_interruption() {
  if [ "$baseline_spec" != "openclaw@2026.9.8" ] || [ "$CANDIDATE_KIND" != tarball ] ||
    [ "$UPDATE_RESTART_MODE" != manual ] || [ "$ROOT_MANAGED_VPS" != 0 ] || [ "$LIVE_ENABLED" != 0 ]; then
    echo "first-hop-interruption requires published9.8, frozen EA tar, isolated manual restart and no live provider" >&2
    return 2
  fi
  # The original baseline CLI already authored config, and the native seeder
  # below creates its history. Generic seed_state injects legacy session JSON
  # for migration scenarios; published9.8 correctly refuses that at startup.
  phase seed-first-hop-native-history seed_legacy_operator_gateway
  phase capture-first-hop-schema prepare_schema_expectation
  phase capture-first-hop-backup capture_backup_rollback
  local original_root original_entry
  original_root="$(package_root)"
  original_entry="$(openclaw_e2e_package_entrypoint "$original_root")"
  # No successful update or candidate CLI precedes this FIRST original updater.
  phase interrupt-first-original-driver env OPENCLAW_UPGRADE_SURVIVOR_RUNTIME_ROOT="$RUNTIME_ROOT" \
    node /tmp/openclaw-release-harness/scripts/e2e/lib/upgrade-survivor/first-hop-interruption.mjs \
    "$ARTIFACT_ROOT/backup-rollback.json" "$CANDIDATE_SPEC" "$original_root" "$original_entry"
  phase verify-interrupted-baseline-rollback node /tmp/openclaw-release-harness/scripts/e2e/lib/upgrade-survivor/backup-rollback.mjs \
    verify-interrupted "$ARTIFACT_ROOT/backup-rollback.json" "$ARTIFACT_ROOT/first-hop-interruption/result.json"
  # Restart retained ORIGINAL prefix with separately restored baseline data.
  # Interrupted package/state/ledger and every failure artifact remain in place.
  local retained_root retained_prefix
  retained_root="$(node -p "JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).runtime.packageRoot" "$ARTIFACT_ROOT/backup-rollback.json")"
  retained_prefix="$RUNTIME_ROOT/backup-rollback/baseline-prefix"
  test "$(realpath "$retained_prefix/lib/node_modules/openclaw")" = "$retained_root"
  export npm_config_prefix="$retained_prefix"
  export PATH="$retained_prefix/bin:$PATH"
  hash -r
  export OPENCLAW_STATE_DIR="$(node -p "JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).restoredStateDir" "$ARTIFACT_ROOT/backup-rollback.json")"
  export OPENCLAW_CONFIG_PATH="$OPENCLAW_STATE_DIR/openclaw.json"
  phase restart-restored-original9.8 start_gateway
  phase restored-original-health check_gateway_probes
  phase restored-original-rpc check_gateway_status
  phase stop-restored-original stop_gateway
  phase restored-original-history node /tmp/openclaw-release-harness/scripts/e2e/lib/upgrade-survivor/backup-rollback.mjs \
    verify-restarted "$ARTIFACT_ROOT/backup-rollback.json" "$ARTIFACT_ROOT/first-hop-interruption/result.json"
  phase assert-retained-original-identity node -e 'const fs=require("fs"),a=require("assert/strict"),p=process.argv[1];a.equal(JSON.parse(fs.readFileSync(p+"/package.json")).version,"2026.9.8");a.equal(JSON.parse(fs.readFileSync(p+"/dist/build-info.json")).commit,"fc23bc864e4553c2d215e479eeec47b67a0bf943")' "$retained_root"
}
