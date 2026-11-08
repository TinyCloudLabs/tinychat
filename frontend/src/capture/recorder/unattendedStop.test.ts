// A recording its owner was showing, left running when that recorder closed (unmount, Recording withdrawn), is
// stopped and kept once it has gone the grace with no recorder attached: never discarded. On the phone engines, which
// cannot stop by id, only when a fresh status read shows exactly that recording live and not paused by its owner.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { createFakeVoiceNotes, type FakeVoiceNotes } from "@/lib/voiceNotes/fakeVoiceNotes";
import { VoiceNotes, __setVoiceNotesForTests, type VoiceNotesPlugin } from "@/lib/voiceNotes/nativeVoiceNotes";
import { __resetCaptureEngineForTests, __setInstalledEngineForTests, type CaptureCapabilities } from "@/lib/voiceNotes/captureEngine";
import { __resetHomeWorkForTests, homeWorkRunning } from "@/lib/homeReauthorizing";
import { installDom } from "@/test/dom";
import {
  __resetRecorderOwnershipForTests, __setRecorderTrackerForTests, createVoiceNoteRecorderController, stopUnattendedRecordings,
  UNATTENDED_GRACE_MS,
} from "./voiceNoteRecorderController";

const BASE: CaptureCapabilities = {
  nativeShortcuts: false, presentRecorder: false, openSettings: false, micDeniedPresentation: false,
  background: true, localTranscription: false, desktopWhisper: false, offlineRecorder: true, nativeFileUpload: false,
  scopedDiscard: false, scopedStop: false, unattendedStop: "verified-status",
};
const PHONE = BASE;
const WEB: CaptureCapabilities = { ...BASE, scopedDiscard: true, scopedStop: true, unattendedStop: "scoped" };
const WAIT_MS = 1_000;

const flush = async () => { for (let turn = 0; turn < 40; turn += 1) await Promise.resolve(); };
let restoreDom: () => void;
const saved = VoiceNotes;
let timers: Array<() => void> = [];
let idBase = 700_000_000_000;

beforeEach(() => {
  restoreDom = installDom();
  __resetHomeWorkForTests();
  __resetRecorderOwnershipForTests();
  timers = [];
  __setRecorderTrackerForTests({ waits: [WAIT_MS], sleep: () => new Promise<void>((resolve) => { timers.push(resolve); }) });
});
afterEach(() => {
  __setRecorderTrackerForTests(null);
  __resetRecorderOwnershipForTests();
  __resetCaptureEngineForTests();
  __setVoiceNotesForTests(saved, { available: null });
  __resetHomeWorkForTests();
  restoreDom();
});

/** A recording its owner shows, then that recorder closes with nobody else attached. */
async function leftRunning(capabilities: CaptureCapabilities, wrap: (fake: FakeVoiceNotes, plugin: VoiceNotesPlugin) => Partial<VoiceNotesPlugin> = () => ({})) {
  idBase += 100;
  const fake = createFakeVoiceNotes(undefined, { idBase });
  const calls: Array<{ name: string; id?: string }> = [];
  const engine: VoiceNotesPlugin = { ...fake.plugin };
  engine.stop = async (options) => { calls.push({ name: "stop", id: options?.id }); return fake.plugin.stop(options); };
  engine.discard = async (options) => { calls.push({ name: "discard", id: options?.id }); return fake.plugin.discard(options); };
  Object.assign(engine, wrap(fake, engine));
  __setInstalledEngineForTests(capabilities === WEB ? "web" : "native", capabilities);
  __setVoiceNotesForTests(engine, { available: true });
  const recorder = newRecorder();
  const detach = recorder.attach();
  await flush();
  await recorder.record();
  await flush();
  const id = recorder.getState().recordingId!;
  expect(recorder.getState().phase).toBe("recording");
  return { fake, engine, calls, recorder, detach, id };
}
const newRecorder = () => createVoiceNoteRecorderController({
  tcw: null, available: true, transcriber: { check: async () => {}, noteSaved: () => {} }, onDeviceReady: () => true,
});
/** One tracker turn: its wait passes. */
async function turn() {
  const wake = timers.shift();
  wake?.();
  await flush();
}
async function turns(count: number) { for (let step = 0; step < count; step += 1) await turn(); }
const graceTurns = UNATTENDED_GRACE_MS / WAIT_MS;
const stops = (calls: Array<{ name: string }>) => calls.filter((call) => call.name === "stop").length;

test("past the grace with no recorder attached, the phone stops the recording it verified, and keeps it", async () => {
  const { fake, calls, detach, id } = await leftRunning(PHONE);
  detach();
  await flush();
  await turns(graceTurns + 1);
  expect(stops(calls)).toBe(1);
  expect(calls.some((call) => call.name === "discard")).toBe(false);
  expect((await fake.plugin.status()).state).toBe("idle");
  expect((await fake.plugin.listPending()).recordings.map((recording) => recording.id)).toEqual([id]);
  await turns(2);
  expect(homeWorkRunning("recording")).toBe(false);
});

test("inside the grace nothing is stopped", async () => {
  const { fake, calls, detach, id } = await leftRunning(PHONE);
  detach();
  await flush();
  await turns(graceTurns - 1);
  expect(stops(calls)).toBe(0);
  expect(await fake.plugin.status()).toMatchObject({ state: "recording", id });
  expect(homeWorkRunning("recording")).toBe(true);
});

test("with a recorder attached nothing is stopped, however long it runs", async () => {
  const { fake, engine, calls, detach, id } = await leftRunning(PHONE);
  // Another recorder is open, but busy with a Record of its own that has not started, so it does not take this one.
  const other = newRecorder();
  other.attach();
  await flush();
  engine.start = () => new Promise(() => {});
  void other.record();
  await flush();
  expect(other.getState().phase).toBe("starting");
  detach();
  await flush();
  await turns(graceTurns * 3);
  expect(stops(calls)).toBe(0);
  expect(await fake.plugin.status()).toMatchObject({ state: "recording", id });
});

test("when the status shows a different recording at the stop, that one is never stopped", async () => {
  const { fake, calls, detach, id } = await leftRunning(PHONE);
  detach();
  await flush();
  await turns(graceTurns - 1);
  // Just as the grace runs out, the left recording ends natively and a new one starts from a native shortcut.
  fake.controls.permissionRevoked();
  const other = await fake.controls.startFromSource("shortcut");
  await turns(3);
  expect(other).not.toBe(id);
  expect(stops(calls)).toBe(0);
  expect(await fake.plugin.status()).toMatchObject({ state: "recording", id: other });
});

test("a recording its owner paused is not stopped", async () => {
  const { fake, calls, recorder, detach, id } = await leftRunning(PHONE);
  await recorder.pause();
  await flush();
  detach();
  await flush();
  await turns(graceTurns + 2);
  expect(stops(calls)).toBe(0);
  expect(await fake.plugin.status()).toMatchObject({ id, intent: "paused" });
});

test("a native start between the check and the stop: the other recording is stopped and kept, logged without ids", async () => {
  let swapped = false;
  const { fake, calls, detach, id } = await leftRunning(PHONE, (fake, engine) => ({
    async stop(options) {
      // Just before the stop reaches the phone, the left recording ends and a shortcut starts another.
      if (!swapped) { swapped = true; fake.controls.permissionRevoked(); await fake.controls.startFromSource("shortcut"); }
      calls.push({ name: "stop", id: options?.id });
      return fake.plugin.stop(options);
    },
    discard: engine.discard,
  }));
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
  try {
    detach();
    await flush();
    await turns(graceTurns + 2);
  } finally {
    console.warn = warn;
  }
  const kept = (await fake.plugin.listPending()).recordings.map((recording) => recording.id);
  // Both are kept (the left one ended natively, the other was stopped); nothing was discarded.
  expect(kept).toContain(id);
  expect(kept).toHaveLength(2);
  expect(calls.some((call) => call.name === "discard")).toBe(false);
  const logged = warnings.filter((line) => line.includes("unattended stop ended a different recording"));
  expect(logged).toHaveLength(1);
  for (const recordingId of kept) expect(logged[0]).not.toContain(recordingId);
  expect(logged[0]).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
  expect((await fake.plugin.status()).state).toBe("idle");
});

test("web and desktop stop it by its id past the grace", async () => {
  const { fake, calls, detach, id } = await leftRunning(WEB);
  detach();
  await flush();
  await turns(graceTurns + 1);
  expect(calls.filter((call) => call.name === "stop")).toEqual([{ name: "stop", id }]);
  expect((await fake.plugin.listPending()).recordings.map((recording) => recording.id)).toEqual([id]);
});

test("Recording withdrawn: stopped and kept at once, without waiting for the grace", async () => {
  const { fake, calls, detach, id } = await leftRunning(WEB);
  detach();
  await flush();
  stopUnattendedRecordings();
  await flush();
  expect(calls.filter((call) => call.name === "stop")).toEqual([{ name: "stop", id }]);
  expect((await fake.plugin.status()).state).toBe("idle");
});

/** Status reads from now on are held until released: how many were asked, and a release for each. */
function holdingStatus() {
  const held: Array<() => void> = [];
  const state = { holding: false, asked: 0, held };
  const wrap = (fake: FakeVoiceNotes): Partial<VoiceNotesPlugin> => ({
    status() {
      if (!state.holding) return fake.plugin.status();
      state.asked += 1;
      return new Promise((resolve) => { held.push(() => resolve(fake.plugin.status())); });
    },
  });
  return { state, wrap };
}

test("Recording withdrawn while a status read is held: stopped by its id at once, with that one read still the only one", async () => {
  const { state, wrap } = holdingStatus();
  const { fake, calls, detach, id } = await leftRunning(WEB, wrap);
  state.holding = true;
  detach();
  await flush();
  expect(state.asked).toBe(1);
  stopUnattendedRecordings();
  await flush();
  expect(calls.filter((call) => call.name === "stop")).toEqual([{ name: "stop", id }]);
  expect((await fake.plugin.listPending()).recordings.map((recording) => recording.id)).toEqual([id]);
  await turns(3);
  expect(state.asked).toBe(1);
});

test("past the grace with a status read held, web and desktop still stop it by its id", async () => {
  const { state, wrap } = holdingStatus();
  const { calls, detach, id } = await leftRunning(WEB, wrap);
  state.holding = true;
  detach();
  await flush();
  await turns(graceTurns + 1);
  expect(calls.filter((call) => call.name === "stop")).toEqual([{ name: "stop", id }]);
  expect(state.asked).toBe(1);
});

test("on the phone, a withdrawal with a status read held stops on that read's answer, and on nothing before it", async () => {
  const { state, wrap } = holdingStatus();
  const { fake, calls, detach, id } = await leftRunning(PHONE, wrap);
  state.holding = true;
  detach();
  await flush();
  stopUnattendedRecordings();
  await turns(3);
  expect(stops(calls)).toBe(0);
  expect(state.asked).toBe(1);
  state.holding = false;
  state.held.shift()!();
  await flush();
  expect(stops(calls)).toBe(1);
  expect((await fake.plugin.listPending()).recordings.map((recording) => recording.id)).toEqual([id]);
});

test("offers repeated while a recorder's pickup read is unanswered start no more reads", async () => {
  let hangNext = false;
  let reads = 0;
  const { detach } = await leftRunning(PHONE, (fake) => ({
    status() {
      reads += 1;
      if (hangNext) { hangNext = false; return new Promise(() => {}); }
      return fake.plugin.status();
    },
  }));
  newRecorder().attach();
  await flush();
  reads = 0;
  // Each turn, the first read is the open recorder's pickup (offered the recording first) and never answers.
  hangNext = true;
  detach();
  await flush();
  for (let step = 0; step < 4; step += 1) {
    hangNext = true;
    await turn();
  }
  // The pickup read once, the tracker's read that turn, and one more tracker read that then hangs: nothing more.
  expect(reads).toBe(3);
});
