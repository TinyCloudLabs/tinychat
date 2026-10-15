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
    if (delay) setTimeout(() => console.log('xyz.tinycloud.exo: ' + process.pid), delay);
    else console.log('xyz.tinycloud.exo: ' + process.pid);
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
  setInterval(() => {}, 1000);
} else if (op === 'spawn' && args[3] === 'launchctl') {
  const stallFile = path.join(state, 'launchctl-stalled');
  if (process.env.FAKE_LAUNCHCTL_STALL_MS && !fs.existsSync(stallFile)) {
    fs.writeFileSync(stallFile, '1');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.FAKE_LAUNCHCTL_STALL_MS));
  }
  const pidFile = path.join(state, 'pid');
  if (fs.existsSync(pidFile) && !fs.existsSync(path.join(state, 'exited')) && process.env.FAKE_HIDE_LAUNCHCTL !== '1') {
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    try { process.kill(pid, 0); console.log(pid + ' 0 UIKitApplication:xyz.tinycloud.exo[0]'); } catch {}
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

function runSmoke({ mode, exitAfterMs, hideLaunchctl = false, badPrefix = false, crash = false, simctlPid = "immediate", pidDelayMs = 0, launchctlStallMs = 0, fallbackMounted = false, heartbeatShellStall = false, heartbeatStallCall = 2, heartbeatStallSeconds = 6, recordShellStall = false, recordStallSeconds = 8, formatShellStall = false, formatStallSeconds = 8, probeStallSeconds = 0, psStallCall = 0, psStallSeconds = 6, awkStallCall = 0, awkStallSeconds = 4, timeout = 6 }) {
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
  writeFileSync(join(bin, "plutil"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(bin, "plutil"), 0o755);
  writeFileSync(join(bin, "grep"), "#!/bin/sh\nif [ \"$1\" = -a ] && [ \"$2\" = 'EXO_SMOKE ' ] && [ -n \"$FAKE_PROBE_STALL_SECONDS\" ]; then sleep \"$FAKE_PROBE_STALL_SECONDS\"; fi\nPATH=${PATH#*:} exec grep \"$@\"\n");
  chmodSync(join(bin, "grep"), 0o755);
  writeFileSync(join(bin, "ps"), "#!/bin/sh\nif [ -n \"$FAKE_PS_STALL_CALL\" ]; then\n  n=0\n  if [ -f \"$FAKE_SIM_STATE/ps-count\" ]; then read -r n < \"$FAKE_SIM_STATE/ps-count\"; fi\n  n=$((n + 1))\n  printf '%s\\n' \"$n\" > \"$FAKE_SIM_STATE/ps-count\"\n  if [ \"$n\" -eq \"$FAKE_PS_STALL_CALL\" ]; then sleep \"$FAKE_PS_STALL_SECONDS\"; fi\nfi\nPATH=${PATH#*:} exec ps \"$@\"\n");
  chmodSync(join(bin, "ps"), 0o755);
  writeFileSync(join(bin, "awk"), "#!/bin/sh\ncase \"$*\" in\n  *app=xyz.tinycloud.exo:*)\n    if [ -n \"$FAKE_AWK_STALL_CALL\" ]; then\n      n=0\n      if [ -f \"$FAKE_SIM_STATE/awk-count\" ]; then read -r n < \"$FAKE_SIM_STATE/awk-count\"; fi\n      n=$((n + 1))\n      printf '%s\\n' \"$n\" > \"$FAKE_SIM_STATE/awk-count\"\n      if [ \"$n\" -eq \"$FAKE_AWK_STALL_CALL\" ]; then sleep \"$FAKE_AWK_STALL_SECONDS\"; fi\n    fi ;;\nesac\nPATH=${PATH#*:} exec awk \"$@\"\n");
  chmodSync(join(bin, "awk"), 0o755);
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
    FAKE_LAUNCHCTL_STALL_MS: String(launchctlStallMs || ""),
    FAKE_FALLBACK_MOUNTED: fallbackMounted ? "1" : "0",
    FAKE_PROBE_STALL_SECONDS: String(probeStallSeconds || ""),
    FAKE_PS_STALL_CALL: String(psStallCall || ""),
    FAKE_PS_STALL_SECONDS: String(psStallSeconds),
    FAKE_AWK_STALL_CALL: String(awkStallCall || ""),
    FAKE_AWK_STALL_SECONDS: String(awkStallSeconds),
    EXO_CAPTURE_SMOKE: "0", EXO_LOCATION_SMOKE: "0",
    SMOKE_TIMEOUT: String(timeout), SMOKE_SETTLE: "0",
  };
  try {
    const result = spawnSync("bash", [smoke, "run", app, out], { env, timeout: 30000, encoding: "utf8" });
    const artifact = (name) => { try { return readFileSync(join(out, name), "utf8"); } catch { return ""; } };
    const files = ["../heartbeat-stall.log", "../record-stall.log", "../format-stall.log", "../events", "launch-timeline.log", "liveness.log", "stage-timings.log", "app-unified-stream.log", "unified.log", "console.log", "summary.md", "crashes/App-synthetic.ips", "crash-reports.txt"];
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
  assert.match(artifact("summary.md"), /app exited|app process disappeared/);
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
  const { result, artifact } = runSmoke({ mode: "early-then-mounted", launchctlStallMs: 5000, probeStallSeconds: 4, timeout: 13 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const times = [...artifact("liveness.log").matchAll(/^(\S+) (?:simctl )?pid \d+ alive$/gm)].map((match) => Date.parse(match[1]));
  assert.ok(times.length >= 5, "the independent watcher must retain actual samples");
  for (let index = 1; index < times.length; index++) {
    assert.ok(times[index] - times[index - 1] <= 5000, "liveness observation gap exceeded five seconds");
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

test("an end-of-deadline watcher stall cannot be reported as complete liveness", { timeout: 30000 }, () => {
  const { result, artifact } = runSmoke({ mode: "mounted", psStallCall: 2, timeout: 7 });
  assert.equal(result.status, 1, "a stalled watcher cannot claim complete instrumentation");
  assert.match(artifact("liveness.log"), /observation gap \d+s/);
  assert.match(artifact("liveness.log").split(/observation gap \d+s/)[0], /pid \d+ alive/,
    "an actual alive sample must precede the stalled final process check");
  assert.match(artifact("stage-timings.log"), /heartbeat\.pid-check duration_s=[6-9]/);
  assert.match(artifact("summary.md"), /liveness observation gap exceeded 5s/);
});

test("a four-second final ps stall exposes the actual sleep-plus-stall gap", { timeout: 30000 }, () => {
  const { result, artifact } = runSmoke({ mode: "mounted", psStallCall: 2, psStallSeconds: 4, timeout: 7 });
  const liveness = artifact("liveness.log");
  const observations = [...liveness.matchAll(/^(\S+) (?:simctl )?pid \d+ alive$/gm)].map((match) => Date.parse(match[1]));
  assert.ok(observations.some((time, index) => index > 0 && time - observations[index - 1] > 5000),
    "fixture must create a gap between completed alive observations");
  assert.equal(result.status, 1, "the watcher must not pass an actual gap over five seconds");
  assert.match(liveness, /observation gap \d+s/);
  assert.match(artifact("summary.md"), /liveness observation gap exceeded 5s/);
  assert.match(artifact("stage-timings.log"), /heartbeat\.pid-check duration_s=[4-9]/,
    "the real blocking process check must be measured independently");
  assert.match(artifact("stage-timings.log"), /heartbeat duration_s=[6-9]/,
    "the whole stalled heartbeat must expose its elapsed wall time");
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
  assert.doesNotMatch(artifact("summary.md"), /liveness observation gap exceeded 5s/);
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
  assert.doesNotMatch(artifact("summary.md"), /liveness observation gap exceeded 5s/);
});

test("a genuine six-second Bash heartbeat stall keeps the hard liveness failure", { timeout: 30000 }, () => {
  const { result, artifact } = runSmoke({
    mode: "mounted", simctlPid: "absent", heartbeatShellStall: true, heartbeatStallCall: 3, timeout: 13,
  });
  assert.match(artifact("../heartbeat-stall.log"), /^heartbeat-shell-read duration_s=[6-9]/);
  assert.equal(result.status, 1, "a stalled heartbeat cannot claim complete liveness");
  assert.match(artifact("liveness.log"), /observation gap [6-9]s/);
  const observations = [...artifact("liveness.log").matchAll(/^(\S+) (?:simctl )?pid (?:not yet observed|\d+ alive)$/gm)]
    .map((match) => Date.parse(match[1]));
  assert.ok(observations.some((time, index) => index > 0 && time - observations[index - 1] > 5000),
    "the gap must be between actual completed observations, not attempted heartbeats");
  assert.match(artifact("liveness.log").split(/observation gap \d+s/)[0], /pid \d+ alive/,
    "a verified app PID must have been alive before the watcher stalls");
  assert.match(artifact("summary.md"), /liveness observation gap exceeded 5s/);
});

test("PID published during watcher stall starts hard cadence before first alive", { timeout: 30000 }, () => {
  const { result, artifact } = runSmoke({
    mode: "mounted", simctlPid: "absent", launchctlStallMs: 1000,
    heartbeatShellStall: true, heartbeatStallCall: 2, timeout: 13,
  });
  const timeline = artifact("launch-timeline.log");
  const liveness = artifact("liveness.log");
  const published = timeline.match(/^pid \d+ observed (\S+)/m);
  const gap = liveness.match(/^(\S+) observation gap (\d+)s$/m);
  assert.ok(published && gap && Date.parse(gap[1]) - Date.parse(published[1]) > 5000,
    "verified PID publication must precede the completed >5s gap");
  assert.doesNotMatch(liveness.split(/observation gap \d+s/)[0], /pid \d+ alive/,
    "the first alive sample alone cannot start the strict clock");
  assert.match(liveness, /pid \d+ alive/);
  assert.equal(result.status, 1);
  assert.match(artifact("summary.md"), /liveness observation gap exceeded 5s/);
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
  assert.equal(result.status, 1, "a later alive sample cannot erase the post-publication stall");
  const hardGap = liveness.match(/^(\S+) observation gap ([6-9])s$/m);
  assert.ok(hardGap && Date.parse(hardGap[1]) === Date.parse(first[1])
    && liveness.indexOf(hardGap[0]) < liveness.indexOf(first[0]),
    `the first completed observation must classify the post-publication interval: ${liveness}; stages: ${artifact("stage-timings.log")}`);
  assert.match(artifact("summary.md"), /liveness observation gap exceeded 5s/);
});

test("pending PID records cannot reset the publication-to-first-alive hard interval", { timeout: 30000 }, () => {
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
    "the pending sample alone must not trip the hard five-second interval");
  assert.ok(Date.parse(alive[1]) - Date.parse(published[1]) > 5000,
    "publication-to-first-real-alive must exceed five seconds despite short individual gaps");
  assert.match(timeline, /mounted app-page probe observed/);
  assert.equal(result.status, 1, "a valid mounted page and later alive check cannot waive publication-to-first-alive");
  assert.match(liveness, /^\S+ PID-alive proof gap [6-9]s$/m);
  assert.match(artifact("summary.md"), /liveness observation gap exceeded 5s/);
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
  assert.doesNotMatch(artifact("liveness.log"), /pid \d+ alive/, "no in-window alive proof exists");
  assert.match(artifact("liveness.log"), /^\S+ observation gap [6-9]s$/m,
    "terminal coverage must classify the real post-publication gap despite no later heartbeat");
  assert.match(artifact("liveness.log"), /^\S+ PID-alive proof gap [6-9]s$/m,
    "missing alive proof must retain publication-to-terminal hard-gap evidence");
  assert.equal(result.status, 1);
  assert.match(artifact("summary.md"), /liveness observation gap exceeded 5s/);
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
    mode: "mounted", simctlPid: "absent", psStallCall: 1, psStallSeconds: 3, timeout: 4,
  });
  const timeline = artifact("launch-timeline.log");
  const launch = timeline.match(/launch requested (\S+)/);
  const alive = artifact("liveness.log").match(/^(\S+) pid \d+ alive$/m);
  assert.match(timeline, /^pid \d+ observed/m, "the app PID must be known before the deadline");
  assert.match(timeline, /mounted app-page probe observed/, "the mounted probe must precede the deadline");
  assert.ok(launch && alive && Date.parse(alive[1]) - Date.parse(launch[1]) >= 4000,
    "the first successful process check must complete after the deadline");
  assert.match(artifact("stage-timings.log"), /heartbeat\.pid-check duration_s=[3-4]/);
  assert.doesNotMatch(artifact("liveness.log"), /observation gap/, "cadence itself stays within five seconds");
  assert.equal(result.status, 1);
  assert.match(artifact("summary.md"), /no app PID-alive observation before probe deadline/);
});

test("publishes only structural duration fields for every heartbeat and blocking stage", { timeout: 30000 }, () => {
  const { result, artifact } = runSmoke({ mode: "mounted", simctlPid: "absent" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const timing = artifact("stage-timings.log");
  const lines = timing.trim().split("\n");
  assert.ok(lines.every((line) => /^[a-z][a-z.-]* duration_s=[0-9]+$/.test(line)),
    "stage timings may contain only stage names and durations");
  for (const stage of ["heartbeat", "heartbeat.sleep", "heartbeat.pid-check", "observer.pid-scan", "main.launchctl-list", "main.probe-parse", "main.unified-log-show"]) {
    assert.ok(lines.some((line) => line.startsWith(stage + " duration_s=")), `missing ${stage} timing`);
  }
  const heartbeatCount = lines.filter((line) => line.startsWith("heartbeat duration_s=")).length;
  assert.equal(heartbeatCount, artifact("liveness.log").trim().split("\n").length,
    "every actual liveness observation needs a wall-time measurement");
});
