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
  console.log('xyz.tinycloud.exo: ' + process.pid);
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

function runSmoke({ mode, exitAfterMs, hideLaunchctl = false, badPrefix = false, crash = false, timeout = 6 }) {
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
  const env = {
    ...process.env, PATH: bin + ":" + process.env.PATH, HOME: dir, FAKE_SIM_STATE: dir,
    FAKE_PROBE_MODE: mode, FAKE_GOOD_PROBE: JSON.stringify(goodProbe),
    FAKE_EARLY_PROBE: JSON.stringify(earlyProbe),
    FAKE_EXIT_AFTER_MS: exitAfterMs ? String(exitAfterMs) : "",
    FAKE_HIDE_LAUNCHCTL: hideLaunchctl ? "1" : "0",
    FAKE_BAD_PREFIX: badPrefix ? "1" : "0",
    FAKE_CRASH: crash ? "1" : "0",
    EXO_CAPTURE_SMOKE: "0", EXO_LOCATION_SMOKE: "0",
    SMOKE_TIMEOUT: String(timeout), SMOKE_SETTLE: "0",
  };
  try {
    const result = spawnSync("bash", [smoke, "run", app, out], { env, timeout: 20000, encoding: "utf8" });
    const artifact = (name) => { try { return readFileSync(join(out, name), "utf8"); } catch { return ""; } };
    const files = ["../events", "launch-timeline.log", "liveness.log", "app-unified-stream.log", "unified.log", "console.log", "summary.md", "crashes/App-synthetic.ips", "crash-reports.txt"];
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
