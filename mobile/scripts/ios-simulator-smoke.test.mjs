import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const smoke = fileURLToPath(new URL("./ios-simulator-smoke.sh", import.meta.url));
const goodProbe = {
  href: "capacitor://localhost/", platform: "ios", mounted: true,
  voiceNotesHeader: true, voiceNotesAvailable: true,
  voiceNotesStatus: { state: "idle", maxDurationMs: 10800000 },
  voiceNotesReadChunk: { code: "not_found" },
  voiceNotesInputs: { listed: true, reset: true, count: 0 },
  serviceWorkerDecision: "skip:capacitor", serviceWorkerRegistrations: 0,
  locationAvailable: true,
  locationStatus: { platform: "ios", declared: { foreground: true, background: true, backgroundExecution: true } },
};
const earlyProbe = { href: "about:blank", platform: "ios", mounted: false };

// The test drives the actual smoke script, with only simulator and plutil binaries replaced.
const fakeXcrun = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const state = process.env.FAKE_SIM_STATE;
const args = process.argv.slice(2);
const events = path.join(state, 'events');
const event = (kind) => fs.appendFileSync(events, kind + '\\n');
if (args[0] !== 'simctl') process.exit(2);
const op = args[1];
if (op === 'launch') {
  event('launch');
  fs.writeFileSync(path.join(state, 'pid'), String(process.pid));
  if (process.env.FAKE_SIMCTL_PID !== 'absent') {
    const delay = Number(process.env.FAKE_SIMCTL_PID_DELAY_MS || 0);
    const reported = process.pid + (process.env.FAKE_SIMCTL_DIFFERENT_PID === '1' ? 1 : 0);
    if (delay) setTimeout(() => console.log('xyz.tinycloud.exo: ' + reported), delay);
    else console.log('xyz.tinycloud.exo: ' + reported);
  }
  const mode = process.env.FAKE_PROBE_MODE;
  if (mode === 'early-then-mounted') console.log('EXO_SMOKE ' + process.env.FAKE_EARLY_PROBE);
  if (mode === 'mounted') console.log('EXO_SMOKE ' + process.env.FAKE_GOOD_PROBE);
  if (mode === 'early-then-mounted' || mode === 'late-mounted') setTimeout(() => { console.log('EXO_WEB_APP_READY'); console.log('EXO_SMOKE ' + process.env.FAKE_GOOD_PROBE); }, 2600);
  console.log('SENSITIVE_FAKE_USER_CONTENT');
  if (process.env.FAKE_BAD_PREFIX === '1') console.log('FAKE-PRIVATE-ABCD EXO_WEB_APP_READY');
  if (process.env.FAKE_CRASH === '1') {
    const reports = path.join(process.env.HOME, 'Library/Logs/DiagnosticReports');
    fs.mkdirSync(reports, { recursive: true });
    fs.writeFileSync(path.join(reports, 'App-synthetic.ips'), 'SYNTHETIC_CRASH_PRIVATE');
  }
  if (process.env.FAKE_EXIT_AFTER_MS) setTimeout(() => {
    fs.writeFileSync(path.join(state, 'exited'), '1');
    process.exit(0);
  }, Number(process.env.FAKE_EXIT_AFTER_MS));
  if (process.env.FAKE_IDENTITY_CHANGE_AFTER_MS) setTimeout(() => {
    fs.writeFileSync(path.join(state, 'identity-changed'), '1');
  }, Number(process.env.FAKE_IDENTITY_CHANGE_AFTER_MS));
  setInterval(() => {}, 1000);
} else if (op === 'spawn' && args[3] === 'launchctl') {
  const stallFile = path.join(state, 'launchctl-stalled');
  if (process.env.FAKE_LAUNCHCTL_STALL_MS && !fs.existsSync(stallFile)) {
    fs.writeFileSync(stallFile, '1');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.FAKE_LAUNCHCTL_STALL_MS));
  }
  const pidFile = path.join(state, 'pid');
  if (fs.existsSync(pidFile) && (!fs.existsSync(path.join(state, 'exited')) ||
      process.env.FAKE_PRESERVE_LAUNCHCTL_PID === '1') && process.env.FAKE_HIDE_LAUNCHCTL !== '1') {
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    if (process.env.FAKE_PRESERVE_LAUNCHCTL_PID === '1') console.log(pid + ' 0 UIKitApplication:xyz.tinycloud.exo[0]');
    else try { process.kill(pid, 0); console.log(pid + ' 0 UIKitApplication:xyz.tinycloud.exo[0]'); } catch {}
  }
} else if (op === 'spawn' && args[3] === 'log' && args[4] === 'stream') {
  event('stream-start');
  console.log('2026-10-15 15:00:00 App EXO_WEB_APP_READY');
  console.log(JSON.stringify({timestamp:'2026-10-15 15:00:01',process:'App',subsystem:'xyz.tinycloud.exo',category:'other',eventMessage:'SENSITIVE_FAKE_USER_CONTENT'}));
  setInterval(() => {}, 1000);
} else if (op === 'spawn' && args[3] === 'log' && args[4] === 'show') {
  console.log('2026-10-15 App SENSITIVE_FAKE_USER_CONTENT');
  if (process.env.FAKE_FALLBACK_MOUNTED === '1' && args.includes('--start')) console.log('EXO_SMOKE ' + process.env.FAKE_GOOD_PROBE);
} else if (op === 'io' && args[3] === 'screenshot') {
  fs.writeFileSync(args[4], 'fake screenshot');
} else if (op === 'terminate') {
  const pidFile = path.join(state, 'pid');
  if (fs.existsSync(pidFile)) {
    try { process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 'SIGTERM'); } catch {}
  }
}
`;

// macOS sysctl -b kern.proc.pid.<pid> returns binary kinfo_proc, starting with timeval.
// Synthetic bytes exercise the kernel µs path without reading a host process.
const fakeSysctl = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const state = process.env.FAKE_SIM_STATE;
if (process.argv[2] !== '-b' || !/^kern\\.proc\\.pid\\.[0-9]+$/.test(process.argv[3] || '')) process.exit(2);
if (process.env.FAKE_KERNEL_START !== 'valid' && process.env.FAKE_KERNEL_START !== 'invalid-usec') process.exit(1);
const countFile = path.join(state, 'kernel-count');
const count = (fs.existsSync(countFile) ? Number(fs.readFileSync(countFile, 'utf8')) : 0) + 1;
fs.writeFileSync(countFile, String(count));
if (process.env.FAKE_KERNEL_AVAILABLE_CALL && count < Number(process.env.FAKE_KERNEL_AVAILABLE_CALL)) process.exit(1);
if (process.env.FAKE_KERNEL_MISSING_CALL && count >= Number(process.env.FAKE_KERNEL_MISSING_CALL)) process.exit(1);
const changed = fs.existsSync(path.join(state, 'identity-changed')) ||
  (Number(process.env.FAKE_KERNEL_CHANGED_CALL || 0) > 0 && count >= Number(process.env.FAKE_KERNEL_CHANGED_CALL));
const record = Buffer.alloc(64);
record.writeBigInt64LE(BigInt(changed ? 1760567306 : 1760567305), 0);
record.writeBigInt64LE(BigInt(process.env.FAKE_KERNEL_START === 'invalid-usec' ? 1000000 : 123456), 8);
process.stdout.write(record);
`;

function runSmoke({
  mode, exitAfterMs, hideLaunchctl = false, badPrefix = false, crash = false,
  simctlPid = "immediate", pidDelayMs = 0, simctlDifferentPid = false,
  launchctlStallMs = 0, fallbackMounted = false,
  simctlRenameStallSeconds = 0, launchctlRenameStallSeconds = 0,
  heartbeatShellStall = false, heartbeatStallCall = 2, heartbeatStallSeconds = 6,
  recordShellStall = false, recordStallSeconds = 8, formatShellStall = false, formatStallSeconds = 8,
  probeStallSeconds = 0, psStallCall = 0, psStallSeconds = 6, awkStallCall = 0, awkStallSeconds = 4,
  preserveLaunchctlPid = false,
  kernelStart = "missing", kernelChangedCall = 0, kernelAvailableCall = 0, kernelMissingCall = 0,
  identityChangeAfterMs = 0, psMissingStartCall = 0, psMissingEtimeCall = 0,
  timeout = 6, settle = 0, commandTimeoutMs = 30000,
}) {
  const dir = mkdtempSync(join(tmpdir(), "exo-smoke-test-"));
  const bin = join(dir, "bin");
  const app = join(dir, "App.app");
  const out = join(dir, "out");
  mkdirSync(bin);
  mkdirSync(app);
  mkdirSync(out);
  writeFileSync(join(app, "PrivacyInfo.xcprivacy"), "fake");
  writeFileSync(join(out, "device.txt"), "com.apple.CoreSimulator.SimRuntime.iOS-26-0 fake-udid iPhone\n");
  writeFileSync(join(bin, "xcrun"), fakeXcrun);
  chmodSync(join(bin, "xcrun"), 0o755);
  writeFileSync(join(bin, "sysctl"), fakeSysctl);
  chmodSync(join(bin, "sysctl"), 0o755);
  writeFileSync(join(bin, "plutil"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(bin, "plutil"), 0o755);
  writeFileSync(join(bin, "grep"), "#!/bin/sh\nif [ \"$1\" = -a ] && [ \"$2\" = 'EXO_SMOKE ' ] && [ -n \"$FAKE_PROBE_STALL_SECONDS\" ]; then sleep \"$FAKE_PROBE_STALL_SECONDS\"; fi\nPATH=${PATH#*:} exec grep \"$@\"\n");
  chmodSync(join(bin, "grep"), 0o755);
  writeFileSync(join(bin, "ps"), `#!/bin/sh
if [ -n "$FAKE_PS_STALL_CALL" ]; then
  n=0
  if [ -f "$FAKE_SIM_STATE/ps-count" ]; then read -r n < "$FAKE_SIM_STATE/ps-count"; fi
  n=$((n + 1))
  printf '%s\\n' "$n" > "$FAKE_SIM_STATE/ps-count"
  if [ "$n" -eq "$FAKE_PS_STALL_CALL" ]; then sleep "$FAKE_PS_STALL_SECONDS"; fi
fi
case "$*" in
  *lstart=*)
    if [ -f "$FAKE_SIM_STATE/exited" ]; then exit 1; fi
    n=0
    if [ -f "$FAKE_SIM_STATE/ps-start-count" ]; then read -r n < "$FAKE_SIM_STATE/ps-start-count"; fi
    n=$((n + 1))
    printf '%s\\n' "$n" > "$FAKE_SIM_STATE/ps-start-count"
    if [ "$n" -eq "$FAKE_PS_MISSING_START_CALL" ]; then printf 'S 00:00\\n'; exit 0; fi
    if [ "$n" -eq "$FAKE_PS_MISSING_ETIME_CALL" ]; then
      printf 'S Thu Oct 15 22:28:25 2026 -\\n'
      exit 0
    fi
    if [ -f "$FAKE_SIM_STATE/identity-changed" ]; then
      printf 'S Thu Oct 15 22:28:26 2026 00:00:01\\n'
    else
      printf 'S Thu Oct 15 22:28:25 2026 00:00:01\\n'
    fi
    exit 0 ;;
esac
PATH=\${PATH#*:} exec ps "$@"
`);
  chmodSync(join(bin, "ps"), 0o755);
  writeFileSync(join(bin, "awk"), "#!/bin/sh\ncase \"$*\" in\n  *app=xyz.tinycloud.exo:*)\n    if [ -n \"$FAKE_AWK_STALL_CALL\" ]; then\n      n=0\n      if [ -f \"$FAKE_SIM_STATE/awk-count\" ]; then read -r n < \"$FAKE_SIM_STATE/awk-count\"; fi\n      n=$((n + 1))\n      printf '%s\\n' \"$n\" > \"$FAKE_SIM_STATE/awk-count\"\n      if [ \"$n\" -eq \"$FAKE_AWK_STALL_CALL\" ]; then sleep \"$FAKE_AWK_STALL_SECONDS\"; fi\n    fi ;;\nesac\nPATH=${PATH#*:} exec awk \"$@\"\n");
  chmodSync(join(bin, "awk"), 0o755);
  writeFileSync(join(bin, "mv"), "#!/bin/sh\ncase \"$2\" in\n  */simctl.pid) if [ -n \"$FAKE_SIMCTL_RENAME_STALL_SECONDS\" ]; then sleep \"$FAKE_SIMCTL_RENAME_STALL_SECONDS\"; fi ;;\n  */launchctl.pid) if [ -n \"$FAKE_LAUNCHCTL_RENAME_STALL_SECONDS\" ]; then sleep \"$FAKE_LAUNCHCTL_RENAME_STALL_SECONDS\"; fi ;;\nesac\nPATH=${PATH#*:} exec mv \"$@\"\n");
  chmodSync(join(bin, "mv"), 0o755);
  if (heartbeatShellStall || recordShellStall || formatShellStall) {
    const fifo = spawnSync("mkfifo", [join(dir, "heartbeat.fifo")], { encoding: "utf8" });
    assert.equal(fifo.status, 0, "create an owned heartbeat-only FIFO");
    writeFileSync(join(dir, "heartbeat-hook.sh"), `set -T
on_heartbeat() {
  if [[ "$FAKE_HEARTBEAT_STALL" == 1 && "$1" == 'time_stage heartbeat sample_liveness' && "$2" == watch_liveness ]]; then
    heartbeat_calls=$((\${heartbeat_calls:-0} + 1))
    if [[ "$heartbeat_calls" -eq "$FAKE_HEARTBEAT_STALL_CALL" ]]; then
      local started=$SECONDS ignored
      exec 9<>"$FAKE_SIM_STATE/heartbeat.fifo"
      IFS= read -r -t "$FAKE_HEARTBEAT_STALL_SECONDS" -u 9 ignored || :
      exec 9>&-
      printf 'heartbeat-shell-read duration_s=%s\\n' "$((SECONDS - started))" >"$FAKE_SIM_STATE/heartbeat-stall.log"
    fi
  fi
  if [[ "$FAKE_RECORD_STALL" == 1 && "$1" == 'observed_epoch=$(date -u +%s)' && "$2" == record_liveness ]]; then
    if [[ ! -e "$FAKE_SIM_STATE/record-stall.once" ]]; then
      : >"$FAKE_SIM_STATE/record-stall.once"
      local started=$SECONDS ignored
      exec 9<>"$FAKE_SIM_STATE/heartbeat.fifo"
      IFS= read -r -t "$FAKE_RECORD_STALL_SECONDS" -u 9 ignored || :
      exec 9>&-
      printf 'record-shell-read duration_s=%s\\n' "$((SECONDS - started))" >"$FAKE_SIM_STATE/record-stall.log"
    fi
  fi
  if [[ "$FAKE_FORMAT_STALL" == 1 && "$1" == 'observed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)' && "$2" == record_liveness ]]; then
    if [[ ! -e "$FAKE_SIM_STATE/format-stall.once" ]]; then
      : >"$FAKE_SIM_STATE/format-stall.once"
      local started=$SECONDS ignored
      exec 9<>"$FAKE_SIM_STATE/heartbeat.fifo"
      IFS= read -r -t "$FAKE_FORMAT_STALL_SECONDS" -u 9 ignored || :
      exec 9>&-
      printf 'format-shell-read duration_s=%s\\n' "$((SECONDS - started))" >"$FAKE_SIM_STATE/format-stall.log"
    fi
  fi
}
trap 'on_heartbeat "$BASH_COMMAND" "\${FUNCNAME[0]:-}"' DEBUG
`);
  }
  const env = {
    ...process.env, ...((heartbeatShellStall || recordShellStall || formatShellStall) ? { BASH_ENV: join(dir, "heartbeat-hook.sh") } : {}),
    FAKE_HEARTBEAT_STALL: heartbeatShellStall ? "1" : "0",
    FAKE_HEARTBEAT_STALL_CALL: String(heartbeatStallCall),
    FAKE_HEARTBEAT_STALL_SECONDS: String(heartbeatStallSeconds),
    FAKE_RECORD_STALL: recordShellStall ? "1" : "0",
    FAKE_RECORD_STALL_SECONDS: String(recordStallSeconds),
    FAKE_FORMAT_STALL: formatShellStall ? "1" : "0",
    FAKE_FORMAT_STALL_SECONDS: String(formatStallSeconds),
    PATH: bin + ":" + process.env.PATH, HOME: dir, FAKE_SIM_STATE: dir,
    FAKE_PROBE_MODE: mode, FAKE_GOOD_PROBE: JSON.stringify(goodProbe),
    FAKE_EARLY_PROBE: JSON.stringify(earlyProbe),
    FAKE_EXIT_AFTER_MS: exitAfterMs ? String(exitAfterMs) : "",
    FAKE_HIDE_LAUNCHCTL: hideLaunchctl ? "1" : "0",
    FAKE_BAD_PREFIX: badPrefix ? "1" : "0",
    FAKE_CRASH: crash ? "1" : "0",
    FAKE_SIMCTL_PID: simctlPid, FAKE_SIMCTL_PID_DELAY_MS: String(pidDelayMs),
    FAKE_SIMCTL_DIFFERENT_PID: simctlDifferentPid ? "1" : "0",
    FAKE_SIMCTL_RENAME_STALL_SECONDS: String(simctlRenameStallSeconds || ""),
    FAKE_LAUNCHCTL_RENAME_STALL_SECONDS: String(launchctlRenameStallSeconds || ""),
    FAKE_KERNEL_START: kernelStart,
    FAKE_KERNEL_CHANGED_CALL: String(kernelChangedCall),
    FAKE_KERNEL_AVAILABLE_CALL: String(kernelAvailableCall || ""),
    FAKE_KERNEL_MISSING_CALL: String(kernelMissingCall || ""),
    FAKE_IDENTITY_CHANGE_AFTER_MS: String(identityChangeAfterMs || ""),
    FAKE_PS_MISSING_START_CALL: String(psMissingStartCall),
    FAKE_PS_MISSING_ETIME_CALL: String(psMissingEtimeCall),
    FAKE_PRESERVE_LAUNCHCTL_PID: preserveLaunchctlPid ? "1" : "0",
    FAKE_LAUNCHCTL_STALL_MS: String(launchctlStallMs || ""),
    FAKE_FALLBACK_MOUNTED: fallbackMounted ? "1" : "0",
    FAKE_PROBE_STALL_SECONDS: String(probeStallSeconds || ""),
    FAKE_PS_STALL_CALL: String(psStallCall || ""),
    FAKE_PS_STALL_SECONDS: String(psStallSeconds),
    FAKE_AWK_STALL_CALL: String(awkStallCall || ""),
    FAKE_AWK_STALL_SECONDS: String(awkStallSeconds),
    EXO_CAPTURE_SMOKE: "0", EXO_LOCATION_SMOKE: "0",
    SMOKE_TIMEOUT: String(timeout), SMOKE_SETTLE: String(settle),
  };
  try {
    const result = spawnSync("bash", [smoke, "run", app, out], { env, timeout: commandTimeoutMs, encoding: "utf8" });
    const artifact = (name) => { try { return readFileSync(join(out, name), "utf8"); } catch { return ""; } };
    const files = ["../heartbeat-stall.log", "../record-stall.log", "../format-stall.log", "../events", "launch-timeline.log", "liveness.log", "stage-timings.log", "clock-diagnostic.log", "app-unified-stream.log", "unified.log", "console.log", "summary.md", "crashes/App-synthetic.ips", "crash-reports.txt"];
    const snapshots = new Map(files.map((name) => [name, artifact(name)]));
    return {
      result, events: snapshots.get("../events").trim().split("\n"),
      artifact: (name) => snapshots.get(name) ?? "",
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("waits for the mounted app page and preserves timed launch/stream/liveness evidence", { timeout: 20000 }, () => {
  const { result, events, artifact } = runSmoke({ mode: "early-then-mounted" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok(events.indexOf("stream-start") >= 0 && events.indexOf("stream-start") < events.indexOf("launch"), "app stream must start before launch");
  assert.match(artifact("launch-timeline.log"), /launch requested .*Z[\s\S]*simctl launch pid \d+ observed .*Z[\s\S]*pid \d+ observed .*Z/);
  assert.match(artifact("app-unified-stream.log"), /EXO_WEB_APP_READY/);
  assert.match(artifact("summary.md"), /- \[x\] React mounted into #root/);
  assert.ok(artifact("liveness.log").trim().split("\n").length >= 2, "keep polling after the first probe through the deadline");
  for (const name of ["app-unified-stream.log", "unified.log", "console.log", "summary.md"]) {
    assert.doesNotMatch(artifact(name), /SENSITIVE_FAKE_USER_CONTENT/, name + " must be public-safe");
  }
});

test("reports an app exit after a successful early probe instead of passing on the first line", { timeout: 20000 }, () => {
  const { result, artifact } = runSmoke({ mode: "mounted", exitAfterMs: 3200 });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(artifact("liveness.log"), /pid \d+.*(exited|disappeared)/);
  assert.match(artifact("summary.md"), /app exited|app process disappeared|app process exited/);
});

test("timestamps and detects the simctl PID exit even without a launchctl job", { timeout: 20000 }, () => {
  const { result, artifact } = runSmoke({ mode: "none", hideLaunchctl: true, exitAfterMs: 3200 });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(artifact("launch-timeline.log"), /simctl launch pid \d+ observed .*Z/);
  assert.match(artifact("liveness.log"), /simctl pid \d+ exited/);
});

test("does not waive the original deadline when navigation never mounts", { timeout: 20000 }, () => {
  const { result, artifact } = runSmoke({ mode: "none", timeout: 3 });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(artifact("summary.md"), /no EXO_SMOKE probe line within 3s/);
});

test("a mounted probe emitted after the deadline remains a failure", { timeout: 20000 }, () => {
  const { result, artifact } = runSmoke({ mode: "late-mounted", timeout: 2 });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(artifact("summary.md"), /no EXO_SMOKE probe line within 2s/);
});

test("sanitized artifacts and CI output reject a marker-bearing non-timestamp prefix", { timeout: 20000 }, () => {
  const { result, artifact } = runSmoke({ mode: "mounted", badPrefix: true });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  for (const content of [artifact("console.log"), artifact("summary.md"), result.stdout, result.stderr]) {
    assert.doesNotMatch(content, /FAKE-PRIVATE-ABCD/, "synthetic non-timestamp prefix escaped");
  }
  assert.match(artifact("console.log"), /timestamp-unavailable EXO_WEB_APP_READY/);
});

test("crash still fails without publishing raw report contents", { timeout: 20000 }, () => {
  const { result, artifact } = runSmoke({ mode: "mounted", crash: true });
  assert.equal(result.status, 1, "a crash report must fail the smoke");
  assert.equal(artifact("crashes/App-synthetic.ips"), "", "raw crash report must not be published");
  assert.match(artifact("crash-reports.txt"), /^count=1$/m);
  assert.doesNotMatch(artifact("summary.md") + result.stdout, /SYNTHETIC_CRASH_PRIVATE/);
});

test("timestamps the actual delayed simctl PID despite a slow launchctl response", { timeout: 30000 }, () => {
  const { result, artifact } = runSmoke({ mode: "mounted", pidDelayMs: 3000, launchctlStallMs: 5000, timeout: 10 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const timeline = artifact("launch-timeline.log");
  const launch = timeline.match(/launch requested (\S+)/);
  const reported = timeline.match(/simctl launch pid (\d+) observed (\S+)/);
  assert.ok(launch && reported, "record only the delayed simctl bundle: PID output");
  const delay = Date.parse(reported[2]) - Date.parse(launch[1]);
  assert.ok(delay >= 2000 && delay <= 6500, `simctl PID observation lagged ${delay}ms`);
});

test("records a fixed unavailable class without confusing launchctl PID for simctl", { timeout: 30000 }, () => {
  const { result, artifact } = runSmoke({ mode: "mounted", simctlPid: "absent" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const timeline = artifact("launch-timeline.log");
  assert.match(timeline, /pid \d+ observed .*Z/);
  assert.match(timeline, /simctl launch pid not reported/);
  assert.doesNotMatch(timeline, /simctl launch pid \d+ observed/);
});

test("slow launchctl and probe work cannot starve real liveness samples", { timeout: 30000 }, () => {
  const { result, artifact } = runSmoke({ mode: "early-then-mounted", launchctlStallMs: 5000, probeStallSeconds: 4, timeout: 18 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const times = [...artifact("liveness.log").matchAll(/^(\S+) (?:simctl )?pid \d+ alive$/gm)].map((match) => Date.parse(match[1]));
  assert.ok(times.length >= 5, "the independent watcher must retain actual samples");
  for (const stage of ["main.launchctl-list", "main.probe-parse"]) {
    const row = artifact("stage-timings.log").split("\n").find((line) =>
      line.startsWith(stage + " ") && /duration_s=[4-9]$/.test(line));
    assert.ok(row, `${stage} must actually block while the watcher runs`);
    const [, start, end] = row.match(/start_epoch_s=(\d+) end_epoch_s=(\d+)/).map(Number);
    assert.ok(times.some((time) => time >= start * 1000 && time <= end * 1000),
      `at least one real PID-alive sample must overlap ${stage}`);
  }
});

test("a slow probe cannot accept a mounted page past the original deadline", { timeout: 30000 }, () => {
  const { result, artifact } = runSmoke({ mode: "early-then-mounted", probeStallSeconds: 4, timeout: 5 });
  assert.equal(result.status, 1, "a late probe must not extend the deadline");
  assert.match(artifact("summary.md"), /no EXO_SMOKE probe line within 5s/);
});

test("records an app exit while the main probe parser is stalled", { timeout: 30000 }, () => {
  const { result, artifact } = runSmoke({ mode: "early-then-mounted", exitAfterMs: 3200, probeStallSeconds: 4, timeout: 8 });
  assert.equal(result.status, 1, "an early exit must fail despite the stalled probe");
  const launch = artifact("launch-timeline.log").match(/launch requested (\S+)/);
  const exit = artifact("liveness.log").match(/^(\S+) (?:simctl )?pid \d+ exited/m);
  assert.ok(launch && exit, "record an actual timestamped exit observation");
  assert.ok(Date.parse(exit[1]) - Date.parse(launch[1]) <= 6500, "the exit was discovered only after the probe unblocked");
});

test("pre-PID six-second gap is structural while on-time PID, alive and mounted still pass", { timeout: 30000 }, () => {
  const { result, artifact } = runSmoke({
    mode: "mounted", simctlPid: "absent", launchctlStallMs: 8000,
    heartbeatShellStall: true, heartbeatStallSeconds: 4, timeout: 15,
  });
  const timeline = artifact("launch-timeline.log");
  const liveness = artifact("liveness.log");
  const launch = timeline.match(/launch requested (\S+)/);
  const pid = timeline.match(/^pid \d+ observed (\S+)/m);
  const alive = liveness.match(/^(\S+) pid \d+ alive$/m);
  const mounted = timeline.match(/mounted app-page probe observed (\S+)/);
  assert.match(artifact("../heartbeat-stall.log"), /^heartbeat-shell-read duration_s=[4-5]/);
  assert.match(liveness, /pre-PID observation gap [6-9]s/, "record the real pre-PID gap as a fixed structural class");
  assert.ok(launch && pid && alive && mounted, "the same app needs PID, real alive and mounted proof");
  assert.ok(Date.parse(pid[1]) - Date.parse(launch[1]) < 15000, "PID publication must be in-window");
  assert.ok(Date.parse(alive[1]) - Date.parse(launch[1]) < 15000, "alive must be in-window");
  assert.ok(Date.parse(mounted[1]) - Date.parse(launch[1]) < 15000, "mounted probe must be in-window");
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.doesNotMatch(artifact("summary.md"), /liveness observation gap exceeded 30s/);
});

test("PID publication inside a long heartbeat preserves the pre-PID portion", { timeout: 30000 }, () => {
  const { result, artifact } = runSmoke({
    mode: "mounted", simctlPid: "absent", launchctlStallMs: 6000,
    heartbeatShellStall: true, heartbeatStallSeconds: 6, timeout: 15,
  });
  const timeline = artifact("launch-timeline.log");
  const liveness = artifact("liveness.log");
  const prior = liveness.match(/^(\S+) pid not yet observed$/m);
  const pid = timeline.match(/^pid \d+ observed (\S+)/m);
  const alive = liveness.match(/^(\S+) pid \d+ alive$/m);
  assert.ok(prior && pid && alive, "a delayed PID must precede the first verified process observation");
  assert.ok(Date.parse(pid[1]) - Date.parse(prior[1]) >= 6000,
    "the pre-PID part of the interval must itself exceed five seconds");
  assert.ok(Date.parse(alive[1]) - Date.parse(pid[1]) <= 5000,
    "the post-PID part must remain within the hard limit");
  assert.match(liveness, /pre-PID observation gap [6-9]s/,
    "the split interval must retain its truthful non-gating pre-PID duration");
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.doesNotMatch(artifact("summary.md"), /liveness observation gap exceeded 30s/);
});

test("PID publication during watcher stall diagnoses latency before first alive", { timeout: 30000 }, () => {
  const { result, artifact } = runSmoke({
    mode: "mounted", simctlPid: "absent", launchctlStallMs: 1000,
    heartbeatShellStall: true, heartbeatStallCall: 2, timeout: 13,
  });
  const timeline = artifact("launch-timeline.log");
  const liveness = artifact("liveness.log");
  const published = timeline.match(/^pid \d+ observed (\S+)/m);
  const gap = liveness.match(/^(\S+) diagnostic observation gap (\d+)s$/m);
  assert.ok(published && gap && Date.parse(gap[1]) - Date.parse(published[1]) > 5000,
    "the verified PID publication precedes the actual long interval");
  assert.doesNotMatch(liveness.split(/diagnostic observation gap \d+s/)[0], /pid \d+ alive/,
    "the first alive sample must not be invented before the stall");
  assert.match(liveness, /pid \d+ alive/);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.doesNotMatch(artifact("summary.md"), /liveness observation gap exceeded 30s/);
});

test("slow simctl PID scanning cannot starve an independent liveness watcher", { timeout: 30000 }, () => {
  const { result, artifact } = runSmoke({ mode: "mounted", simctlPid: "absent", awkStallCall: 2, timeout: 9 });
  const liveness = artifact("liveness.log");
  assert.equal(result.status, 0,
    artifact("summary.md").includes("liveness observation gap") ? "PID scan stalled liveness" : "unexpected smoke failure");
  assert.match(artifact("launch-timeline.log"), /simctl launch pid not reported/);
  const observations = [...liveness.matchAll(/^(\S+) pid \d+ alive$/gm)].map((match) => Date.parse(match[1]));
  assert.ok(observations.length >= 3, "continue real app PID observations through the deadline");
  for (let index = 1; index < observations.length; index++) {
    assert.ok(observations[index] - observations[index - 1] <= 5000, "PID scan starved liveness");
  }
});

test("PID publication during first epoch capture cannot be mistaken for a pre-PID gap", { timeout: 30000 }, () => {
  const { result, artifact } = runSmoke({
    mode: "mounted", simctlPid: "absent", launchctlStallMs: 1000,
    recordShellStall: true, timeout: 16,
  });
  const timeline = artifact("launch-timeline.log");
  const liveness = artifact("liveness.log");
  const pid = timeline.match(/^pid \d+ observed (\S+)/m);
  const first = liveness.match(/^(\S+) (?:pid not yet observed|pid published; liveness check pending)$/m);
  assert.match(artifact("../record-stall.log"), /^record-shell-read duration_s=[8-9]/);
  assert.ok(pid && first && Date.parse(first[1]) - Date.parse(pid[1]) > 5000,
    "verified PID must publish while the first observation epoch capture is blocked");
  assert.match(timeline, /mounted app-page probe observed/);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const diagnostic = liveness.match(/^(\S+) diagnostic observation gap ([6-9])s$/m);
  assert.ok(diagnostic && Date.parse(diagnostic[1]) === Date.parse(first[1])
    && liveness.indexOf(diagnostic[0]) < liveness.indexOf(first[0]),
    "the first completed observation classifies the post-publication interval");
  assert.doesNotMatch(artifact("summary.md"), /liveness observation gap exceeded 30s/);
});

test("pending PID records retain diagnostic publication-to-first-alive latency", { timeout: 30000 }, () => {
  const { result, artifact } = runSmoke({
    mode: "mounted", simctlPid: "absent", launchctlStallMs: 1000,
    recordShellStall: true, recordStallSeconds: 5, timeout: 14,
  });
  const timeline = artifact("launch-timeline.log");
  const liveness = artifact("liveness.log");
  const published = timeline.match(/^pid \d+ observed (\S+)/m);
  const pending = liveness.match(/^(\S+) pid published; liveness check pending$/m);
  const alive = liveness.match(/^(\S+) pid \d+ alive$/m);
  assert.match(artifact("../record-stall.log"), /^record-shell-read duration_s=[5-6]/);
  assert.ok(published && pending && alive, "verified PID, pending sample and real alive proof are distinct");
  assert.ok(Date.parse(pending[1]) - Date.parse(published[1]) <= 5000,
    "the pending sample precedes the first alive proof");
  assert.ok(Date.parse(alive[1]) - Date.parse(published[1]) > 5000,
    "record the cumulative publication-to-first-real-alive latency");
  assert.match(timeline, /mounted app-page probe observed/);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(liveness, /^\S+ diagnostic PID-alive proof gap [6-9]s$/m);
  assert.doesNotMatch(artifact("summary.md"), /liveness observation gap exceeded 30s/);
});

test("terminal coverage refreshes a PID published after its last observation snapshot", { timeout: 30000 }, () => {
  const { result, artifact } = runSmoke({
    mode: "mounted", simctlPid: "absent", launchctlStallMs: 1000,
    formatShellStall: true, timeout: 5,
  });
  const timeline = artifact("launch-timeline.log");
  const launch = timeline.match(/launch requested (\S+)/);
  const pid = timeline.match(/^pid \d+ observed (\S+)/m);
  assert.match(artifact("../format-stall.log"), /^format-shell-read duration_s=[8-9]/);
  assert.ok(launch && pid && Date.parse(pid[1]) - Date.parse(launch[1]) < 5000,
    "verified PID must publish before the original deadline during formatting");
  const firstAlive = artifact("liveness.log").match(/^(\S+) pid \d+ alive$/m);
  assert.ok(launch && firstAlive && Date.parse(firstAlive[1]) - Date.parse(launch[1]) >= 5000,
    "the terminal identity check is real but cannot invent in-window alive proof");
  assert.match(artifact("liveness.log"), /^\S+ diagnostic observation gap [6-9]s$/m,
    "terminal coverage reports the post-publication gap");
  assert.match(artifact("liveness.log"), /^\S+ diagnostic PID-alive proof gap [6-9]s$/m);
  assert.equal(result.status, 1);
  assert.match(artifact("summary.md"), /no app PID-alive observation before probe deadline/);
});

test("does not publish a simctl PID discovered only after the unchanged deadline", { timeout: 30000 }, () => {
  const { result, artifact } = runSmoke({ mode: "mounted", pidDelayMs: 1000, awkStallCall: 1, awkStallSeconds: 7, timeout: 6 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(artifact("launch-timeline.log"), /simctl launch pid not reported/);
  assert.doesNotMatch(artifact("launch-timeline.log"), /simctl launch pid \d+ observed/);
  assert.match(artifact("launch-timeline.log"), /pid \d+ observed/);
  assert.match(artifact("liveness.log"), /^.* pid \d+ alive$/m, "on-time launchctl PID must still prove app liveness");
});

test("a launchctl PID first returned after the deadline cannot qualify a bounded mounted fallback", { timeout: 30000 }, () => {
  const { result, artifact } = runSmoke({
    mode: "mounted", simctlPid: "absent", launchctlStallMs: 6000, fallbackMounted: true, timeout: 5,
  });
  const timeline = artifact("launch-timeline.log");
  assert.match(timeline, /mounted app-page fallback probe observed/, "exercise the on-time mounted fallback");
  assert.match(timeline, /simctl launch pid not reported/);
  assert.doesNotMatch(timeline, /^pid \d+ observed/m, "a post-deadline launchctl PID cannot be published");
  assert.doesNotMatch(artifact("liveness.log"), /(?:simctl )?pid \d+ alive/, "there was no in-window app PID observation");
  assert.equal(result.status, 1, "a mounted fallback alone cannot pass without in-window app liveness");
  assert.match(artifact("summary.md"), /no app PID-alive observation before probe deadline/);
  assert.doesNotMatch(result.stdout + artifact("summary.md") + artifact("stage-timings.log"), /SENSITIVE_FAKE_USER_CONTENT/);
});

test("neither PID source arriving after deadline can create an in-window alive observation", { timeout: 30000 }, () => {
  const { result, artifact } = runSmoke({
    mode: "mounted", pidDelayMs: 6000, launchctlStallMs: 6000, fallbackMounted: true, timeout: 5,
  });
  const timeline = artifact("launch-timeline.log");
  assert.match(timeline, /mounted app-page fallback probe observed/);
  assert.match(timeline, /simctl launch pid not reported/);
  assert.doesNotMatch(timeline, /^(?:simctl launch )?pid \d+ observed/m, "late sources must not publish a PID");
  assert.doesNotMatch(artifact("liveness.log"), /(?:simctl )?pid \d+ alive/);
  assert.equal(result.status, 1);
  assert.match(artifact("summary.md"), /no app PID-alive observation before probe deadline/);
});

test("a first positive process check after deadline cannot become in-window liveness proof", { timeout: 30000 }, () => {
  const { result, artifact } = runSmoke({
    mode: "mounted", simctlPid: "absent", psStallCall: 2, psStallSeconds: 3, timeout: 4,
  });
  const timeline = artifact("launch-timeline.log");
  const launch = timeline.match(/launch requested (\S+)/);
  const alive = artifact("liveness.log").match(/^(\S+) pid \d+ alive$/m);
  assert.match(timeline, /^pid \d+ observed/m, "the app PID must be known before the deadline");
  assert.match(timeline, /mounted app-page probe observed/, "the mounted probe must precede the deadline");
  assert.ok(launch && alive && Date.parse(alive[1]) - Date.parse(launch[1]) >= 4000,
    "the first successful process check must complete after the deadline");
  assert.match(artifact("stage-timings.log"), /heartbeat\.pid-check start_epoch_s=\d+ end_epoch_s=\d+ duration_s=[3-4]/);
  assert.doesNotMatch(artifact("liveness.log"), /diagnostic observation gap/, "this fixture does not need the long-gap path");
  assert.equal(result.status, 1);
  assert.match(artifact("summary.md"), /no app PID-alive observation before probe deadline/);
});

test("signed C: the same PID with a different kernel start time fails identity", { timeout: 25000 }, () => {
  const { result, artifact } = runSmoke({
    mode: "mounted", kernelStart: "valid", identityChangeAfterMs: 3200, timeout: 9,
  });
  assert.match(artifact("launch-timeline.log"), /start-time source kernel-us/);
  assert.equal(result.status, 1, "PID reuse must not count as continuity");
  assert.match(artifact("summary.md"), /app process identity changed/);
  assert.match(artifact("liveness.log"), /pid \d+ identity changed/);
});

test("signed C: an exit during a long watcher interval fails as an app exit", { timeout: 30000 }, () => {
  const { result, artifact } = runSmoke({
    mode: "mounted", simctlPid: "absent", preserveLaunchctlPid: true,
    exitAfterMs: 5200, heartbeatShellStall: true, heartbeatStallCall: 3,
    heartbeatStallSeconds: 6, timeout: 13,
  });
  assert.match(artifact("../heartbeat-stall.log"), /^heartbeat-shell-read duration_s=[6-9]/);
  assert.equal(result.status, 1);
  assert.match(artifact("liveness.log"), /pid \d+ exited/);
  assert.match(artifact("summary.md"), /app process exited during liveness/);
  assert.doesNotMatch(artifact("summary.md"), /liveness observation gap exceeded 5s/);
});

test("signed C: a post-publication gap above thirty seconds remains a hard failure", { timeout: 60000 }, () => {
  const { result, artifact } = runSmoke({
    mode: "mounted", simctlPid: "absent", heartbeatShellStall: true,
    heartbeatStallCall: 3, heartbeatStallSeconds: 31, timeout: 39, commandTimeoutMs: 55000,
  });
  assert.match(artifact("../heartbeat-stall.log"), /^heartbeat-shell-read duration_s=3[0-3]/);
  assert.equal(result.status, 1);
  assert.match(artifact("liveness.log"), /observation gap 3[0-9]s/);
  assert.match(artifact("summary.md"), /liveness observation gap exceeded 30s/);
});

test("signed C: missing start time at first publication cannot be repaired later", { timeout: 25000 }, () => {
  const { result, artifact } = runSmoke({
    mode: "mounted", simctlPid: "absent", psMissingStartCall: 1, timeout: 8,
  });
  assert.equal(result.status, 1);
  assert.match(artifact("summary.md"), /process start time unavailable at PID publication/);
  assert.match(artifact("launch-timeline.log"), /start-time unavailable at publication/);
});

test("signed C: coarse fallback without elapsed telemetry cannot bind identity", { timeout: 25000 }, () => {
  const { result, artifact } = runSmoke({
    mode: "mounted", simctlPid: "absent", psMissingEtimeCall: 1, timeout: 8,
  });
  assert.equal(result.status, 1);
  assert.match(artifact("summary.md"), /process start time unavailable at PID publication/);
  assert.match(artifact("launch-timeline.log"), /start-time unavailable at publication/);
});

test("signed C: missing start time during an observation fails without a source switch", { timeout: 25000 }, () => {
  const { result, artifact } = runSmoke({
    mode: "mounted", simctlPid: "absent", psMissingStartCall: 3, timeout: 9,
  });
  assert.equal(result.status, 1);
  assert.match(artifact("summary.md"), /process start time unavailable during liveness/);
});

test("signed C: unchanged identity survives a six-second gap with diagnostics only", { timeout: 30000 }, () => {
  const { result, artifact } = runSmoke({
    mode: "mounted", kernelStart: "valid", heartbeatShellStall: true,
    heartbeatStallCall: 3, heartbeatStallSeconds: 6, timeout: 14,
  });
  assert.match(artifact("../heartbeat-stall.log"), /^heartbeat-shell-read duration_s=[6-9]/);
  const gap = artifact("liveness.log").match(/diagnostic observation gap (\d+)s/);
  assert.ok(gap && Number(gap[1]) > 5 && Number(gap[1]) <= 30,
    "record actual diagnostic latency without treating a scheduled ten-second gap as failure");
  assert.match(artifact("launch-timeline.log"), /start-time source kernel-us/);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.doesNotMatch(artifact("summary.md"), /liveness observation gap exceeded/);
});

test("signed C: terminal settle checks the original PID and start-time pair", { timeout: 25000 }, () => {
  const { result, artifact } = runSmoke({
    mode: "mounted", kernelStart: "valid", identityChangeAfterMs: 6200,
    timeout: 5, settle: 3,
  });
  assert.match(artifact("liveness.log"), /pid \d+ alive/);
  assert.equal(result.status, 1, "a new process at terminal settle is not the launched app");
  assert.match(artifact("summary.md"), /app process identity changed/);
});

test("signed C: kernel microsecond boundary falls back to labelled coarse lstart plus etime", { timeout: 30000 }, () => {
  const valid = runSmoke({ mode: "mounted", kernelStart: "valid" });
  assert.equal(valid.result.status, 0, valid.result.stdout + valid.result.stderr);
  assert.match(valid.artifact("launch-timeline.log"), /start-time source kernel-us/);
  const invalid = runSmoke({ mode: "mounted", kernelStart: "invalid-usec" });
  assert.equal(invalid.result.status, 0, invalid.result.stdout + invalid.result.stderr);
  assert.match(invalid.artifact("launch-timeline.log"), /start-time source ps-lstart-etime-coarse/);
});

test("signed C: later verified PID source cannot reset the earliest identity", { timeout: 30000 }, () => {
  const { result, artifact } = runSmoke({
    mode: "mounted", kernelStart: "valid", pidDelayMs: 1000,
    launchctlStallMs: 3500, timeout: 10,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const timeline = artifact("launch-timeline.log");
  assert.match(timeline, /simctl launch pid \d+ observed/);
  assert.match(timeline, /^pid \d+ observed/m);
  assert.equal((timeline.match(/start-time source kernel-us/g) ?? []).length, 1,
    "the later source cannot select a second identity baseline");
  assert.match(artifact("liveness.log"), /pid \d+ alive/);
});

test("signed C: PID publication epoch follows a slow start-time acquisition", { timeout: 30000 }, () => {
  const { result, artifact } = runSmoke({
    mode: "mounted", simctlPid: "absent", psStallCall: 1, psStallSeconds: 4, timeout: 13,
  });
  const timeline = artifact("launch-timeline.log");
  const publication = timeline.match(/^pid \d+ observed (\S+)/m);
  const alive = artifact("liveness.log").match(/^(\S+) pid \d+ alive$/m);
  assert.ok(publication && alive && Date.parse(alive[1]) - Date.parse(publication[1]) <= 5000,
    "the first real observation is close to the *completed* identity publication");
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.doesNotMatch(artifact("liveness.log"), /diagnostic PID-alive proof gap/,
    "start-time acquisition before publication cannot be charged as a post-publication gap");
});

test("signed D: a slow process call is timed against the independent bare clock", { timeout: 30000 }, () => {
  const { result, artifact } = runSmoke({
    mode: "mounted", simctlPid: "absent", psStallCall: 2, psStallSeconds: 4, timeout: 13,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const slow = artifact("stage-timings.log").split("\n")
    .find((line) => /^identity\.ps start_epoch_s=\d+ end_epoch_s=\d+ duration_s=[4-9]$/.test(line));
  assert.ok(slow, "the blocking process query needs its own actual wall interval");
  const [, start, end] = slow.match(/start_epoch_s=(\d+) end_epoch_s=(\d+)/).map(Number);
  assert.ok(end - start >= 4, "wall endpoints must bracket the actual stalled call");
  const clock = [...artifact("clock-diagnostic.log").matchAll(/^clock start_epoch_s=(\d+) end_epoch_s=(\d+) duration_s=(\d+)$/gm)];
  assert.ok(clock.some(([, from, to]) => Number(from) < end && Number(to) > start),
    "app-independent scheduler clock must keep observing during a slow PID query");
  assert.match(artifact("liveness.log"), /diagnostic (?:PID-alive proof|observation) gap [6-9]s/);
});

test("signed D: every stage exposes sanitized wall endpoints and the bare clock samples", { timeout: 25000 }, () => {
  const { result, artifact } = runSmoke({ mode: "mounted", simctlPid: "absent", timeout: 10 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const lines = artifact("stage-timings.log").trim().split("\n");
  assert.ok(lines.every((line) => /^[a-z][a-z.-]* start_epoch_s=\d+ end_epoch_s=\d+ duration_s=\d+$/.test(line)),
    "every stage needs fixed structural wall endpoints and duration only");
  assert.match(artifact("clock-diagnostic.log"), /^clock start_epoch_s=\d+ end_epoch_s=\d+ duration_s=\d+$/m);
  assert.doesNotMatch(artifact("stage-timings.log") + artifact("clock-diagnostic.log"), /SENSITIVE_FAKE_USER_CONTENT/);
});

test("a completed simctl rename after deadline cannot publish beside an on-time launchctl proof", { timeout: 30000 }, () => {
  const { result, artifact } = runSmoke({
    mode: "mounted", simctlRenameStallSeconds: 6, timeout: 5,
  });
  const timeline = artifact("launch-timeline.log");
  assert.match(artifact("stage-timings.log"), /(?:simctl\.pid-|observer\.)/);
  assert.match(timeline, /^pid \d+ observed \S+/m, "launchctl still supplies on-time PID");
  assert.match(artifact("liveness.log"), /^\S+ pid \d+ alive$/m, "on-time identity actually observed");
  assert.match(timeline, /mounted app-page probe observed/);
  assert.match(timeline, /simctl launch pid not reported/, "late rename never becomes an accepted publication");
  assert.doesNotMatch(timeline, /simctl launch pid \d+ observed/, "late PID cannot be backdated");
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test("a completed launchctl rename after deadline cannot publish beside an on-time simctl proof", { timeout: 30000 }, () => {
  const { result, artifact } = runSmoke({
    mode: "mounted", launchctlRenameStallSeconds: 10, fallbackMounted: true, timeout: 8,
  });
  const timeline = artifact("launch-timeline.log");
  assert.match(artifact("stage-timings.log"), /launchctl\.publish-rename start_epoch_s=\d+ end_epoch_s=\d+ duration_s=1[0-2]/);
  assert.match(timeline, /simctl launch pid \d+ observed \S+/);
  assert.match(artifact("liveness.log"), /^\S+ simctl pid \d+ alive$/m);
  assert.match(timeline, /mounted app-page fallback probe observed/);
  assert.doesNotMatch(timeline, /^pid \d+ observed/m, "late launchctl PID cannot be backdated");
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test("a later kernel-capable publisher retains the earlier coarse identity source", { timeout: 30000 }, () => {
  const { result, artifact } = runSmoke({
    mode: "mounted", kernelStart: "valid", kernelAvailableCall: 2,
    pidDelayMs: 3500, timeout: 11,
  });
  const timeline = artifact("launch-timeline.log");
  assert.match(timeline, /^pid \d+ observed \S+/m);
  assert.match(timeline, /simctl launch pid \d+ observed/);
  assert.match(timeline, /start-time source ps-lstart-etime-coarse/,
    "the earliest valid fallback representation is retained for the run");
  assert.doesNotMatch(artifact("summary.md"), /app process identity changed/);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test("both publishers before the first watcher read still select earliest coarse source", { timeout: 30000 }, () => {
  const { result, artifact } = runSmoke({
    mode: "mounted", kernelStart: "valid", kernelAvailableCall: 2,
    pidDelayMs: 3500, heartbeatShellStall: true, heartbeatStallCall: 1,
    heartbeatStallSeconds: 5, timeout: 13,
  });
  const timeline = artifact("launch-timeline.log");
  assert.match(artifact("../heartbeat-stall.log"), /heartbeat-shell-read duration_s=[5-6]/);
  assert.match(timeline, /^pid \d+ observed \S+/m);
  assert.match(timeline, /simctl launch pid \d+ observed/);
  assert.match(timeline, /start-time source ps-lstart-etime-coarse/);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test("established kernel identity must fail closed when the kernel source disappears", { timeout: 25000 }, () => {
  const { result, artifact } = runSmoke({
    mode: "mounted", kernelStart: "valid", kernelMissingCall: 2,
    hideLaunchctl: true, timeout: 7,
  });
  assert.match(artifact("launch-timeline.log"), /start-time source kernel-us/);
  assert.equal(result.status, 1);
  assert.match(artifact("summary.md"), /process start time unavailable during liveness/);
});

test("a distinct second-source PID cannot inherit the earlier process identity", { timeout: 30000 }, () => {
  const { result, artifact } = runSmoke({
    mode: "mounted", kernelStart: "valid", simctlDifferentPid: true,
    pidDelayMs: 3500, timeout: 10,
  });
  const timeline = artifact("launch-timeline.log");
  const launchctl = timeline.match(/^pid (\d+) observed/m);
  const simctl = timeline.match(/simctl launch pid (\d+) observed/);
  assert.ok(launchctl && simctl && launchctl[1] !== simctl[1],
    "two independently qualified sources report different PIDs without signalling host processes");
  assert.equal(result.status, 1);
  assert.match(artifact("summary.md"), /app process identity changed/);
});
