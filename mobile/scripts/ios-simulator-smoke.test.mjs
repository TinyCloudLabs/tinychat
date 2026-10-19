import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";

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
const aliveLine = { file: "liveness.log", pattern: "pid \\d+ alive" };

// Determinism rules for this file:
//  - every scenario runs in its own temp tree, concurrently with the others (spawn, never spawnSync);
//  - app-side events (exit, identity change, SIGINT) fire when the script's own artifacts show a marker, not after
//    a wall-clock delay;
//  - stalls only ever make an event *later*, so assertions use lower bounds from the stall, never upper bounds on
//    how fast the script reacted.

// The test drives the actual smoke script, with only simulator and plutil binaries replaced.
const fakeXcrun = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const state = process.env.FAKE_SIM_STATE;
const args = process.argv.slice(2);
const events = path.join(state, 'events');
const event = (kind) => fs.appendFileSync(events, kind + '\\n');
fs.appendFileSync(path.join(state, 'xcrun-pids'), process.pid + '\\n');
// Run action once the named artifact (relative to the out dir) matches the pattern.
const when = (spec, action) => {
  if (!spec) return;
  const { file, pattern } = JSON.parse(spec);
  const target = path.resolve(process.env.FAKE_OUT, file);
  const re = new RegExp(pattern);
  const timer = setInterval(() => {
    let text;
    try { text = fs.readFileSync(target, 'utf8'); } catch { return; }
    if (re.test(text)) { clearInterval(timer); action(); }
  }, 50);
};
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
  when(process.env.FAKE_EXIT_WHEN, () => {
    fs.writeFileSync(path.join(state, 'exited'), '1');
    process.exit(0);
  });
  when(process.env.FAKE_CHANGE_WHEN, () => fs.writeFileSync(path.join(state, 'identity-changed'), '1'));
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
  event('terminate');
  const pidFile = path.join(state, 'pid');
  if (fs.existsSync(pidFile)) {
    try { process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 'SIGTERM'); } catch {}
  }
}
`;

// macOS sysctl -b kern.proc.pid.<pid> returns a binary kinfo_proc whose first 16 bytes are extern_proc.p_starttime:
// a 64-bit-ABI timeval, i.e. int64 tv_sec, int32 tv_usec, then 4 padding bytes that are NOT guaranteed zero.
// The fake fills the padding with a non-zero pattern so a parser that reads tv_usec as 8 bytes cannot pass.
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
record.writeInt32LE(process.env.FAKE_KERNEL_START === 'invalid-usec' ? 1000000 : 123456, 8);
record.writeUInt32LE(0xdeadbeef, 12);
process.stdout.write(record);
`;

// A shell DEBUG-trap hook that blocks the heartbeat once, on a FIFO nobody writes to (a read timeout is the stall).
// It drops a marker first so the fake app can act while the heartbeat is provably blocked.
const heartbeatHook = `set -T
on_heartbeat() {
  if [[ "$FAKE_HEARTBEAT_STALL" == 1 && "$1" == 'time_stage heartbeat sample_liveness' && "$2" == watch_liveness ]]; then
    heartbeat_calls=$((\${heartbeat_calls:-0} + 1))
    if [[ "$heartbeat_calls" -eq "$FAKE_HEARTBEAT_STALL_CALL" ]]; then
      local started=$SECONDS ignored
      : >"$FAKE_SIM_STATE/heartbeat-stall.started"
      exec 9<>"$FAKE_SIM_STATE/heartbeat.fifo"
      IFS= read -r -t "$FAKE_HEARTBEAT_STALL_SECONDS" -u 9 ignored || :
      exec 9>&-
      printf 'heartbeat-shell-read duration_s=%s\\n' "$((SECONDS - started))" >"$FAKE_SIM_STATE/heartbeat-stall.log"
    fi
  fi
}
trap 'on_heartbeat "$BASH_COMMAND" "\${FUNCNAME[0]:-}"' DEBUG
`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function runSmoke({
  mode, exitWhen, changeWhen, hideLaunchctl = false, badPrefix = false, crash = false,
  simctlPid = "immediate", pidDelayMs = 0, simctlDifferentPid = false,
  launchctlStallMs = 0, fallbackMounted = false,
  simctlRenameStallSeconds = 0, launchctlRenameStallSeconds = 0, simctlReadyStallSeconds = 0,
  heartbeatShellStall = false, heartbeatStallCall = 2, heartbeatStallSeconds = 6,
  probeStallSeconds = 0, psStallCall = 0, psStallSeconds = 6, awkStallCall = 0, awkStallSeconds = 4,
  preserveLaunchctlPid = false,
  kernelStart = "missing", kernelChangedCall = 0, kernelAvailableCall = 0, kernelMissingCall = 0,
  psMissingStartCall = 0, psMissingEtimeCall = 0,
  gapFailSeconds = 0, trackProcesses = false, signalWhen = null,
  timeout = 8, settle = 0, commandTimeoutMs = 90000,
}) {
  const dir = mkdtempSync(join(tmpdir(), "exo-smoke-test-"));
  const bin = join(dir, "bin");
  const app = join(dir, "App.app");
  const out = join(dir, "out");
  const tmp = join(dir, "tmp");
  for (const path of [bin, app, out, tmp]) mkdirSync(path);
  writeFileSync(join(app, "PrivacyInfo.xcprivacy"), "fake");
  writeFileSync(join(out, "device.txt"), "com.apple.CoreSimulator.SimRuntime.iOS-26-0 fake-udid iPhone\n");
  const install = (name, body) => { writeFileSync(join(bin, name), body); chmodSync(join(bin, name), 0o755); };
  install("xcrun", fakeXcrun);
  install("sysctl", fakeSysctl);
  install("plutil", "#!/bin/sh\nexit 0\n");
  install("grep", "#!/bin/sh\nif [ \"$1\" = -a ] && [ \"$2\" = 'EXO_SMOKE ' ] && [ -n \"$FAKE_PROBE_STALL_SECONDS\" ]; then sleep \"$FAKE_PROBE_STALL_SECONDS\"; fi\nPATH=${PATH#*:} exec grep \"$@\"\n");
  install("ps", `#!/bin/sh
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
  install("awk", "#!/bin/sh\ncase \"$*\" in\n  *app=xyz.tinycloud.exo:*)\n    if [ -n \"$FAKE_AWK_STALL_CALL\" ]; then\n      n=0\n      if [ -f \"$FAKE_SIM_STATE/awk-count\" ]; then read -r n < \"$FAKE_SIM_STATE/awk-count\"; fi\n      n=$((n + 1))\n      printf '%s\\n' \"$n\" > \"$FAKE_SIM_STATE/awk-count\"\n      if [ \"$n\" -eq \"$FAKE_AWK_STALL_CALL\" ]; then sleep \"$FAKE_AWK_STALL_SECONDS\"; fi\n    fi ;;\nesac\nPATH=${PATH#*:} exec awk \"$@\"\n");
  // mv: optionally stall the .pid rename, and record what each .ready rename looks like at the moment it happens.
  install("mv", `#!/bin/sh
case "$2" in
  */simctl.pid) if [ -n "$FAKE_SIMCTL_RENAME_STALL_SECONDS" ]; then sleep "$FAKE_SIMCTL_RENAME_STALL_SECONDS"; fi ;;
  */launchctl.pid) if [ -n "$FAKE_LAUNCHCTL_RENAME_STALL_SECONDS" ]; then sleep "$FAKE_LAUNCHCTL_RENAME_STALL_SECONDS"; fi ;;
  */simctl.ready|*/launchctl.ready)
    if [ -e "$2" ]; then visible=1; else visible=0; fi
    printf 'src=%s dst_visible=%s content=%s\\n' "\${1##*/}" "$visible" "$(cat "$1")" >> "$FAKE_SIM_STATE/ready-spy"
    case "$2" in */simctl.ready) if [ -n "$FAKE_SIMCTL_READY_STALL_SECONDS" ]; then sleep "$FAKE_SIMCTL_READY_STALL_SECONDS"; fi ;; esac ;;
esac
PATH=\${PATH#*:} exec mv "$@"
`);
  if (trackProcesses) {
    install("sleep", "#!/bin/sh\necho $$ >> \"$FAKE_SIM_STATE/sleep-pids\"\nPATH=${PATH#*:} exec sleep \"$@\"\n");
  }
  if (heartbeatShellStall) {
    const fifo = spawnSync("mkfifo", [join(dir, "heartbeat.fifo")], { encoding: "utf8" });
    assert.equal(fifo.status, 0, "create an owned heartbeat-only FIFO");
    writeFileSync(join(dir, "heartbeat-hook.sh"), heartbeatHook);
  }
  const env = {
    ...process.env, ...(heartbeatShellStall ? { BASH_ENV: join(dir, "heartbeat-hook.sh") } : {}),
    FAKE_HEARTBEAT_STALL: heartbeatShellStall ? "1" : "0",
    FAKE_HEARTBEAT_STALL_CALL: String(heartbeatStallCall),
    FAKE_HEARTBEAT_STALL_SECONDS: String(heartbeatStallSeconds),
    PATH: bin + ":" + process.env.PATH, HOME: dir, TMPDIR: tmp, FAKE_SIM_STATE: dir, FAKE_OUT: out,
    FAKE_PROBE_MODE: mode, FAKE_GOOD_PROBE: JSON.stringify(goodProbe),
    FAKE_EARLY_PROBE: JSON.stringify(earlyProbe),
    FAKE_EXIT_WHEN: exitWhen ? JSON.stringify(exitWhen) : "",
    FAKE_CHANGE_WHEN: changeWhen ? JSON.stringify(changeWhen) : "",
    FAKE_HIDE_LAUNCHCTL: hideLaunchctl ? "1" : "0",
    FAKE_BAD_PREFIX: badPrefix ? "1" : "0",
    FAKE_CRASH: crash ? "1" : "0",
    FAKE_SIMCTL_PID: simctlPid, FAKE_SIMCTL_PID_DELAY_MS: String(pidDelayMs),
    FAKE_SIMCTL_DIFFERENT_PID: simctlDifferentPid ? "1" : "0",
    FAKE_SIMCTL_RENAME_STALL_SECONDS: String(simctlRenameStallSeconds || ""),
    FAKE_LAUNCHCTL_RENAME_STALL_SECONDS: String(launchctlRenameStallSeconds || ""),
    FAKE_SIMCTL_READY_STALL_SECONDS: String(simctlReadyStallSeconds || ""),
    FAKE_KERNEL_START: kernelStart,
    FAKE_KERNEL_CHANGED_CALL: String(kernelChangedCall),
    FAKE_KERNEL_AVAILABLE_CALL: String(kernelAvailableCall || ""),
    FAKE_KERNEL_MISSING_CALL: String(kernelMissingCall || ""),
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
    ...(gapFailSeconds ? { SMOKE_GAP_FAIL_S: String(gapFailSeconds) } : {}),
  };
  const read = (name) => { try { return readFileSync(join(out, name), "utf8"); } catch { return ""; } };
  try {
    const child = spawn("bash", [smoke, "run", app, out], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const killer = setTimeout(() => child.kill("SIGKILL"), commandTimeoutMs);
    let signalTimer;
    if (signalWhen) {
      const pattern = new RegExp(signalWhen.pattern);
      signalTimer = setInterval(() => {
        if (pattern.test(read(signalWhen.file))) {
          clearInterval(signalTimer);
          child.kill(signalWhen.signal);
        }
      }, 50);
    }
    const [status, signal] = await new Promise((resolve) => child.on("close", (code, sig) => resolve([code, sig])));
    clearTimeout(killer);
    clearInterval(signalTimer);
    const result = { status, signal, stdout, stderr };
    const files = ["../heartbeat-stall.log", "../events", "../ready-spy", "launch-timeline.log", "liveness.log", "stage-timings.log", "clock-diagnostic.log", "app-unified-stream.log", "unified.log", "console.log", "summary.md", "crashes/App-synthetic.ips", "crash-reports.txt"];
    const snapshots = new Map(files.map((name) => [name, read(name)]));
    const leftover = readdirSync(tmp);
    let processesGone = null;
    if (trackProcesses) {
      const pids = ["xcrun-pids", "sleep-pids"].flatMap((name) => {
        try { return readFileSync(join(dir, name), "utf8").split("\n").filter(Boolean).map(Number); } catch { return []; }
      });
      // Reparented survivors die asynchronously after the script exits; wait on the condition, not a delay.
      for (let tries = 0; tries < 100 && pids.some(alive); tries++) await sleep(50);
      processesGone = pids.filter(alive);
    }
    return {
      result, leftover, processesGone, events: snapshots.get("../events").trim().split("\n"),
      artifact: (name) => snapshots.get(name) ?? "",
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const epochMs = (stamp) => Date.parse(stamp);

describe("ios-simulator-smoke.sh", { concurrency: 24 }, () => {
  test("waits for the mounted app page and preserves timed launch/stream/liveness evidence", async () => {
    const { result, events, leftover, artifact } = await runSmoke({ mode: "early-then-mounted", timeout: 10 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.ok(events.indexOf("stream-start") >= 0 && events.indexOf("stream-start") < events.indexOf("launch"), "app stream must start before launch");
    // Both PID sources publish within the first poll or two; their relative order is not part of the contract.
    const timeline = artifact("launch-timeline.log");
    assert.match(timeline, /^launch requested \S+Z$/m);
    assert.match(timeline, /^simctl launch pid \d+ observed \S+Z$/m);
    assert.match(timeline, /^pid \d+ observed \S+Z$/m);
    assert.match(artifact("app-unified-stream.log"), /EXO_WEB_APP_READY/);
    assert.match(artifact("summary.md"), /- \[x\] React mounted into #root/);
    assert.ok(artifact("liveness.log").trim().split("\n").length >= 2, "keep polling after the first probe through the deadline");
    for (const name of ["app-unified-stream.log", "unified.log", "console.log", "summary.md"]) {
      assert.doesNotMatch(artifact(name), /SENSITIVE_FAKE_USER_CONTENT/, name + " must be public-safe");
    }
    assert.deepEqual(leftover, [], "a finished run leaves no private logs behind");
  });

  test("reports an app exit after a successful early probe instead of passing on the first line", async () => {
    const { result, artifact } = await runSmoke({ mode: "mounted", exitWhen: aliveLine, timeout: 30 });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(artifact("liveness.log"), /pid \d+.*(exited|disappeared)/);
    assert.match(artifact("summary.md"), /app exited|app process disappeared|app process exited/);
  });

  test("timestamps and detects the simctl PID exit even without a launchctl job", async () => {
    const { result, artifact } = await runSmoke({ mode: "none", hideLaunchctl: true, exitWhen: aliveLine, timeout: 30 });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(artifact("launch-timeline.log"), /simctl launch pid \d+ observed .*Z/);
    assert.match(artifact("liveness.log"), /simctl pid \d+ exited/);
  });

  test("does not waive the original deadline when navigation never mounts", async () => {
    const { result, artifact } = await runSmoke({ mode: "none", timeout: 3 });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(artifact("summary.md"), /no EXO_SMOKE probe line within 3s/);
  });

  test("a mounted probe emitted after the deadline remains a failure", async () => {
    const { result, artifact } = await runSmoke({ mode: "late-mounted", timeout: 2 });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(artifact("summary.md"), /no EXO_SMOKE probe line within 2s/);
  });

  test("sanitized artifacts and CI output reject a marker-bearing non-timestamp prefix", async () => {
    const { result, artifact } = await runSmoke({ mode: "mounted", badPrefix: true });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    for (const content of [artifact("console.log"), artifact("summary.md"), result.stdout, result.stderr]) {
      assert.doesNotMatch(content, /FAKE-PRIVATE-ABCD/, "synthetic non-timestamp prefix escaped");
    }
    assert.match(artifact("console.log"), /timestamp-unavailable EXO_WEB_APP_READY/);
  });

  test("crash still fails without publishing raw report contents", async () => {
    const { result, artifact } = await runSmoke({ mode: "mounted", crash: true });
    assert.equal(result.status, 1, "a crash report must fail the smoke");
    assert.equal(artifact("crashes/App-synthetic.ips"), "", "raw crash report must not be published");
    assert.match(artifact("crash-reports.txt"), /^count=1$/m);
    assert.doesNotMatch(artifact("summary.md") + result.stdout, /SYNTHETIC_CRASH_PRIVATE/);
  });

  test("timestamps the actual delayed simctl PID despite a slow launchctl response", async () => {
    const { result, artifact } = await runSmoke({ mode: "mounted", pidDelayMs: 3000, launchctlStallMs: 5000, timeout: 12 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const timeline = artifact("launch-timeline.log");
    const launch = timeline.match(/launch requested (\S+)/);
    const reported = timeline.match(/simctl launch pid (\d+) observed (\S+)/);
    assert.ok(launch && reported, "record the delayed simctl bundle: PID output");
    // One-second epochs: a 3 s emission delay can show as 2 s at worst.
    assert.ok(epochMs(reported[2]) - epochMs(launch[1]) >= 2000, "the PID cannot be observed before it was reported");
  });

  test("records a fixed unavailable class without confusing launchctl PID for simctl", async () => {
    const { result, artifact } = await runSmoke({ mode: "mounted", simctlPid: "absent" });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const timeline = artifact("launch-timeline.log");
    assert.match(timeline, /pid \d+ observed .*Z/);
    assert.match(timeline, /simctl launch pid not reported/);
    assert.doesNotMatch(timeline, /simctl launch pid \d+ observed/);
  });

  test("slow launchctl and probe work cannot starve real liveness samples", async () => {
    const { result, artifact } = await runSmoke({ mode: "early-then-mounted", launchctlStallMs: 5000, probeStallSeconds: 4, timeout: 14 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const times = [...artifact("liveness.log").matchAll(/^(\S+) (?:simctl )?pid \d+ alive$/gm)].map((match) => epochMs(match[1]));
    assert.ok(times.length >= 3, "the independent watcher must retain actual samples");
    for (const stage of ["main.launchctl-list", "main.probe-parse"]) {
      const row = artifact("stage-timings.log").split("\n").find((line) =>
        line.startsWith(stage + " ") && /duration_s=[4-9]$/.test(line));
      assert.ok(row, `${stage} must actually block while the watcher runs`);
      const [, start, end] = row.match(/start_epoch_s=(\d+) end_epoch_s=(\d+)/).map(Number);
      assert.ok(times.some((time) => time >= start * 1000 && time <= end * 1000 + 999),
        `at least one real PID-alive sample must overlap ${stage}`);
    }
  });

  test("a slow probe cannot accept a mounted page past the original deadline", async () => {
    const { result, artifact } = await runSmoke({ mode: "early-then-mounted", probeStallSeconds: 4, timeout: 5 });
    assert.equal(result.status, 1, "a late probe must not extend the deadline");
    assert.match(artifact("summary.md"), /no EXO_SMOKE probe line within 5s/);
  });

  test("slow simctl PID scanning cannot starve an independent liveness watcher", async () => {
    const { result, artifact } = await runSmoke({ mode: "mounted", simctlPid: "absent", awkStallCall: 2, awkStallSeconds: 5, timeout: 12 });
    assert.equal(result.status, 0, artifact("summary.md").includes("liveness observation gap") ? "PID scan stalled liveness" : result.stdout + result.stderr);
    assert.match(artifact("launch-timeline.log"), /simctl launch pid not reported/);
    const observations = [...artifact("liveness.log").matchAll(/^(\S+) pid \d+ alive$/gm)].map((match) => epochMs(match[1]));
    assert.ok(observations.length >= 3, "continue real app PID observations through the deadline");
    // A starved watcher would show a gap of at least the 5 s stall plus its own 2 s sleep.
    for (let index = 1; index < observations.length; index++) {
      assert.ok(observations[index] - observations[index - 1] < 7000, "PID scan starved liveness");
    }
  });

  test("signed C: unchanged identity survives a six-second gap with diagnostics only", async () => {
    const { result, artifact } = await runSmoke({
      mode: "mounted", kernelStart: "valid", heartbeatShellStall: true,
      heartbeatStallCall: 3, heartbeatStallSeconds: 6, timeout: 16,
    });
    assert.match(artifact("../heartbeat-stall.log"), /^heartbeat-shell-read duration_s=[6-9]/);
    const gap = artifact("liveness.log").match(/diagnostic observation gap (\d+)s/);
    assert.ok(gap && Number(gap[1]) > 5 && Number(gap[1]) <= 30, "the stall is recorded as a diagnostic gap, not a failure");
    assert.match(artifact("launch-timeline.log"), /start-time source kernel-us/);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.doesNotMatch(artifact("summary.md"), /liveness observation gap exceeded/);
  });

  test("signed C: a post-publication gap above the hard limit remains a failure", async () => {
    // The 30 s production limit is SMOKE_GAP_FAIL_S; 8 s keeps the same code path fast.
    const { result, artifact } = await runSmoke({
      mode: "mounted", simctlPid: "absent", heartbeatShellStall: true,
      heartbeatStallCall: 3, heartbeatStallSeconds: 10, gapFailSeconds: 8, timeout: 18,
    });
    assert.match(artifact("../heartbeat-stall.log"), /^heartbeat-shell-read duration_s=1[0-3]/);
    assert.equal(result.status, 1);
    const gap = artifact("liveness.log").match(/observation gap (\d+)s/);
    assert.ok(gap && Number(gap[1]) > 8, "the real gap is recorded");
    assert.match(artifact("summary.md"), /liveness observation gap exceeded 8s/);
  });

  test("signed C: an exit during a long watcher interval fails as an app exit", async () => {
    const { result, artifact } = await runSmoke({
      mode: "mounted", simctlPid: "absent", preserveLaunchctlPid: true,
      exitWhen: { file: "../heartbeat-stall.started", pattern: "" },
      heartbeatShellStall: true, heartbeatStallCall: 3, heartbeatStallSeconds: 6, timeout: 20,
    });
    assert.match(artifact("../heartbeat-stall.log"), /^heartbeat-shell-read duration_s=[6-9]/);
    assert.equal(result.status, 1);
    assert.match(artifact("liveness.log"), /pid \d+ exited/);
    assert.match(artifact("summary.md"), /app process exited during liveness/);
  });

  test("signed C: missing start time at first publication cannot be repaired later", async () => {
    const { result, artifact } = await runSmoke({ mode: "mounted", simctlPid: "absent", psMissingStartCall: 1 });
    assert.equal(result.status, 1);
    assert.match(artifact("summary.md"), /process start time unavailable at PID publication/);
    assert.match(artifact("launch-timeline.log"), /start-time unavailable at publication/);
  });

  test("signed C: coarse fallback without elapsed telemetry cannot bind identity", async () => {
    const { result, artifact } = await runSmoke({ mode: "mounted", simctlPid: "absent", psMissingEtimeCall: 1 });
    assert.equal(result.status, 1);
    assert.match(artifact("summary.md"), /process start time unavailable at PID publication/);
    assert.match(artifact("launch-timeline.log"), /start-time unavailable at publication/);
  });

  test("signed C: missing start time during an observation fails without a source switch", async () => {
    const { result, artifact } = await runSmoke({ mode: "mounted", simctlPid: "absent", psMissingStartCall: 3, timeout: 10 });
    assert.equal(result.status, 1);
    assert.match(artifact("summary.md"), /process start time unavailable during liveness/);
  });

  test("signed C: the same PID with a different kernel start time fails identity", async () => {
    const { result, artifact } = await runSmoke({ mode: "mounted", kernelStart: "valid", changeWhen: aliveLine, timeout: 20 });
    assert.match(artifact("launch-timeline.log"), /start-time source kernel-us/);
    assert.equal(result.status, 1, "PID reuse must not count as continuity");
    assert.match(artifact("summary.md"), /app process identity changed/);
    assert.match(artifact("liveness.log"), /pid \d+ identity changed/);
  });

  test("signed C: terminal settle checks the original PID and start-time pair", async () => {
    // The identity changes only after the watcher has finished (the anchor line is written after it), so only the
    // terminal settle check can notice.
    const { result, artifact } = await runSmoke({
      mode: "mounted", kernelStart: "valid", changeWhen: { file: "launch-timeline.log", pattern: "start-time source" },
      timeout: 6, settle: 2,
    });
    assert.match(artifact("liveness.log"), /pid \d+ alive/);
    assert.doesNotMatch(artifact("liveness.log"), /identity changed/, "the watcher had already finished");
    assert.equal(result.status, 1, "a new process at terminal settle is not the launched app");
    assert.match(artifact("summary.md"), /app process identity changed/);
  });

  test("signed C: the kernel start time ignores tv_usec padding and falls back when tv_usec is out of range", async () => {
    // The fake kinfo_proc has int32 tv_usec followed by non-zero padding, as on Darwin.
    const [valid, invalid] = await Promise.all([
      runSmoke({ mode: "mounted", kernelStart: "valid" }),
      runSmoke({ mode: "mounted", kernelStart: "invalid-usec" }),
    ]);
    assert.equal(valid.result.status, 0, valid.result.stdout + valid.result.stderr);
    assert.match(valid.artifact("launch-timeline.log"), /start-time source kernel-us/);
    assert.equal(invalid.result.status, 0, invalid.result.stdout + invalid.result.stderr);
    assert.match(invalid.artifact("launch-timeline.log"), /start-time source ps-lstart-etime-coarse/);
  });

  test("signed C: later verified PID source cannot reset the earliest identity", async () => {
    const { result, artifact } = await runSmoke({
      mode: "mounted", kernelStart: "valid", pidDelayMs: 1000, launchctlStallMs: 3500, timeout: 12,
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const timeline = artifact("launch-timeline.log");
    assert.match(timeline, /simctl launch pid \d+ observed/);
    assert.match(timeline, /^pid \d+ observed/m);
    assert.equal((timeline.match(/start-time source kernel-us/g) ?? []).length, 1,
      "the later source cannot select a second identity baseline");
    assert.match(artifact("liveness.log"), /pid \d+ alive/);
  });

  test("a later kernel-capable publisher retains the earlier coarse identity source", async () => {
    // launchctl publishes first (kernel call 1 is unavailable), simctl's PID is only reported later.
    const { result, artifact } = await runSmoke({
      mode: "mounted", kernelStart: "valid", kernelAvailableCall: 2, pidDelayMs: 5500, timeout: 14,
    });
    const timeline = artifact("launch-timeline.log");
    assert.match(timeline, /^pid \d+ observed \S+/m);
    assert.match(timeline, /simctl launch pid \d+ observed/);
    assert.match(timeline, /start-time source ps-lstart-etime-coarse/,
      "the earliest valid fallback representation is retained for the run");
    assert.doesNotMatch(artifact("summary.md"), /app process identity changed/);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });

  test("both publishers before the first watcher read still select earliest coarse source", async () => {
    const { result, artifact } = await runSmoke({
      mode: "mounted", kernelStart: "valid", kernelAvailableCall: 2, pidDelayMs: 5500,
      heartbeatShellStall: true, heartbeatStallCall: 1, heartbeatStallSeconds: 9, timeout: 18,
    });
    const timeline = artifact("launch-timeline.log");
    assert.match(artifact("../heartbeat-stall.log"), /heartbeat-shell-read duration_s=[9]/);
    assert.match(timeline, /^pid \d+ observed \S+/m);
    assert.match(timeline, /simctl launch pid \d+ observed/);
    assert.match(timeline, /start-time source ps-lstart-etime-coarse/);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });

  test("established kernel identity must fail closed when the kernel source disappears", async () => {
    const { result, artifact } = await runSmoke({
      mode: "mounted", kernelStart: "valid", kernelMissingCall: 2, hideLaunchctl: true, timeout: 10,
    });
    assert.match(artifact("launch-timeline.log"), /start-time source kernel-us/);
    assert.equal(result.status, 1);
    assert.match(artifact("summary.md"), /process start time unavailable during liveness/);
  });

  test("a distinct second-source PID cannot inherit the earlier process identity", async () => {
    const { result, artifact } = await runSmoke({
      mode: "mounted", kernelStart: "valid", simctlDifferentPid: true, pidDelayMs: 3500, timeout: 12,
    });
    const timeline = artifact("launch-timeline.log");
    const launchctl = timeline.match(/^pid (\d+) observed/m);
    const simctl = timeline.match(/simctl launch pid (\d+) observed/);
    assert.ok(launchctl && simctl && launchctl[1] !== simctl[1],
      "two independently qualified sources report different PIDs without signalling host processes");
    assert.equal(result.status, 1);
    assert.match(artifact("summary.md"), /app process identity changed/);
  });

  test("signed D: a slow process call is timed against the independent bare clock", async () => {
    const { result, artifact } = await runSmoke({
      mode: "mounted", simctlPid: "absent", psStallCall: 2, psStallSeconds: 4, timeout: 12,
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
  });

  test("signed D: every stage exposes sanitized wall endpoints and the bare clock samples", async () => {
    const { result, artifact } = await runSmoke({ mode: "mounted", simctlPid: "absent" });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const lines = artifact("stage-timings.log").trim().split("\n");
    assert.ok(lines.every((line) => /^[a-z][a-z.-]* start_epoch_s=\d+ end_epoch_s=\d+ duration_s=\d+$/.test(line)),
      "every stage needs fixed structural wall endpoints and duration only");
    assert.match(artifact("clock-diagnostic.log"), /^clock start_epoch_s=\d+ end_epoch_s=\d+ duration_s=\d+$/m);
    assert.doesNotMatch(artifact("stage-timings.log") + artifact("clock-diagnostic.log"), /SENSITIVE_FAKE_USER_CONTENT/);
  });

  // Deadline semantics: each stall below ends strictly after the deadline, so the late publication can never count.
  test("does not publish a simctl PID discovered only after the unchanged deadline", async () => {
    const { result, artifact } = await runSmoke({ mode: "mounted", pidDelayMs: 1000, awkStallCall: 1, awkStallSeconds: 10, timeout: 8 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(artifact("launch-timeline.log"), /simctl launch pid not reported/);
    assert.doesNotMatch(artifact("launch-timeline.log"), /simctl launch pid \d+ observed/);
    assert.match(artifact("launch-timeline.log"), /pid \d+ observed/);
    assert.match(artifact("liveness.log"), /^.* pid \d+ alive$/m, "on-time launchctl PID must still prove app liveness");
  });

  test("a launchctl PID first returned after the deadline cannot qualify a bounded mounted fallback", async () => {
    const { result, artifact } = await runSmoke({
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

  test("neither PID source arriving after deadline can create an in-window alive observation", async () => {
    const { result, artifact } = await runSmoke({
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

  test("a first positive process check after deadline cannot become in-window liveness proof", async () => {
    const { result, artifact } = await runSmoke({
      mode: "mounted", simctlPid: "absent", psStallCall: 2, psStallSeconds: 4, timeout: 5,
    });
    const timeline = artifact("launch-timeline.log");
    const launch = timeline.match(/launch requested (\S+)/);
    const firstAlive = artifact("liveness.log").match(/^(\S+) pid \d+ alive$/m);
    assert.match(timeline, /^pid \d+ observed/m, "the app PID must be known before the deadline");
    assert.match(timeline, /mounted app-page probe observed/, "the mounted probe must precede the deadline");
    assert.ok(launch && firstAlive && epochMs(firstAlive[1]) - epochMs(launch[1]) >= 5000 - 999,
      "the first successful process check completes after the deadline");
    assert.match(artifact("stage-timings.log"), /heartbeat\.pid-check start_epoch_s=\d+ end_epoch_s=\d+ duration_s=[3-5]/);
    assert.equal(result.status, 1);
    assert.match(artifact("summary.md"), /no app PID-alive observation before probe deadline/);
  });

  test("a completed simctl rename after deadline cannot publish beside an on-time launchctl proof", async () => {
    const { result, artifact } = await runSmoke({ mode: "mounted", simctlRenameStallSeconds: 12, timeout: 9 });
    const timeline = artifact("launch-timeline.log");
    assert.match(timeline, /^pid \d+ observed \S+/m, "launchctl still supplies on-time PID");
    assert.match(artifact("liveness.log"), /^\S+ pid \d+ alive$/m, "on-time identity actually observed");
    assert.match(timeline, /mounted app-page probe observed/);
    assert.match(timeline, /simctl launch pid not reported/, "late rename never becomes an accepted publication");
    assert.doesNotMatch(timeline, /simctl launch pid \d+ observed/, "late PID cannot be backdated");
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });

  test("a completed launchctl rename after deadline cannot publish beside an on-time simctl proof", async () => {
    const { result, artifact } = await runSmoke({
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

  // Atomic publication and cleanup.
  test("a .ready completion marker is only ever created by renaming a complete file", async () => {
    const { result, artifact } = await runSmoke({ mode: "mounted", kernelStart: "valid", pidDelayMs: 1000, timeout: 10 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const renames = artifact("../ready-spy").trim().split("\n");
    assert.equal(renames.length, 2, "both sources publish through a rename");
    for (const line of renames) {
      assert.match(line, /^src=(?:simctl|launchctl)\.ready\.tmp\.\d+ dst_visible=0 content=\d+ \d+$/,
        "the marker is complete in a temp file before it can appear under its final name");
    }
  });

  for (const [name, expected] of [["SIGINT", 130], ["SIGTERM", 143]]) {
    test(`${name} mid-run terminates the app, the launcher and every worker, and removes private logs`, async () => {
      const { result, events, leftover, processesGone, artifact } = await runSmoke({
        mode: "mounted", kernelStart: "valid", timeout: 60, trackProcesses: true,
        signalWhen: { ...aliveLine, signal: name },
      });
      assert.equal(result.status, expected, result.stdout + result.stderr);
      assert.ok(events.includes("terminate"), "the app is terminated in the simulator");
      assert.deepEqual(processesGone, [], "no launcher, log stream, worker child or sleep survives");
      assert.deepEqual(leftover, [], "private logs, including any held publication lock, are removed");
      assert.doesNotMatch(artifact("summary.md"), /\S/, "an interrupted run writes no summary");
    });
  }

  test("SIGINT while a publisher holds the publication lock still removes everything", async () => {
    // The spy line is written just before the stalled .ready rename, which happens inside the publication lock.
    const { result, artifact, leftover, processesGone } = await runSmoke({
      mode: "mounted", kernelStart: "valid", timeout: 60, trackProcesses: true, simctlReadyStallSeconds: 30,
      signalWhen: { file: "../ready-spy", pattern: "simctl\\.ready", signal: "SIGINT" },
    });
    assert.equal(result.status, 130, result.stdout + result.stderr);
    assert.match(artifact("../ready-spy"), /^src=simctl\.ready\.tmp\.\d+ /m, "the publisher was mid-commit");
    assert.deepEqual(processesGone, [], "the stalled rename and its sleep are stopped");
    assert.deepEqual(leftover, [], "the held lock is released with the private logs");
  });
});
