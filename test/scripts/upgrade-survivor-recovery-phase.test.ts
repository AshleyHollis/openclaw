import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { publishDiagnostics } from "../../scripts/e2e/lib/upgrade-survivor/diagnostics.mjs";
import {
  assertRecoverySnapshot,
  recoveryTreeSnapshot,
} from "../../scripts/e2e/lib/upgrade-survivor/recovery-cleanup-fixture.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
const source = readFileSync(resolve("scripts/e2e/lib/upgrade-survivor/run.sh"), "utf8");
const lifecycle = source.slice(
  source.indexOf("on_error() {"),
  source.indexOf("companion_survivor_scenario() {"),
);
const update = source.slice(
  source.indexOf("is_extended_stable_release_version() {"),
  source.indexOf("assert_sibling_published_refusal() {"),
);
const outer = "recovery-update-restart";

it.skipIf(process.platform === "win32").each([
  { fault: "none", code: 0 },
  { fault: "stop", code: 17 },
  { fault: "still-active", code: 1 },
  { fault: "listener", code: 1 },
])("stops a Doctor-started service before recovery preparation ($fault)", ({ fault, code }) => {
  const root = dirs.make("survivor-recovery-stop-");
  const repair = source.slice(
    source.indexOf("repair_update_restart_auth() {"),
    source.indexOf("assert_managed_membership_warning() {"),
  );
  const result = spawnSync(
    "bash",
    [
      "-c",
      `set -euo pipefail
exec 3>&1
source scripts/e2e/lib/upgrade-survivor/update-restart-auth.sh
ARTIFACT_ROOT="$1"
OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_DAEMON_LOG="$1/gateway.log"
FAULT="$2"
SCENARIO=base
UPDATE_RESTART_MODE=auto-auth
OPENCLAW_FROZEN_UPGRADE_SURVIVOR_MEMBERSHIP_MODE=absent
COMMAND_TIMEOUT=30
restart_fixture_package=synthetic.tgz
restart_fixture_version=2026.9.7
update_repair_required=0
active=1
phase() { shift; "$@"; }
systemctl() {
  case "$2" in
    stop)
      printf 'stop\n' >&3
      [ "$FAULT" != stop ] || return 17
      [ "$FAULT" = still-active ] || active=0 ;;
    is-active) [ "$active" = 1 ] && return 0; return 3 ;;
    *) return 99 ;;
  esac
}
openclaw_e2e_maybe_timeout() { shift; "$@"; }
openclaw_e2e_probe_tcp() { [ "$FAULT" = listener ]; }
openclaw_e2e_print_log() { cat "$1"; }
prepare_restart_inference() { printf 'inference\n'; }
prepare_restart_fixture() { printf 'fixture\n'; }
install_update_restart_systemctl_shim() { printf 'manager\n'; }
run_update_restart_probe_gateway() {
  assert_update_restart_probe_inactive || return "$?"
  printf 'prepared\n'
}
check_gateway_status() { printf 'auth\n'; }
update_candidate() { printf 'update\n'; }
assert_managed_membership_warning() { :; }
node() { :; }
assert_survival() { :; }
${repair}
repair_update_restart_auth
`,
      "fixture",
      root,
      fault,
    ],
    { env: { PATH: process.env.PATH, HOME: root }, encoding: "utf8", timeout: 5_000 },
  );
  expect(result.status, result.stderr).toBe(code);
  expect(result.stdout.trim().split("\n")).toEqual(
    code === 0
      ? ["stop", "inference", "fixture", "manager", "prepared", "auth", "update"]
      : ["stop"],
  );
  if (code !== 0) {
    expect(result.stderr).toContain("gateway service shutdown could not be verified");
  }
});

it.skipIf(process.platform === "win32").each([
  { fault: "command", code: 17, stage: "command", checks: [] },
  { fault: "command-one", code: 1, stage: "command", checks: [] },
  { fault: "assertion", code: 1, stage: "result-assertion", checks: ["assertion"] },
  {
    fault: "replacement",
    code: 1,
    stage: "service-replacement",
    checks: ["assertion", "replacement"],
  },
  { fault: "version", code: 1, stage: "version-match", checks: ["assertion", "replacement"] },
  { fault: "success", code: 0, stage: "", checks: ["assertion", "replacement"] },
  { fault: "signal-command", code: 143, stage: "command", checks: [] },
  { fault: "signal-assertion", code: 143, stage: "result-assertion", checks: ["assertion"] },
  {
    fault: "signal-replacement",
    code: 143,
    stage: "service-replacement",
    checks: ["assertion", "replacement"],
  },
  { fault: "initial-command", code: 17, stage: "", checks: [] },
])(
  "preserves recovery outcome and capture ordering for $fault",
  ({ fault, code, stage, checks }) => {
    const root = dirs.make("survivor-recovery-phase-");
    const initial = fault === "initial-command";
    const phase = initial ? "update-candidate" : outer;
    const expectedPhase = stage ? `recovery-update-${stage}` : phase;
    const result = spawnSync(
      "bash",
      [
        "-c",
        `set -euo pipefail
exec 3>&1
ARTIFACT_ROOT="$1"
SUMMARY_JSON="$1/summary.json"
FAULT="$2"
SCENARIO=base
UPDATE_RESTART_MODE=auto-auth
ROOT_MANAGED_VPS=0
COMMAND_TIMEOUT=unchanged
candidate_version=2026.9.7
baseline_version=2026.9.6
baseline_spec=openclaw@2026.9.6
CANDIDATE_KIND=tarball
UPDATE_JSON="$1/update.json"
UPDATE_ERR="$1/update.err"
POST_UPDATE_VALIDATE_JSON="$1/validate.json"
POST_UPDATE_VALIDATE_ERR="$1/validate.err"
SYSTEMCTL_SHIM_PID_FILE="$1/pid"
SYSTEMCTL_SHIM_LOG="$1/systemctl.log"
printf '42\n' > "$SYSTEMCTL_SHIM_PID_FILE"
: > "$SYSTEMCTL_SHIM_LOG"
initial_update_observation_root=initial-observation
last_update_observation_root=""
FAILURE_PHASE=""
FAILURE_MESSAGE=""
FAILURE_SIGNAL=""
CURRENT_PHASE=""
run_completed=0
update_repair_required=0
json_event() { printf 'event\t%s\t%s\n' "$1" "$2" >&3; }
cleanup() { printf 'cleanup\n' >&3; }
write_summary() { printf 'summary\t%s\t%s\t%s\n' "$1" "$FAILURE_PHASE" "$FAILURE_SIGNAL" >&3; }
openclaw_e2e_print_log() { :; }
read_installed_version() {
  if [ "$FAULT" = version ]; then printf 'wrong'; else printf '2026.9.7'; fi
}
openclaw_e2e_maybe_timeout() {
  if [ "$2" = openclaw ]; then printf 'validate\n' >&3; return 0; fi
  printf 'command\n' >&3
  case "$FAULT" in
    command|initial-command) return 17 ;;
    command-one) return 1 ;;
    signal-command) kill -TERM $$ ;;
  esac
}
node() {
  if [ "$1" = -e ]; then printf '1000'; return 0; fi
  case "$2" in
    assert-successful-update-json)
      printf 'check\tassertion\n' >&3
      [ "$5" = "$last_update_observation_root" ] || return 92
      [ "$5" != "$initial_update_observation_root" ] || return 92
      [ "$3" = "$ARTIFACT_ROOT/recovery-update.json" ] || return 92
      if [ "$FAULT" = signal-assertion ]; then kill -TERM $$; fi
      [ "$FAULT" != assertion ] ;;
    capture)
      printf 'capture\t%s\t%s\t%s\t%s\n' "$4" "$5" "$6" "$7" >&3 ;;
    *) return 91 ;;
  esac
}
assert_update_restart_service_replaced() {
  printf 'check\treplacement\n' >&3
  [ "$1" = 42 ] && [ "$2" -eq 0 ] || return 92
  if [ "$FAULT" = signal-replacement ]; then kill -TERM $$; fi
  [ "$FAULT" != replacement ]
}
${lifecycle}
${update}
update_and_observe() {
  update_candidate "$@" || return "$?"
  printf 'restored\t%s\n' "$CURRENT_PHASE" >&3
}
phase "$3" update_and_observe "$4" file:synthetic 2026.9.7 || exit "$?"
printf 'returned\t%s\n' "$CURRENT_PHASE" >&3
run_completed=1
`,
        "fixture",
        root,
        fault,
        phase,
        initial ? "0" : "1",
      ],
      {
        env: { PATH: process.env.PATH, HOME: root },
        encoding: "utf8",
        timeout: 10_000,
      },
    );
    expect(result.status, result.stderr).toBe(code);
    const lines = result.stdout.split("\n");
    expect(lines.filter((line) => line.startsWith("check\t"))).toEqual(
      checks.map((check) => `check\t${check}`),
    );
    expect(lines.filter((line) => line.startsWith("event\t"))).toEqual([
      `event\t${phase}\tstarted`,
      ...(code === 0 ? [`event\t${phase}\tpassed`] : []),
    ]);
    expect(lines.filter((line) => line === "cleanup")).toHaveLength(1);
    if (code === 0) {
      expect(lines).toContain(`restored\t${phase}`);
      expect(lines).toContain("returned\t");
      expect(lines).toContain("summary\tpassed\t\t");
      expect(lines.some((line) => line.startsWith("capture\t"))).toBe(false);
      return;
    }
    const signal = fault.startsWith("signal-") ? "SIGTERM" : "";
    const capture = lines.find((line) => line.startsWith("capture\t"));
    expect(capture).toBeDefined();
    const fields = capture!.split("\t");
    expect(fields.slice(0, 4)).toEqual(["capture", expectedPhase, String(code), signal]);
    expect(fields[4]?.startsWith(root + "/update-observation.")).toBe(true);
    expect(lines.indexOf(capture!)).toBeLessThan(lines.indexOf("cleanup"));
    expect(lines).toContain(`summary\tfailed\t${expectedPhase}\t${signal}`);
    expect(lines.includes("validate")).toBe(
      fault === "command" || fault === "command-one" || fault === "assertion" || initial,
    );

    // Existing publisher/schema: only the phase value changes, never the wire shape.
    mkdirSync(join(root, "diagnostics"));
    const raw = { phase: expectedPhase, exitStatus: code, signal: signal || null };
    writeFileSync(join(root, "diagnostics/raw.json"), JSON.stringify(raw));
    const destination = join(root, "public");
    expect(publishDiagnostics(root, destination, (text: string) => text)).toEqual(raw);
    const published = readFileSync(join(destination, "failure.json"), "utf8");
    writeFileSync(join(root, "diagnostics/raw.json"), JSON.stringify({ ...raw, phase }));
    const control = join(root, "control");
    publishDiagnostics(root, control, (text: string) => text);
    expect(published.replace(expectedPhase, phase)).toBe(
      readFileSync(join(control, "failure.json"), "utf8"),
    );
  },
);

it.skipIf(process.platform === "win32").each([
  { timeout: undefined, phase: undefined, wall: undefined, expected: [900_000, 900_000] },
  { timeout: "1500s", phase: undefined, wall: undefined, expected: [1_500_000, 1_500_000] },
  { timeout: "25m", phase: "240000", wall: "120000", expected: [240_000, 120_000] },
  { timeout: "1500", phase: "240000", wall: undefined, expected: [240_000, 240_000] },
  { timeout: "1500s", phase: "2000000", wall: "2000000", expected: [1_500_000, 1_500_000] },
  { timeout: "invalid", phase: undefined, wall: undefined, expected: undefined },
  { timeout: "0s", phase: undefined, wall: undefined, expected: undefined },
  { timeout: "999999999999999999h", phase: undefined, wall: undefined, expected: undefined },
  { timeout: "1500s", phase: "invalid", wall: undefined, expected: undefined },
  { timeout: "1500s", phase: undefined, wall: "0", expected: undefined },
])(
  "binds actual recovery update sampling to command and explicit budgets ($timeout/$phase/$wall)",
  ({ timeout, phase, wall, expected }) => {
    const root = dirs.make("survivor-recovery-budget-");
    const commandTimeout = source.match(/^COMMAND_TIMEOUT=.*$/m)?.[0];
    expect(commandTimeout).toBeDefined();
    const result = spawnSync(
      "bash",
      [
        "-c",
        `set -euo pipefail
exec 3>&1
ARTIFACT_ROOT="$1"
SCENARIO=recovery-cleanup
UPDATE_RESTART_MODE=manual
ROOT_MANAGED_VPS=0
${commandTimeout}
candidate_version=2026.9.9
baseline_version=2026.9.8
baseline_spec=openclaw@2026.9.8
CANDIDATE_KIND=tarball
UPDATE_JSON="$1/update.json"
UPDATE_ERR="$1/update.err"
POST_UPDATE_VALIDATE_JSON="$1/validate.json"
POST_UPDATE_VALIDATE_ERR="$1/validate.err"
CURRENT_PHASE=recovery-update-restart
read_installed_version() { printf '2026.9.9'; }
openclaw_e2e_print_log() { :; }
node() {
  if [ "$1" = scripts/e2e/lib/upgrade-survivor/recovery-update-budget.mjs ]; then
    command node "$@"
  else
    return 91
  fi
}
openclaw_e2e_maybe_timeout() {
  if [ "$2" = openclaw ]; then return 0; fi
  printf 'sampler\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$1" "$2" "$3" "$4" "$5" "$6" "$OPENCLAW_PLUGIN_LIFECYCLE_MAX_RSS_KB" >&3
  printf 'cpu\t%s\n' "$OPENCLAW_PLUGIN_LIFECYCLE_MAX_CPU_CORE_RATIO" >&3
  return 17
}
${update}
update_candidate 1 file:synthetic 2026.9.9
`,
        "fixture",
        root,
      ],
      {
        env: {
          PATH: process.env.PATH,
          HOME: root,
          OPENCLAW_PLUGIN_LIFECYCLE_MAX_RSS_KB: "123456",
          OPENCLAW_PLUGIN_LIFECYCLE_MAX_CPU_CORE_RATIO: "3",
          ...(timeout === undefined ? {} : { OPENCLAW_UPGRADE_SURVIVOR_COMMAND_TIMEOUT: timeout }),
          ...(phase === undefined ? {} : { OPENCLAW_PLUGIN_LIFECYCLE_PHASE_TIMEOUT_MS: phase }),
          ...(wall === undefined ? {} : { OPENCLAW_PLUGIN_LIFECYCLE_MAX_WALL_MS: wall }),
        },
        encoding: "utf8",
        timeout: 5_000,
      },
    );
    expect(result.status, result.stderr).toBe(expected ? 17 : 2);
    const sampler = result.stdout.split("\n").filter((line) => line.startsWith("sampler\t"));
    expect(sampler).toEqual(
      expected
        ? [
            `sampler\t${timeout ?? "900s"}\tenv\tOPENCLAW_PLUGIN_LIFECYCLE_PHASE_TIMEOUT_MS=${expected[0]}\tOPENCLAW_PLUGIN_LIFECYCLE_MAX_WALL_MS=${expected[1]}\tnode\tscripts/e2e/lib/plugin-lifecycle-matrix/measure.mjs\t123456`,
          ]
        : [],
    );
    if (expected) {
      expect(result.stdout).toContain("cpu\t3");
    } else {
      expect(result.stderr).toMatch(/timeout|positive integer/);
    }
  },
);

const compileCacheSetup = source.slice(
  source.indexOf("configure_recovery_compile_cache() {"),
  source.indexOf("configure_recovery_compile_cache\n\nexport PATH"),
);
function cacheFixture() {
  const root = dirs.make("survivor-recovery-cache-");
  const runtime = join(root, "runtime");
  const env = {
    PATH: process.env.PATH,
    HOME: join(root, "home"),
    TMPDIR: join(runtime, "tmp"),
    npm_config_cache: join(runtime, "npm-cache"),
    OPENCLAW_STATE_DIR: join(root, "state"),
    OPENCLAW_CONFIG_PATH: join(root, "config.json"),
  };
  for (const directory of [
    runtime,
    env.HOME,
    env.TMPDIR,
    env.npm_config_cache,
    env.OPENCLAW_STATE_DIR,
  ])
    mkdirSync(directory, { recursive: true });
  return { root, runtime, env };
}
function configureCache(
  fixture: ReturnType<typeof cacheFixture>,
  {
    scenario = "recovery-cleanup",
    stateHome = join(fixture.runtime, "state-home"),
    env = fixture.env,
  } = {},
) {
  return spawnSync(
    "bash",
    [
      "-c",
      `set -euo pipefail; RUNTIME_ROOT="$1"; STATE_HOME_ROOT="$2"; SCENARIO="$3"; ${compileCacheSetup}
configure_recovery_compile_cache
node -e 'console.log(JSON.stringify({cache:process.env.NODE_COMPILE_CACHE,disabled:process.env.NODE_DISABLE_COMPILE_CACHE}))'`,
      "fixture",
      fixture.runtime,
      stateHome,
      scenario,
    ],
    { env, encoding: "utf8", timeout: 5000 },
  );
}

it.skipIf(process.platform === "win32")(
  "sets the same enabled native cache for every recovery command and leaves other lanes unchanged",
  () => {
    const fixture = cacheFixture();
    const result = configureCache(fixture);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      cache: join(fixture.runtime, "native-compile-cache"),
    });
    const other = configureCache(fixture, { scenario: "base" });
    expect(other.status, other.stderr).toBe(0);
    expect(JSON.parse(other.stdout)).toEqual({});
    const inherited = { ...fixture.env, NODE_COMPILE_CACHE: join(fixture.root, "existing-cache") };
    const preserved = configureCache(fixture, { scenario: "base", env: inherited });
    expect(preserved.status, preserved.stderr).toBe(0);
    expect(JSON.parse(preserved.stdout)).toEqual({ cache: inherited.NODE_COMPILE_CACHE });
    const repeated = configureCache(fixture);
    expect(repeated.status, repeated.stderr).toBe(0);
    expect(JSON.parse(repeated.stdout)).toEqual(JSON.parse(result.stdout));
    expect(source.indexOf("configure_recovery_compile_cache\n\nexport PATH")).toBeLessThan(
      source.indexOf("initialize_state() {"),
    );
    expect(
      source.slice(source.indexOf("initialize_state() {"), source.indexOf("seed_state() {")),
    ).toContain("configure_recovery_compile_cache");
  },
);

it
  .skipIf(process.platform === "win32")
  .each([
    "HOME",
    "TMPDIR",
    "npm_config_cache",
    "OPENCLAW_STATE_DIR",
    "OPENCLAW_CONFIG_PATH",
    "state-home",
    "alias",
    "escape",
    "dangling",
  ])("rejects native cache/protected-root collision before execution (%s)", (fault) => {
  const fixture = cacheFixture();
  const cache = join(fixture.runtime, "native-compile-cache");
  let stateHome = join(fixture.runtime, "state-home");
  const env = { ...fixture.env };
  if (fault === "state-home") stateHome = fixture.runtime;
  else if (fault === "alias") {
    const alias = join(fixture.root, "alias");
    symlinkSync(fixture.runtime, alias);
    env.HOME = alias;
  } else if (fault === "escape" || fault === "dangling") {
    symlinkSync(join(fixture.root, fault === "escape" ? "home" : "missing"), cache);
  } else
    env[fault as keyof typeof env] =
      fault === "OPENCLAW_CONFIG_PATH" ? join(cache, "config.json") : fixture.runtime;
  const result = configureCache(fixture, { env, stateHome });
  expect(result.status).not.toBe(0);
  expect(result.stdout).toBe("");
});

it.skipIf(process.platform === "win32")(
  "actual packaged bootstrap keeps native cache enabled outside unchanged protected recovery snapshots",
  () => {
    const fixture = cacheFixture();
    const installation = join(fixture.root, "installed");
    mkdirSync(join(installation, "dist"), { recursive: true });
    for (const file of [
      "openclaw.mjs",
      "node-compile-cache.mjs",
      "node-host-launcher.mjs",
      "node-runtime-recovery.mjs",
      "node-version.mjs",
      "node-sqlite.mjs",
      "cli-root-options.mjs",
      "gateway-run-argv.mjs",
      "gateway-shutdown-budget.mjs",
    ])
      cpSync(resolve(file), join(installation, file));
    writeFileSync(
      join(installation, "package.json"),
      JSON.stringify({ type: "module", version: "2026.9.9" }),
    );
    writeFileSync(
      join(installation, "dist/build-info.json"),
      JSON.stringify({ buildId: "isolated-cache-fixture" }),
    );
    const setup = configureCache(fixture);
    expect(setup.status, setup.stderr).toBe(0);
    const cache = JSON.parse(setup.stdout).cache as string;
    const roots = [
      fixture.env.HOME,
      fixture.env.OPENCLAW_STATE_DIR,
      fixture.env.OPENCLAW_CONFIG_PATH,
      fixture.env.TMPDIR,
      fixture.env.npm_config_cache,
    ];
    const run = (suffix: string, isolated: boolean) => {
      writeFileSync(
        join(installation, `dist/payload-${suffix}.js`),
        `export const value = ${JSON.stringify(suffix)};`,
      );
      writeFileSync(
        join(installation, "dist/entry.js"),
        `import module from 'node:module'; import {value} from './payload-${suffix}.js'; console.log(JSON.stringify({value,cache:module.getCompileCacheDir(),disabled:process.env.NODE_DISABLE_COMPILE_CACHE}));`,
      );
      const result = spawnSync(
        process.execPath,
        [join(installation, "openclaw.mjs"), "cache-fixture"],
        {
          env: { ...fixture.env, ...(isolated ? { NODE_COMPILE_CACHE: cache } : {}) },
          encoding: "utf8",
          timeout: 10000,
        },
      );
      expect(result.status, result.stderr).toBe(0);
      return JSON.parse(result.stdout);
    };
    run("default-seed", false);
    const beforeDefault = recoveryTreeSnapshot(roots);
    run("default-after", false);
    expect(() => assertRecoverySnapshot(beforeDefault, recoveryTreeSnapshot(roots))).toThrow(
      "node-compile-cache",
    );
    const seed = run("isolated-seed", true);
    expect(seed.cache.startsWith(cache + "/")).toBe(true);
    expect(seed.cache).toContain("/openclaw/2026.9.9/");
    expect(seed.disabled).toBeUndefined();
    const before = recoveryTreeSnapshot(roots);
    const after = run("isolated-after", true);
    expect(after.cache).toBe(seed.cache);
    expect(after.value).toBe("isolated-after");
    assertRecoverySnapshot(before, recoveryTreeSnapshot(roots));
    expect(
      readdirSync(cache, { recursive: true }).some((entry) => String(entry).includes("openclaw")),
    ).toBe(true);
  },
);

it.skipIf(process.platform === "win32")(
  "validates without acquiring an inherited caller compile cache",
  () => {
    const fixture = cacheFixture();
    const inheritedCache = join(fixture.root, "caller-cache");
    const env = { ...fixture.env, HOME: fixture.runtime, NODE_COMPILE_CACHE: inheritedCache };
    const rejected = configureCache(fixture, { env });
    expect(rejected.status).not.toBe(0);
    expect(existsSync(inheritedCache)).toBe(false);
    mkdirSync(inheritedCache);
    writeFileSync(join(inheritedCache, "sentinel"), "retained caller bytecode");
    const before = recoveryTreeSnapshot([inheritedCache]);
    configureCache(fixture, { env });
    assertRecoverySnapshot(before, recoveryTreeSnapshot([inheritedCache]));
  },
);
