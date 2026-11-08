// Model-based check of recorder ownership: two recorders at a time (three over a run) share one capture engine, and a
// seeded scheduler interleaves attach, detach, Record, the owner's Stop and Discard, and every engine answer (start,
// stop and discard results in queue order, discard refusals by id or engine_busy, status reads in any order, tracker
// timers). After every step it checks the ownership invariants; a failure prints the seed and the trace.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { createFakeVoiceNotes } from "@/lib/voiceNotes/fakeVoiceNotes";
import { VoiceNotes, __setVoiceNotesForTests, type VoiceNotesPlugin } from "@/lib/voiceNotes/nativeVoiceNotes";
import { __resetCaptureEngineForTests, __setInstalledEngineForTests, type CaptureCapabilities } from "@/lib/voiceNotes/captureEngine";
import { __resetHomeWorkForTests, homeWorkRunning } from "@/lib/homeReauthorizing";
import { playbackBlocked } from "@/lib/audio/playback";
import { installDom } from "@/test/dom";
import type { RecorderState } from "./recorderReducer";
import {
  __recorderOwnershipForTests, __resetRecorderOwnershipForTests, __setRecorderTrackerForTests,
  createVoiceNoteRecorderController, type VoiceNoteRecorderController,
} from "./voiceNoteRecorderController";

const SEED = 20_251_108;
const SCHEDULES = 4_000;
const STEPS = 24;
const DRAIN = 120;

// A web engine: it discards by id (refusing unless that recording is live), and runs start, stop and discard in order.
const WEB: CaptureCapabilities = {
  nativeShortcuts: false, presentRecorder: false, openSettings: false, micDeniedPresentation: false,
  background: false, localTranscription: false, desktopWhisper: false, offlineRecorder: false, nativeFileUpload: false,
  scopedDiscard: true,
};

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

interface Recorder {
  name: string;
  controller: VoiceNoteRecorderController;
  detach: (() => void) | null;
  /** Its state when it was detached. */
  closed: RecorderState | null;
  /** Its Record was still waiting for the engine's start (in flight) at that moment. */
  startInFlight: boolean;
  closedWithStartInFlight: boolean;
}

type ControlOp = { kind: "start" | "stop" | "discard"; run: () => void; fail: () => void };

const flush = async () => { for (let turn = 0; turn < 40; turn += 1) await Promise.resolve(); };
const blocking = (s: RecorderState) => s.phase === "starting" || s.phase === "stopping" || s.phase === "discarding" ||
  (s.phase === "recording" && (s.controlPending === "resume" || (s.mic.state !== "paused" && s.mic.state !== "interrupted" && s.mic.state !== "needs_user")));

let restoreDom: () => void;
const savedVoiceNotes = VoiceNotes;
beforeEach(() => {
  restoreDom = installDom();
  __resetHomeWorkForTests();
  __resetRecorderOwnershipForTests();
});
afterEach(() => {
  __setRecorderTrackerForTests(null);
  __resetRecorderOwnershipForTests();
  __resetCaptureEngineForTests();
  __setVoiceNotesForTests(savedVoiceNotes, { available: null });
  __resetHomeWorkForTests();
  restoreDom();
});

// What the schedules reached, so the model keeps exercising the cases it is for.
const coverage = { lateDiscards: 0, busyDiscards: 0, adoptedFromClosed: 0, twoAttached: 0 };

async function runSchedule(seed: number) {
  const random = rng(seed);
  const pick = <T>(items: readonly T[]) => items[Math.floor(random() * items.length)];
  const trace: string[] = [];
  const fail = (why: string) => {
    throw new Error(`ownership invariant broken: ${why}\nseed=${seed}\ntrace:\n  ${trace.join("\n  ")}`);
  };

  __resetHomeWorkForTests();
  __resetRecorderOwnershipForTests();
  // Ids of their own, apart from every other test's: the notes and discard marks these recordings leave are shared.
  const fake = createFakeVoiceNotes(undefined, { idBase: 900_000_000_000 + (seed - SEED) * 100 });
  const controls: ControlOp[] = [];
  const reads: Array<() => void> = [];
  const timers: Array<() => void> = [];
  const recorders: Recorder[] = [];
  let actor: Recorder | null = null;
  let broken: string | null = null;
  const startedBy = new Map<string, Recorder>();
  // Recorders whose Record is waiting to call the engine's start, in order.
  const awaitingStart: Recorder[] = [];
  // Recordings an attached recorder has shown as recording: a closed recorder's cleanup never discards those.
  const shown = new Set<string>();
  const trackedEver = new Set<string>();

  const queued = <T>(kind: ControlOp["kind"], work: () => Promise<T>, busy: boolean): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      controls.push({
        kind,
        run: () => { void work().then(resolve, reject); },
        fail: busy ? () => reject(Object.assign(new Error("engine busy"), { code: "engine_busy" })) : () => { void work().then(resolve, reject); },
      });
    });
  const engine: VoiceNotesPlugin = {
    ...fake.plugin,
    start(options) {
      const by = awaitingStart.shift() ?? null;
      return queued("start", async () => {
        const started = await fake.plugin.start(options);
        if (by) startedBy.set(started.id, by);
        return started;
      }, false);
    },
    stop() { return queued("stop", () => fake.plugin.stop(), false); },
    discard(options) {
      // (b) no blind discard, and only of the caller's own recording. Noted here (the controller would catch a
      // throw) and reported by the next check.
      const id = options?.id;
      const attachedOwner = recorders.find((r) => r.detach && r.controller.getState().phase !== "idle" && r.controller.getState().recordingId === id);
      if (id === undefined) broken ??= "a discard without an id on an engine that discards by id";
      else if (actor) {
        if (actor.controller.getState().recordingId !== id) broken ??= `${actor.name} discarded ${id}, which it does not show`;
      } else {
        const starter = startedBy.get(id);
        if (!starter || starter.detach || !starter.closedWithStartInFlight) broken ??= `a closed recorder discarded ${id}, which is not its own late start`;
        if (attachedOwner) broken ??= `a closed recorder discarded ${id}, owned by ${attachedOwner.name}`;
        if (shown.has(id)) broken ??= `a closed recorder discarded ${id}, which a recorder had shown`;
      }
      if (!actor) coverage.lateDiscards += 1;
      return queued("discard", () => fake.plugin.discard(options), true);
    },
    status() {
      const snapshot = fake.plugin.status();
      return new Promise((resolve) => { reads.push(() => resolve(snapshot)); });
    },
  };
  __setInstalledEngineForTests("web", WEB);
  __setVoiceNotesForTests(engine, { available: true });
  __setRecorderTrackerForTests({ waits: [1], sleep: () => new Promise<void>((resolve) => { timers.push(resolve); }) });

  const live = async () => {
    const status = await fake.plugin.status();
    return status.state === "idle" ? null : status.id;
  };
  const check = async (step: string) => {
    trace.push(step);
    if (broken) fail(broken);
    const id = await live();
    const attached = recorders.filter((r) => r.detach);
    const owners = id ? attached.filter((r) => r.controller.getState().phase !== "idle" && r.controller.getState().recordingId === id) : [];
    // (a) at most one owner per live recording.
    if (owners.length > 1) fail(`${id} is owned by ${owners.map((r) => r.name).join(" and ")}`);
    for (const r of attached) if (r.controller.getState().phase === "recording" && r.controller.getState().recordingId) shown.add(r.controller.getState().recordingId!);
    for (const tracked of __recorderOwnershipForTests().tracked.keys()) trackedEver.add(tracked);
    if (id && owners.length === 1 && trackedEver.has(id)) coverage.adoptedFromClosed += 1;
    if (attached.length === 2) coverage.twoAttached += 1;
    // (c) a live recording nobody shows is followed by a closed recorder's tracker (or is a start still settling).
    if (id && owners.length === 0 && !__recorderOwnershipForTests().tracked.has(id) &&
      !attached.some((r) => r.controller.getState().phase === "starting")) fail(`${id} is live with no owner and no tracker`);
    // (d) the Home work place is held while anything records.
    if (id && !homeWorkRunning("recording")) fail(`${id} is live but no Home work place is held`);
    // An attached recorder never shows as recording one the engine no longer has (a stale status read never revives it).
    for (const r of attached) {
      const s = r.controller.getState();
      if (s.phase === "recording" && s.recordingId !== id) fail(`${r.name} shows ${s.recordingId} recording, but ${id ?? "nothing"} is live`);
    }
    // A closed recorder never takes a recording, and playback follows only the attached recorders.
    for (const r of recorders) {
      if (r.detach || !r.closed) continue;
      const now = r.controller.getState();
      if ((now.phase === "recording" && r.closed.phase !== "recording") || (now.recordingId !== null && now.recordingId !== r.closed.recordingId))
        fail(`closed ${r.name} took ${now.recordingId} (${now.phase})`);
    }
    if (playbackBlocked() !== attached.some((r) => blocking(r.controller.getState())))
      fail(`playback blocked=${playbackBlocked()} while attached recorders block=${attached.some((r) => blocking(r.controller.getState()))}`);
  };

  const actions = () => {
    const list: Array<[string, () => void]> = [];
    const attached = recorders.filter((r) => r.detach);
    if (recorders.length < 3 && attached.length < 2) list.push(["attach", () => {
      const r: Recorder = { name: `R${recorders.length + 1}`, controller: createVoiceNoteRecorderController({
        tcw: null, available: true, transcriber: { check: async () => {}, noteSaved: () => {} }, onDeviceReady: () => true }),
        detach: null, closed: null, startInFlight: false, closedWithStartInFlight: false };
      recorders.push(r);
      r.detach = r.controller.attach();
      trace.push(`  (${r.name} attached)`);
    }]);
    for (const r of attached) {
      const s = r.controller.getState();
      list.push([`detach ${r.name}`, () => {
        r.closed = r.controller.getState();
        r.closedWithStartInFlight = r.startInFlight;
        r.detach!();
        r.detach = null;
      }]);
      if (s.ready && s.phase === "idle" && s.outcome === null) list.push([`record ${r.name}`, () => {
        const recording = r.controller.record();
        if (r.controller.getState().phase !== "starting") return;
        awaitingStart.push(r);
        r.startInFlight = true;
        // A Record that ends without asking the engine (cancelled first) leaves the queue.
        void recording.finally(() => {
          r.startInFlight = false;
          const left = awaitingStart.indexOf(r);
          if (left !== -1) awaitingStart.splice(left, 1);
        });
      }]);
      if (s.phase === "recording") {
        list.push([`stop ${r.name}`, () => { void r.controller.stop(); }]);
        list.push([`discard ${r.name}`, () => { actor = r; void r.controller.discard(); actor = null; }]);
      }
    }
    if (controls.length > 0) {
      const head = controls[0];
      list.push([`engine ${head.kind} runs`, () => { controls.shift(); head.run(); }]);
      if (head.kind === "discard") list.push(["engine discard busy", () => { controls.shift(); coverage.busyDiscards += 1; head.fail(); }]);
    }
    reads.forEach((answer, index) => list.push([`status read ${index} answers`, () => { reads.splice(index, 1); answer(); }]));
    timers.forEach((wake, index) => list.push([`tracker timer ${index}`, () => { timers.splice(index, 1); wake(); }]));
    return list;
  };

  try {
    for (let step = 0; step < STEPS; step += 1) {
      const options = actions();
      if (options.length === 0) break;
      const [name, act] = pick(options);
      act();
      await flush();
      await check(name);
    }
    // Quiescence: no more owner actions; the engine answers everything, in order, and never fails again.
    for (let step = 0; step < DRAIN; step += 1) {
      let name: string;
      if (controls.length > 0) { const head = controls.shift()!; head.run(); name = `drain: engine ${head.kind} runs`; }
      else if (reads.length > 0) { reads.shift()!(); name = "drain: status read answers"; }
      else if (timers.length > 0) { timers.shift()!(); name = "drain: tracker timer"; }
      else break;
      await flush();
      await check(name);
    }
    const id = await live();
    const attached = recorders.filter((r) => r.detach);
    if (id) {
      const owned = attached.some((r) => r.controller.getState().phase !== "idle" && r.controller.getState().recordingId === id);
      const kept = __recorderOwnershipForTests().tracked.get(id);
      // A recording nobody started on purpose never stays live unseen; one its owner was showing waits for the next recorder.
      if (!owned && !(kept && !kept.mayDiscard && attached.length === 0)) fail(`at rest ${id} is live and nobody shows it`);
    } else if (controls.length === 0 && reads.length === 0 && attached.every((r) => r.controller.getState().phase === "idle")
      && __recorderOwnershipForTests().tracked.size === 0 && homeWorkRunning("recording")) {
      fail("at rest nothing records, yet a Home work place is still held");
    }
  } finally {
    for (const r of recorders) if (r.detach) { r.detach(); r.detach = null; }
    // Let what is left settle without the scheduler, so the next schedule starts clean.
    __setRecorderTrackerForTests({ waits: [1], sleep: () => new Promise<void>(() => {}) });
    for (const wake of timers.splice(0)) wake();
    for (const answer of reads.splice(0)) answer();
    for (const op of controls.splice(0)) op.run();
    await flush();
  }
}

test(`recorder ownership holds across ${SCHEDULES} seeded interleavings of two recorders sharing one engine`, async () => {
  for (let schedule = 0; schedule < SCHEDULES; schedule += 1) await runSchedule(SEED + schedule);
  for (const [reached, count] of Object.entries(coverage)) expect([reached, count > 0]).toEqual([reached, true]);
}, 30_000);
