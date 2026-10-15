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
} else if (op === 'io' && args[3] === 'screenshot') {
  fs.writeFileSync(args[4], 'fake screenshot');
} else if (op === 'terminate') {
  const pidFile = path.join(state, 'pid');
  if (fs.existsSync(pidFile)) {
    try { process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 'SIGTERM'); } catch {}
  }
}
`;

function runSmoke({ mode, exitAfterMs, hideLaunchctl = false, badPrefix = false, crash = false, simctlPid = "immediate", pidDelayMs = 0, launchctlStallMs = 0, probeStallSeconds = 0, psStallCall = 0, psStallSeconds = 6, awkStallCall = 0, timeout = 6 }) {
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
  writeFileSync(join(bin, "awk"), "#!/bin/sh\ncase \"$*\" in\n  *app=xyz.tinycloud.exo:*)\n    if [ -n \"$FAKE_AWK_STALL_CALL\" ]; then\n      n=0\n      if [ -f \"$FAKE_SIM_STATE/awk-count\" ]; then read -r n < \"$FAKE_SIM_STATE/awk-count\"; fi\n      n=$((n + 1))\n      printf '%s\\n' \"$n\" > \"$FAKE_SIM_STATE/awk-count\"\n      if [ \"$n\" -eq \"$FAKE_AWK_STALL_CALL\" ]; then sleep 4; fi\n    fi ;;\nesac\nPATH=${PATH#*:} exec awk \"$@\"\n");
  chmodSync(join(bin, "awk"), 0o755);
  const env = {
    ...process.env, PATH: bin + ":" + process.env.PATH, HOME: dir, FAKE_SIM_STATE: dir,
    FAKE_PROBE_MODE: mode, FAKE_GOOD_PROBE: JSON.stringify(goodProbe),
    FAKE_EARLY_PROBE: JSON.stringify(earlyProbe),
    FAKE_EXIT_AFTER_MS: exitAfterMs ? String(exitAfterMs) : "",
    FAKE_HIDE_LAUNCHCTL: hideLaunchctl ? "1" : "0",
    FAKE_BAD_PREFIX: badPrefix ? "1" : "0",
    FAKE_CRASH: crash ? "1" : "0",
    FAKE_SIMCTL_PID: simctlPid, FAKE_SIMCTL_PID_DELAY_MS: String(pidDelayMs),
    FAKE_LAUNCHCTL_STALL_MS: String(launchctlStallMs || ""),
    FAKE_PROBE_STALL_SECONDS: String(probeStallSeconds || ""),
    FAKE_PS_STALL_CALL: String(psStallCall || ""),
    FAKE_PS_STALL_SECONDS: String(psStallSeconds),
    FAKE_AWK_STALL_CALL: String(awkStallCall || ""),
    EXO_CAPTURE_SMOKE: "0", EXO_LOCATION_SMOKE: "0",
    SMOKE_TIMEOUT: String(timeout), SMOKE_SETTLE: "0",
  };
  try {
    const result = spawnSync("bash", [smoke, "run", app, out], { env, timeout: 30000, encoding: "utf8" });
    const artifact = (name) => { try { return readFileSync(join(out, name), "utf8"); } catch { return ""; } };
    const files = ["../events", "launch-timeline.log", "liveness.log", "stage-timings.log", "app-unified-stream.log", "unified.log", "console.log", "summary.md", "crashes/App-synthetic.ips", "crash-reports.txt"];
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
  const { result, artifact } = runSmoke({ mode: "mounted", psStallCall: 2, timeout: 5 });
  assert.equal(result.status, 1, "a stalled watcher cannot claim complete instrumentation");
  assert.match(artifact("liveness.log"), /observation gap \d+s/);
  assert.match(artifact("summary.md"), /liveness observation gap exceeded 5s/);
});

test("a four-second final ps stall exposes the actual sleep-plus-stall gap", { timeout: 30000 }, () => {
  const { result, artifact } = runSmoke({ mode: "mounted", psStallCall: 2, psStallSeconds: 4, timeout: 5 });
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

test("does not publish a simctl PID discovered only after the unchanged deadline", { timeout: 30000 }, () => {
  const { result, artifact } = runSmoke({ mode: "mounted", pidDelayMs: 1000, awkStallCall: 1, timeout: 3 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(artifact("launch-timeline.log"), /simctl launch pid not reported/);
  assert.doesNotMatch(artifact("launch-timeline.log"), /simctl launch pid \d+ observed/);
  assert.match(artifact("launch-timeline.log"), /pid \d+ observed/);
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
