// Drives mobile/scripts/ios-frame-probe.sh with a fake xcrun (TC-3677), so it runs on Linux:
// `node --test mobile/scripts/ios-frame-probe.test.mjs`.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";

const script = fileURLToPath(new URL("./ios-frame-probe.sh", import.meta.url));

const frame = (overrides = {}) => ({
  ready: true, bridge: "object", origin: "null", posted: ["ExoFrameProbe.ping", "Preferences.set"],
  open: "null", blankClick: "clicked", topClick: "clicked",
  openHanded: true, blankHanded: true, topHanded: false, ...overrides,
});
const goodProbe = {
  configuration: "Release",
  main: { href: "capacitor://localhost/", answered: true, unchanged: true, marker: true },
  pings: { main: 1, framed: 0 },
  answers: 0,
  stored: { opaque: null, unsandboxed: null, explorer: null },
  frames: {
    opaque: frame(),
    unsandboxed: frame({ origin: "capacitor://localhost", topHanded: true }),
    explorer: frame({ origin: "https://explorer.tinycloud.xyz" }),
  },
  topNavigations: { attempted: 1, allowed: 0 },
  handed: 7,
};
const goodHandoff = { held: 7, url: "https://example.com/exo-frame-probe/opaque/window-open", opened: true, answered: true };
const withProbe = (change) => {
  const probe = structuredClone(goodProbe);
  change(probe);
  return probe;
};

// The fake simulator: `launch` prints FAKE_LINES (a JSON array) a line at a time and stays up until `terminate`,
// unless FAKE_EXIT is set; `io screenshot` writes a file.
const fakeXcrun = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const state = process.env.FAKE_STATE;
const args = process.argv.slice(2);
if (args[0] !== 'simctl') process.exit(2);
const op = args[1];
fs.appendFileSync(path.join(state, 'calls'), args.join(' ') + '\\n');
if (op === 'bootstatus') process.exit(process.env.FAKE_BOOT_FAIL === '1' ? 1 : 0);
if (op === 'install') process.exit(0);
if (op === 'io' && args[3] === 'screenshot') { fs.writeFileSync(args[4], 'fake screenshot'); process.exit(0); }
if (op === 'terminate') {
  try { process.kill(Number(fs.readFileSync(path.join(state, 'pid'), 'utf8')), 'SIGTERM'); } catch {}
  process.exit(0);
}
if (op === 'launch') {
  fs.writeFileSync(path.join(state, 'pid'), String(process.pid));
  console.log('xyz.tinycloud.home: ' + process.pid);
  console.log('SENSITIVE_FAKE_USER_CONTENT');
  const lines = JSON.parse(process.env.FAKE_LINES || '[]');
  let index = 0;
  const next = () => {
    if (index < lines.length) { console.log(lines[index++]); setTimeout(next, 300); return; }
    if (process.env.FAKE_EXIT === '1') process.exit(0);
  };
  setTimeout(next, 300);
  if (process.env.FAKE_CRASH === '1') {
    const reports = path.join(process.env.HOME, 'Library/Logs/DiagnosticReports');
    fs.mkdirSync(reports, { recursive: true });
    fs.writeFileSync(path.join(reports, 'App-synthetic.ips'), 'SYNTHETIC_CRASH_PRIVATE');
  }
  setInterval(() => {}, 1000);
} else {
  process.exit(2);
}
`;

function run({ lines = [], exit = false, crash = false, device = true, timeout = 6, handoffTimeout = 3 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "exo-frame-probe-test-"));
  const bin = join(dir, "bin");
  const app = join(dir, "App.app");
  const out = join(dir, "out");
  for (const path of [bin, app, out]) mkdirSync(path);
  if (device) writeFileSync(join(out, "device.txt"), "com.apple.CoreSimulator.SimRuntime.iOS-26-0 fake-udid iPhone 17\n");
  writeFileSync(join(bin, "xcrun"), fakeXcrun);
  chmodSync(join(bin, "xcrun"), 0o755);
  const env = {
    ...process.env, PATH: bin + ":" + process.env.PATH, HOME: dir, TMPDIR: dir, FAKE_STATE: dir,
    FAKE_LINES: JSON.stringify(lines), FAKE_EXIT: exit ? "1" : "0", FAKE_CRASH: crash ? "1" : "0",
    FRAME_PROBE_TIMEOUT: String(timeout), FRAME_PROBE_HANDOFF_TIMEOUT: String(handoffTimeout),
    FRAME_PROBE_OUTSIDE_SETTLE: "0", GITHUB_STEP_SUMMARY: "",
  };
  return new Promise((resolve) => {
    const child = spawn("bash", [script, app, out], { env });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stdout += chunk; });
    child.on("close", (status) => resolve({ status, stdout, out, dir }));
  });
}

const lines = (probe = goodProbe, handoff = goodHandoff) => [
  "some app output",
  "EXO_FRAME_PROBE " + JSON.stringify(probe),
  ...(handoff ? ["EXO_FRAME_PROBE_HANDOFF " + JSON.stringify(handoff)] : []),
];

describe("ios-frame-probe.sh", { concurrency: true }, () => {
  test("passes a probe with no framed bridge message, no answer, and every link handed to the system", async () => {
    const { status, stdout, out } = await run({ lines: lines() });
    assert.equal(status, 0, stdout);
    assert.match(stdout, /iOS frame probe passed/);
    assert.match(stdout, /^EXO_FRAME_PROBE \{.*"framed":0/m);
    assert.match(stdout, /^EXO_FRAME_PROBE_HANDOFF \{.*"opened":true/m);
    const summary = readFileSync(join(out, "summary.md"), "utf8");
    assert.doesNotMatch(summary, /- \[ \]/);
    assert.match(summary, /Explorer frame: loaded and checked/);
    assert.deepEqual(JSON.parse(readFileSync(join(out, "probe.json"), "utf8")), goodProbe);
    assert.deepEqual(JSON.parse(readFileSync(join(out, "handoff.json"), "utf8")), goodHandoff);
    assert.ok(existsSync(join(out, "one.png")) && existsSync(join(out, "outside.png")));
  });

  test("keeps the app's raw console out of the artifact", async () => {
    const { status, out } = await run({ lines: lines() });
    assert.equal(status, 0);
    for (const name of readdirSync(out)) {
      assert.doesNotMatch(readFileSync(join(out, name), "utf8"), /SENSITIVE_FAKE_USER_CONTENT/, name);
    }
  });

  test("fails when a frame's bridge message reached Capacitor", async () => {
    const probe = withProbe((p) => {
      p.pings.framed = 2;
      p.answers = 4;
      p.stored.opaque = "reached";
      p.stored.unsandboxed = "reached";
    });
    const { status, stdout } = await run({ lines: lines(probe) });
    assert.equal(status, 1);
    assert.match(stdout, /::error::iOS frame probe: 0 bridge messages from a frame reached Capacitor/);
    assert.match(stdout, /::error::iOS frame probe: no plugin answered a frame's call/);
    assert.match(stdout, /::error::iOS frame probe: no Preferences key a frame tried to set was set/);
  });

  test("fails when the counters cannot count (One's own call got no answer)", async () => {
    const probe = withProbe((p) => {
      p.main.answered = false;
      p.pings.main = 0;
    });
    const { status, stdout } = await run({ lines: lines(probe) });
    assert.equal(status, 1);
    assert.match(stdout, /One's own call to the probe plugin reaches native/);
  });

  test("fails a Debug build", async () => {
    const { status, stdout } = await run({ lines: lines(withProbe((p) => { p.configuration = "Debug"; })) });
    assert.equal(status, 1);
    assert.match(stdout, /::error::iOS frame probe: Release build/);
  });

  test("fails when window.open in a frame got a window or was not handed to the system", async () => {
    for (const change of [(p) => { p.frames.explorer.open = "window"; }, (p) => { p.frames.opaque.openHanded = false; },
      (p) => { p.frames.unsandboxed.blankHanded = false; }]) {
      const { status, stdout } = await run({ lines: lines(withProbe(change)) });
      assert.equal(status, 1);
      assert.match(stdout, /window.open and target=_blank links in every frame went to the system browser/);
    }
  });

  test("fails when a frame's target=_top link was not handed to the system", async () => {
    const { status, stdout } = await run({ lines: lines(withProbe((p) => { p.frames.unsandboxed.topHanded = false; })) });
    assert.equal(status, 1);
    assert.match(stdout, /a frame's target=_top link went to the system browser/);
  });

  test("fails when One's main view navigated", async () => {
    for (const change of [(p) => { p.topNavigations.allowed = 1; }, (p) => { p.main.unchanged = false; },
      (p) => { p.main.marker = false; }]) {
      const { status, stdout } = await run({ lines: lines(withProbe(change)) });
      assert.equal(status, 1);
      assert.match(stdout, /::error::iOS frame probe: One's main view never navigated/);
    }
  });

  test("fails when a local frame did not load", async () => {
    const { status, stdout } = await run({ lines: lines(withProbe((p) => { p.frames.opaque = { ready: false }; })) });
    assert.equal(status, 1);
    assert.match(stdout, /the opaque and unsandboxed frames loaded and ran/);
  });

  test("passes with a warning when One's Explorer frame did not load", async () => {
    const probe = withProbe((p) => { p.frames.explorer = { ready: false }; });
    const { status, stdout, out } = await run({ lines: lines(probe) });
    assert.equal(status, 0, stdout);
    assert.match(stdout, /::warning::iOS frame probe: One's Explorer frame did not load/);
    assert.match(readFileSync(join(out, "summary.md"), "utf8"), /Explorer frame: did not load/);
  });

  test("checks Explorer like the local frames when it loaded", async () => {
    const { status, stdout } = await run({ lines: lines(withProbe((p) => { p.frames.explorer.bridge = "function"; })) });
    assert.equal(status, 1);
    assert.match(stdout, /every frame saw the bridge handler as object or undefined/);
  });

  test("fails when the system did not open the handed-off URL", async () => {
    const { status, stdout } = await run({ lines: lines(goodProbe, { ...goodHandoff, opened: false }) });
    assert.equal(status, 1);
    assert.match(stdout, /::error::iOS frame probe: the system opened a handed-off URL outside One/);
  });

  test("fails when the hand-off line never comes", async () => {
    const { status, stdout, out } = await run({ lines: lines(goodProbe, null) });
    assert.equal(status, 1);
    assert.match(stdout, /hand-off: none/);
    assert.match(stdout, /the system opened a handed-off URL outside One/);
    assert.ok(existsSync(join(out, "outside.png")));
  });

  test("fails on a probe error line", async () => {
    const { status, stdout } = await run({ lines: ['EXO_FRAME_PROBE {"error":"the bundled app never mounted"}'] });
    assert.equal(status, 1);
    assert.match(stdout, /the bundled app never mounted/);
    assert.match(stdout, /::error::iOS frame probe: Release build/);
  });

  test("ignores a line that is not a JSON object and fails without a probe", async () => {
    const { status, stdout, out } = await run({ lines: ["EXO_FRAME_PROBE not json"], timeout: 3 });
    assert.equal(status, 1);
    assert.match(stdout, /no EXO_FRAME_PROBE line within 3s/);
    assert.ok(existsSync(join(out, "one.png")));
    assert.ok(!existsSync(join(out, "probe.json")));
  });

  test("fails when the app exits before the probe reports", async () => {
    const { status, stdout } = await run({ lines: ["starting"], exit: true, timeout: 30 });
    assert.equal(status, 1);
    assert.match(stdout, /::error::iOS frame probe: the app exited before the frame probe reported/);
    assert.doesNotMatch(stdout, /no EXO_FRAME_PROBE line/);
  });

  test("fails on a crash report, without copying it", async () => {
    const { status, stdout, out } = await run({ lines: lines(), crash: true });
    assert.equal(status, 1);
    assert.match(stdout, /crash report\(s\) detected: 1/);
    for (const name of readdirSync(out)) {
      assert.doesNotMatch(readFileSync(join(out, name), "utf8"), /SYNTHETIC_CRASH_PRIVATE/, name);
    }
  });

  test("needs the simulator the smoke script's boot chose", async () => {
    const { status, stdout } = await run({ device: false });
    assert.equal(status, 1);
    assert.match(stdout, /device.txt: run ios-simulator-smoke.sh boot/);
  });

  test("terminates the app it launched", async () => {
    const { status, dir } = await run({ lines: lines() });
    assert.equal(status, 0);
    const calls = readFileSync(join(dir, "calls"), "utf8");
    assert.match(calls, /^simctl launch --console-pty fake-udid xyz\.tinycloud\.home$/m);
    assert.match(calls, /^simctl terminate fake-udid xyz\.tinycloud\.home$/m);
    const pid = Number(readFileSync(join(dir, "pid"), "utf8"));
    assert.throws(() => process.kill(pid, 0));
  });
});
