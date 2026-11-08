// Model-based check of recorder ownership. Up to two recorders at a time (four created over a run, any of them
// reattached after closing; each signed in to one of two accounts, or signed out) share one capture engine of one of
// three kinds: web (stops and discards by id), desktop (the same, but a discard can resolve while its native
// retirement is still pending) and phone (no id-scoped controls; native starts from a shortcut can appear between any
// two steps). A seeded scheduler interleaves recorder actions (attach, reattach, detach, an account switch or sign-out
// replacing a recorder, Record, Stop, Discard, Pause, Resume, recording options, dismissing the receipt, and the same
// controls arriving late on a recorder that has closed), engine answers (start, stop and discard in queue order, stop
// and discard failures, discard pending retirement, status reads answered in any order, never answered, or rejected),
// native events (auto-stop, going to the background, a shortcut start), Recording withdrawn, and time passing. After
// every step it checks the invariants below; a failure prints the seed and the trace.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { createFakeVoiceNotes } from "@/lib/voiceNotes/fakeVoiceNotes";
import { VoiceNotes, __setVoiceNotesForTests, type CaptureStatus, type VoiceNotesPlugin } from "@/lib/voiceNotes/nativeVoiceNotes";
import { __resetCaptureEngineForTests, __setInstalledEngineForTests, type CaptureCapabilities } from "@/lib/voiceNotes/captureEngine";
import { __resetHomeWorkForTests, homeWorkRunning } from "@/lib/homeReauthorizing";
import { playbackBlocked } from "@/lib/audio/playback";
import { installDom } from "@/test/dom";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import type { VoiceNotePipeline } from "@/lib/voiceNotes/voiceNotePipeline";
import type { RecorderState } from "./recorderReducer";
import {
  __recorderOwnershipForTests, __resetRecorderOwnershipForTests, __setRecorderTrackerForTests,
  createVoiceNoteRecorderController, stopUnattendedRecordings, UNATTENDED_GRACE_MS, type VoiceNoteRecorderController,
} from "./voiceNoteRecorderController";

// CI runs this fixed seed; a local soak may set RECORDER_MODEL_SEED / _SCHEDULES / _STEPS (and _REPORT to print coverage).
const SEED = Number(process.env.RECORDER_MODEL_SEED ?? 20_251_108);
const SCHEDULES = Number(process.env.RECORDER_MODEL_SCHEDULES ?? 3_000);
const STEPS = Number(process.env.RECORDER_MODEL_STEPS ?? 32);
const DRAIN = 160;
const WAIT_MS = 1_000;

type EngineKind = "web" | "desktop" | "phone";
const BASE: CaptureCapabilities = {
  nativeShortcuts: false, presentRecorder: false, openSettings: false, micDeniedPresentation: false,
  background: false, localTranscription: false, desktopWhisper: false, offlineRecorder: false, nativeFileUpload: false,
  scopedDiscard: true, scopedStop: true, unattendedStop: "scoped",
};
const CAPABILITIES: Record<EngineKind, CaptureCapabilities> = {
  web: BASE,
  desktop: BASE,
  phone: { ...BASE, scopedDiscard: false, scopedStop: false, unattendedStop: "verified-status" },
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
  /** Its state when it last closed. */
  closed: RecorderState | null;
  /** Its Records still waiting for the engine's start. */
  attempts: Attempt[];
  attaches: number;
  /** The account it is signed in to (null: signed out). */
  account: string | null;
}
/** One Record: whether its recorder closed while it waited for the engine's start (so what it starts is a late start). */
interface Attempt { recorder: Recorder; closedWhileWaiting: boolean }

type ControlOp = { kind: "start" | "stop" | "discard"; id: string | null; outcomes: Record<string, () => void> };

const flush = async () => { for (let turn = 0; turn < 40; turn += 1) await Promise.resolve(); };
const blocking = (s: RecorderState) => s.phase === "starting" || s.phase === "stopping" || s.phase === "discarding" ||
  (s.phase === "recording" && (s.controlPending === "resume" || (s.mic.state !== "paused" && s.mic.state !== "interrupted" && s.mic.state !== "needs_user")));

// What the schedules reached, so the model keeps exercising the cases it is for: every control on every engine kind
// (a cell per engine × control), and the conditions below.
const coverage: Record<string, number> = {};
const reached = (name: string) => { coverage[name] = (coverage[name] ?? 0) + 1; };
const ENGINES: readonly EngineKind[] = ["web", "desktop", "phone"];
const CONTROLS = [
  "attach", "reattach", "detach", "account switch", "sign-out", "record", "stop", "discard", "pause", "resume",
  "dismiss", "options", "stale record", "stale stop", "stale discard", "stale options", "engine start run",
  "engine stop run", "engine stop fail", "engine discard run", "engine discard busy", "read answers", "read rejects",
  "read never answers", "time passes", "native auto-stop", "background", "Recording withdrawn",
  "unattended stop", "action while a read hangs", "withdrawn while a read hangs",
] as const;
const REQUIRED = [
  ...ENGINES.flatMap((engine) => CONTROLS.map((control) => `${engine} × ${control}`)),
  "web × late start discarded by id", "desktop × late start discarded by id", "phone × late start stopped",
  "desktop × engine discard pending", "desktop × desktop retirement finishes", "desktop × action during a pending retirement",
  "phone × native start", "phone × native start while unattended",
  "web × unattended stop of a paused recording", "desktop × unattended stop of a paused recording",
  "two attached", "adopted from a closed recorder", "record again after a receipt", "unattended past the grace",
];
const MIN_PER_CELL = 5;

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

async function runSchedule(seed: number, base = SEED, steps = STEPS, idBase = 800_000_000_000 + (seed - base) * 100) {
  const random = rng(seed);
  const pick = <T>(items: readonly T[]) => items[Math.floor(random() * items.length)];
  const chance = (p: number) => random() < p;
  const trace: string[] = [];
  const fail = (why: string): never => {
    throw new Error(`ownership invariant broken: ${why}\nseed=${seed}\ntrace:\n  ${trace.join("\n  ")}`);
  };

  const kind: EngineKind = (["web", "desktop", "phone"] as const)[(seed - base) % 3];
  const caps = CAPABILITIES[kind];
  // One engine × control cell reached.
  const did = (control: string) => reached(`${kind} × ${control}`);
  __resetHomeWorkForTests();
  __resetRecorderOwnershipForTests();
  // Ids of their own, apart from every other test's: the notes and discard marks these recordings leave are shared.
  const fake = createFakeVoiceNotes(undefined, { idBase });
  const controls: ControlOp[] = [];
  const reads: Array<{ answer: () => void; reject: () => void }> = [];
  let hungReads = 0;
  // The model's clock and the trackers sleeping on it.
  let now = 0;
  const sleepers: Array<{ due: number; wake: () => void }> = [];
  const recorders: Recorder[] = [];
  let actor: Recorder | null = null;
  let broken: string | null = null;
  const note = (why: string) => { broken ??= why; };
  // The phone cannot stop or discard by id: a control that reached a different recording than the one it meant (a
  // native start or a start queued ahead of it) is the accepted race (TC-2544). From then on the checks about which
  // recording is live and who shows or stops it are off for that schedule; ownership, the Home work place, playback,
  // and closed recorders staying out keep being checked.
  let racedOnPhone = false;
  const knownPhoneRace = () => {
    if (!racedOnPhone) reached("phone control reached another recording (accepted race)");
    racedOnPhone = true;
  };
  const startedBy = new Map<string, Attempt>();
  const awaitingStart: Attempt[] = [];
  // Recordings an attached recorder has shown as recording, and recordings started natively (outside any recorder).
  const shown = new Set<string>();
  const native = new Set<string>();
  // Desktop: a discard that resolved while the native capture source is still being retired.
  let retiring: string | null = null;
  // Each live recording running with no recorder attached: since when (model time), and how long of that the engine
  // was answering; and stops or discards asked for it. Web and desktop stop by id without a status read, so all of
  // their time counts, reads answered or not. The phone acts only on a status read answered after the stop fell due:
  // only time with no read or control outstanding counts there.
  const unattended = new Map<string, { since: number; answeredMs: number }>();
  const advanceClock = () => {
    const answering = caps.unattendedStop === "scoped" || (reads.length === 0 && controls.length === 0);
    now += WAIT_MS;
    if (answering) for (const entry of unattended.values()) entry.answeredMs += WAIT_MS;
    for (const sleeper of sleepers.splice(0)) { if (sleeper.due <= now) sleeper.wake(); else sleepers.push(sleeper); }
  };
  const endingAsked = new Map<string, number>();
  let engineCalls = 0;

  const queued = <T>(op: Omit<ControlOp, "outcomes">, outcomes: Record<string, (resolve: (value: T) => void, reject: (error: unknown) => void) => void>) =>
    new Promise<T>((resolve, reject) => {
      const bound: Record<string, () => void> = {};
      for (const [name, act] of Object.entries(outcomes)) bound[name] = () => act(resolve, reject);
      controls.push({ ...op, outcomes: bound });
    });
  const busy = (code: string) => Object.assign(new Error(code), { code });
  const liveNow = async () => {
    const status = await fake.plugin.status();
    return status.state === "idle" ? null : status.id;
  };

  const engine: VoiceNotesPlugin = {
    ...fake.plugin,
    start(options) {
      engineCalls += 1;
      const by = awaitingStart.shift() ?? null;
      return queued<Awaited<ReturnType<VoiceNotesPlugin["start"]>>>({ kind: "start", id: null }, {
        run: (resolve, reject) => {
          void fake.plugin.start(options).then((started) => {
            if (by) startedBy.set(started.id, by);
            resolve(started);
          }, reject);
        },
      });
    },
    stop(options) {
      engineCalls += 1;
      const target = options?.id ?? null;
      if (actor === null) {
        // A closed recorder's stop: only of a recording nobody attached shows, past the grace (or withdrawn).
        if (recorders.some((r) => r.detach)) note("a closed recorder stopped a recording while a recorder was attached");
        did("unattended stop");
        if (kind === "phone") void liveNow().then((live) => { if (live && startedBy.get(live)?.closedWhileWaiting) did("late start stopped"); });
        // Web and desktop stop and keep a recording its owner paused; the phone leaves it alone.
        void fake.plugin.status().then((status) => {
          if (status.state === "idle" || status.intent !== "paused") return;
          if (kind === "phone") note(`the phone stopped ${status.id}, which its owner paused, with nobody attached`);
          else did("unattended stop of a paused recording");
        });
      } else if (target !== null && actor.controller.getState().recordingId !== target) {
        note(`${actor.name} stopped ${target}, which it does not show`);
      }
      if (caps.scopedStop && target === null) note("a stop without an id on an engine that stops by id");
      void liveNow().then((live) => { if (live) endingAsked.set(live, now); });
      const meant = actor?.controller.getState().recordingId ?? null;
      const liveAtCall = liveNow();
      return queued<Awaited<ReturnType<VoiceNotesPlugin["stop"]>>>({ kind: "stop", id: target }, {
        run: (resolve, reject) => {
          if (kind === "phone") void Promise.all([liveNow(), liveAtCall]).then(([live, before]) => {
            if (live !== null && live !== (meant ?? before)) knownPhoneRace();
          });
          void fake.plugin.stop(options).then(resolve, reject);
        },
        fail: (_resolve, reject) => reject(busy("engine_busy")),
      });
    },
    discard(options) {
      engineCalls += 1;
      const target = options?.id;
      const attachedOwner = recorders.find((r) => r.detach && r.controller.getState().phase !== "idle" && r.controller.getState().recordingId === target);
      if (caps.scopedDiscard && target === undefined) note("a discard without an id on an engine that discards by id");
      if (actor) {
        if (target !== undefined && actor.controller.getState().recordingId !== target) note(`${actor.name} discarded ${target}, which it does not show`);
      } else {
        if (!caps.scopedDiscard) note("a closed recorder discarded on an engine that cannot discard by id");
        const starter = target === undefined ? undefined : startedBy.get(target);
        if (!starter || starter.recorder.detach || !starter.closedWhileWaiting) note(`a closed recorder discarded ${target}, which is not its own late start`);
        if (attachedOwner) note(`a closed recorder discarded ${target}, owned by ${attachedOwner.name}`);
        if (target !== undefined && shown.has(target)) note(`a closed recorder discarded ${target}, which a recorder had shown`);
        did("late start discarded by id");
      }
      if (target !== undefined) endingAsked.set(target, now);
      const meant = actor?.controller.getState().recordingId ?? target ?? null;
      const outcomes: Record<string, (resolve: (value: { id: string | null }) => void, reject: (error: unknown) => void) => void> = {
        run: (resolve, reject) => {
          if (kind === "phone") void liveNow().then((live) => { if (live !== null && live !== meant) knownPhoneRace(); });
          void fake.plugin.discard(options).then(resolve, reject);
        },
        busy: (_resolve, reject) => { reject(busy("engine_busy")); },
      };
      if (kind === "desktop") outcomes.pending = (resolve, reject) => {
        // The adapter resolves, but the native source is still being retired: it keeps capturing for now.
        void fake.plugin.status().then((status) => {
          if (status.state === "idle" || (target !== undefined && status.id !== target)) { void fake.plugin.discard(options).then(resolve, reject); return; }
          retiring = status.id;
          did("engine discard pending");
          resolve({ id: status.id });
        });
      };
      return queued({ kind: "discard", id: target ?? null }, outcomes);
    },
    setRecordingOptions(options) {
      engineCalls += 1;
      // Options apply to whatever is live: only for a recording an attached recorder shows.
      void liveNow().then((live) => {
        if (live !== null && !recorders.some((r) => r.detach && r.controller.getState().phase !== "idle" && r.controller.getState().recordingId === live))
          note(`recording options reached ${live}, which no attached recorder shows`);
      });
      return fake.plugin.setRecordingOptions(options);
    },
    status() {
      const snapshot = fake.plugin.status().then((status): CaptureStatus => retiring !== null && status.id === retiring
        ? { ...status, state: "idle", id: null, startedAt: null, intent: "stopped", discardCleanupPending: true, captureSourceUnconfirmed: true }
        : status);
      return new Promise((resolve, reject) => {
        reads.push({ answer: () => { void snapshot.then(resolve); }, reject: () => reject(busy("status_failed")) });
      });
    },
  };
  __setInstalledEngineForTests(kind === "phone" ? "native" : kind === "desktop" ? "tauri" : "web", caps);
  __setVoiceNotesForTests(engine, { available: true });
  __setRecorderTrackerForTests({ waits: [WAIT_MS], sleep: (ms) => new Promise<void>((resolve) => { sleepers.push({ due: now + ms, wake: resolve }); }) });

  const attachedRecorders = () => recorders.filter((r) => r.detach);
  const check = async (step: string) => {
    trace.push(step);
    if (broken) fail(broken);
    const id = await liveNow();
    const attached = attachedRecorders();
    if (attached.length === 2) reached("two attached");
    if (retiring !== null) did("action during a pending retirement");
    if (hungReads > 0) did("action while a read hangs");
    const owners = id ? attached.filter((r) => r.controller.getState().phase !== "idle" && r.controller.getState().recordingId === id) : [];
    // (a) at most one owner per live recording.
    if (owners.length > 1) fail(`${id} is owned by ${owners.map((r) => r.name).join(" and ")}`);
    // A closed recorder never takes a recording.
    for (const r of recorders) {
      if (r.detach || !r.closed) continue;
      const now_ = r.controller.getState();
      if ((now_.phase === "recording" && r.closed.phase !== "recording") || (now_.recordingId !== null && now_.recordingId !== r.closed.recordingId))
        fail(`closed ${r.name} took ${now_.recordingId} (${now_.phase})`);
    }
    // Playback is blocked exactly while an attached recorder captures.
    if (playbackBlocked() !== attached.some((r) => blocking(r.controller.getState())))
      fail(`playback blocked=${playbackBlocked()} while attached recorders block=${attached.some((r) => blocking(r.controller.getState()))}`);
    // (d) the Home work place is held while a recording a recorder started is live.
    if (id && !native.has(id) && !homeWorkRunning("recording")) fail(`${id} is live but no Home work place is held`);
    if (racedOnPhone) return;
    for (const r of attached) if (r.controller.getState().phase === "recording" && r.controller.getState().recordingId) shown.add(r.controller.getState().recordingId!);
    const tracked = __recorderOwnershipForTests().tracked;
    if (id && owners.length === 1 && tracked.has(id)) reached("adopted from a closed recorder");
    // (c) a live recording nobody shows is followed by a tracker, unless it started natively or a start is settling.
    if (id && owners.length === 0 && !tracked.has(id) && !native.has(id) &&
      !attached.some((r) => r.controller.getState().phase === "starting")) fail(`${id} is live with no owner and no tracker`);
    // An attached recorder never shows as recording one the engine no longer has.
    for (const r of attached) {
      const s = r.controller.getState();
      if (s.phase === "recording" && s.recordingId !== id && !(retiring !== null && s.recordingId === retiring)) fail(`${r.name} shows ${s.recordingId} recording, but ${id ?? "nothing"} is live`);
    }
    // The policy, timed: a recording a recorder showed or started, live with no recorder attached, is stopped (or
    // discarded, if nobody saw it) within the grace and two more turns of counted time (see advanceClock). Web and
    // desktop stop it by id even when its owner paused it (stopped and kept); the phone, whose unscoped stop needs a
    // fresh status showing it live and not paused, leaves a recording its owner paused alone. Status reads that never
    // answer change nothing on web and desktop; the phone is exempt once one hangs (it never stops on a status it could
    // not read).
    const status = await fake.plugin.status();
    const leftAlone = kind === "phone" && status.intent === "paused";
    if (id && attached.length === 0 && !leftAlone && retiring === null && !native.has(id)) {
      const entry = unattended.get(id) ?? { since: now, answeredMs: 0 };
      unattended.set(id, entry);
      const asked = endingAsked.get(id);
      if (entry.answeredMs >= UNATTENDED_GRACE_MS) reached("unattended past the grace");
      if (entry.answeredMs > UNATTENDED_GRACE_MS + 2 * WAIT_MS && (asked === undefined || asked < entry.since) && (kind !== "phone" || hungReads === 0))
        fail(`${id} has run unattended (engine answering) for ${entry.answeredMs}ms and nothing stopped it`);
    } else if (id) unattended.delete(id);
  };

  // Each recorder is signed in to one of two accounts, or signed out (its notes held locally: the pipeline accepts
  // nothing, so no save leaves the model).
  const ACCOUNTS = ["did:example:a", "did:example:b", null] as const;
  const holdingPipeline = { isAccepting: () => false } as unknown as VoiceNotePipeline;
  const newRecorder = (account: string | null = pick(ACCOUNTS)): Recorder => ({ name: `R${recorders.length + 1}`, controller: createVoiceNoteRecorderController({
    tcw: account === null ? null : { did: account } as TinyCloudWeb, pipeline: account === null ? undefined : holdingPipeline,
    available: true, transcriber: { check: async () => {}, noteSaved: () => {} }, onDeviceReady: () => true }),
  detach: null, closed: null, attempts: [], attaches: 0, account });
  const attach = (r: Recorder) => {
    r.detach = r.controller.attach();
    r.attaches += 1;
    did(r.attaches > 1 ? "reattach" : "attach");
  };
  const detach = (r: Recorder) => {
    r.closed = r.controller.getState();
    for (const attempt of r.attempts) attempt.closedWhileWaiting = true;
    r.detach!();
    r.detach = null;
  };
  /** A control on a recorder that has closed (a callback deferred past its close): it must reach nothing. */
  const stale = (r: Recorder, name: string, act: () => void) => {
    const before = engineCalls;
    const state = r.controller.getState();
    act();
    void flush().then(() => {
      if (engineCalls !== before) note(`${name} on closed ${r.name} reached the engine`);
      const after = r.controller.getState();
      if (after.phase !== state.phase || after.recordingId !== state.recordingId) note(`${name} on closed ${r.name} changed its state`);
    });
  };
  /** A recording-scoped option, its status read answered after whatever the scheduler does next. The engine call is
  * checked where it lands (setRecordingOptions above). A failed status read fails the choice, as the UI shows it. */
  const recordingOptions = (r: Recorder) => {
    actor = r;
    void r.controller.setTranscriber(pick(["off", "on-device"] as const), { scope: "recording" }).catch(() => undefined);
    actor = null;
  };

  const actions = () => {
    const list: Array<[string, () => void]> = [];
    const attached = attachedRecorders();
    if (attached.length < 2) {
      if (recorders.length < 4) list.push(["attach", () => { const r = newRecorder(); recorders.push(r); attach(r); trace.push(`  (${r.name} attached, ${r.account ?? "signed out"})`); }]);
      for (const r of recorders) if (!r.detach && r.attaches > 0) list.push([`reattach ${r.name}`, () => attach(r)]);
    }
    for (const r of recorders) {
      const s = r.controller.getState();
      if (r.detach) {
        list.push([`detach ${r.name}`, () => { did("detach"); detach(r); }]);
        // The provider's owner changes: its recorder closes and the new account's (or the signed-out one) opens.
        if (recorders.length < 4 && chance(0.4)) {
          const other = r.account === ACCOUNTS[0] ? ACCOUNTS[1] : ACCOUNTS[0];
          const signOut = r.account !== null && chance(0.5);
          const next = signOut ? null : other;
          list.push([`${signOut ? "sign-out" : "account switch"} on ${r.name}`, () => {
            did(signOut ? "sign-out" : "account switch");
            detach(r);
            const replacement = newRecorder(next);
            recorders.push(replacement);
            attach(replacement);
            trace.push(`  (${replacement.name} attached, ${next ?? "signed out"})`);
          }]);
        }
        if (s.ready && s.phase === "idle" && s.outcome === null) list.push([`record ${r.name}`, () => {
          did("record");
          const recording = r.controller.record();
          if (r.controller.getState().phase !== "starting") return;
          const attempt: Attempt = { recorder: r, closedWhileWaiting: false };
          awaitingStart.push(attempt);
          r.attempts.push(attempt);
          void recording.finally(() => {
            r.attempts.splice(r.attempts.indexOf(attempt), 1);
            const left = awaitingStart.indexOf(attempt);
            if (left !== -1) awaitingStart.splice(left, 1);
          });
        }]);
        if (s.outcome !== null) list.push([`dismiss ${r.name}`, () => {
          did("dismiss");
          r.controller.dismissOutcome();
          if (r.controller.getState().phase === "idle" && r.controller.getState().ready) reached("record again after a receipt");
        }]);
        if (s.phase === "recording") {
          list.push([`stop ${r.name}`, () => { did("stop"); actor = r; void r.controller.stop(); actor = null; }]);
          list.push([`discard ${r.name}`, () => { did("discard"); actor = r; void r.controller.discard(); actor = null; }]);
          list.push([`pause ${r.name}`, () => { did("pause"); actor = r; void r.controller.pause(); actor = null; }]);
          list.push([`resume ${r.name}`, () => { did("resume"); actor = r; void r.controller.resume(); actor = null; }]);
          list.push([`options ${r.name}`, () => { did("options"); recordingOptions(r); }]);
        }
      } else if (r.attaches > 0) {
        // One control arriving late on the closed recorder (a callback deferred past its close).
        const late = pick([
          ["stale record", "Record", () => { void r.controller.record(); }],
          ["stale stop", "Stop", () => { void r.controller.stop(); }],
          ["stale discard", "Discard", () => { void r.controller.discard(); }],
          ["stale options", "Options", () => {
            void r.controller.setTranscriber("off", { scope: "recording" }).catch(() => undefined);
            void r.controller.setIdentifySpeakers(true, "recording").catch(() => undefined);
          }],
        ] as const);
        list.push([`${late[0]} on ${r.name}`, () => { did(late[0]); stale(r, late[1], late[2]); }]);
      }
    }
    if (controls.length > 0) {
      const head = controls[0];
      for (const [outcome, act] of Object.entries(head.outcomes)) list.push([`engine ${head.kind} ${outcome}`, () => {
        controls.shift();
        if (outcome !== "pending") did(`engine ${head.kind} ${outcome}`);
        act();
      }]);
    }
    if (retiring !== null) list.push(["desktop retirement finishes", () => {
      did("desktop retirement finishes");
      const id = retiring;
      retiring = null;
      void fake.plugin.status().then((status) => { if (status.id === id) void fake.plugin.discard(); });
    }]);
    reads.forEach((read, index) => {
      list.push([`status read ${index} answers`, () => { did("read answers"); reads.splice(index, 1); read.answer(); }]);
      if (chance(0.15)) list.push([`status read ${index} rejects`, () => { did("read rejects"); reads.splice(index, 1); read.reject(); }]);
      if (chance(0.05)) list.push([`status read ${index} never answers`, () => { did("read never answers"); reads.splice(index, 1); hungReads += 1; }]);
    });
    list.push(["time passes", () => { did("time passes"); advanceClock(); }]);
    list.push(["native auto-stop", () => {
      void fake.plugin.status().then((status) => { if (status.state !== "idle" && status.id !== retiring) { did("native auto-stop"); fake.controls.permissionRevoked(); } });
    }]);
    list.push(["background", () => { did("background"); fake.controls.appSuspended(); }]);
    if (kind === "phone") list.push(["native start", () => {
      void fake.plugin.status().then(async (status) => {
        if (status.state !== "idle") return;
        did("native start");
        if (attachedRecorders().length === 0) did("native start while unattended");
        native.add(await fake.controls.startFromSource("shortcut"));
      });
    }]);
    if (chance(0.2)) list.push(["Recording withdrawn", () => {
      did("Recording withdrawn");
      if (hungReads > 0 || reads.length > 0) did("withdrawn while a read hangs");
      stopUnattendedRecordings();
    }]);
    return list;
  };

  try {
    for (let step = 0; step < steps; step += 1) {
      const [name, act] = pick(actions());
      act();
      await flush();
      await check(name);
    }
    // Quiescence: no more recorder actions (in half the schedules every recorder closes first, so what they leave runs
    // with nobody attached); the engine answers everything in order and never fails again, pending retirements finish,
    // and time passes.
    if (chance(0.5)) {
      // Sometimes the owner pauses first: left paused, web and desktop still stop and keep it; the phone leaves it.
      if (chance(0.3)) {
        for (const r of attachedRecorders()) {
          if (r.controller.getState().phase !== "recording") continue;
          actor = r;
          void r.controller.pause();
          actor = null;
        }
        for (const op of controls.splice(0)) op.outcomes.run();
        for (const read of reads.splice(0)) read.answer();
        await flush();
        await check("the owner pauses before the close");
      }
      for (const r of attachedRecorders()) detach(r);
      await flush();
      await check("every recorder closes before the drain");
    }
    for (let step = 0; step < DRAIN; step += 1) {
      let name: string;
      if (controls.length > 0) {
        const head = controls.shift()!;
        head.outcomes.run();
        did(`engine ${head.kind} run`);
        name = `drain: engine ${head.kind} runs`;
      } else if (retiring !== null) {
        const id = retiring;
        retiring = null;
        void fake.plugin.status().then((status) => { if (status.id === id) void fake.plugin.discard(); });
        name = "drain: desktop retirement finishes";
      } else if (reads.length > 0) { reads.shift()!.answer(); name = "drain: status read answers"; }
      else if (sleepers.length > 0) {
        advanceClock();
        name = "drain: time passes";
      } else break;
      await flush();
      await check(name);
    }
    const id = await liveNow();
    const attached = attachedRecorders();
    if (!racedOnPhone && id && !native.has(id)) {
      const owned = attached.some((r) => r.controller.getState().phase !== "idle" && r.controller.getState().recordingId === id);
      const leftAlone = kind === "phone" && (await fake.plugin.status()).intent === "paused";
      // At rest a recorder's recording is shown, or (paused by its owner on the phone, or with a recorder attached that
      // is busy) still followed; never live unseen and unstopped with nobody attached. The phone is exempt once a status
      // read has hung (it stops only on a status it read).
      if (!owned && attached.length === 0 && !leftAlone && (kind !== "phone" || hungReads === 0)) fail(`at rest ${id} is live, unattended, and nothing stopped it`);
    } else if (!id && hungReads === 0 && controls.length === 0 && reads.length === 0 && attached.every((r) => r.controller.getState().phase === "idle")
      && __recorderOwnershipForTests().tracked.size === 0 && homeWorkRunning("recording")) {
      // Also after the phone's accepted race. (A status read that never answers keeps its Home work place: nothing
      // confirmed the end.)
      fail("at rest nothing records, yet a Home work place is still held");
    }
  } finally {
    for (const r of recorders) if (r.detach) { r.detach(); r.detach = null; }
    // Let what is left settle without the scheduler, so the next schedule starts clean.
    __setRecorderTrackerForTests({ waits: [WAIT_MS], sleep: () => new Promise<void>(() => {}) });
    for (const sleeper of sleepers.splice(0)) sleeper.wake();
    for (const read of reads.splice(0)) read.answer();
    for (const op of controls.splice(0)) op.outcomes.run();
    await flush();
  }
}

// Schedules local soaks found, replayed in CI as they ran there (their base seed fixes the engine kind).
const REGRESSIONS = [
  { base: 424_242, seed: 429_536, steps: 40 },
  { base: 7_777_000, seed: 7_777_476, steps: 56 },
];

test(`recorder ownership holds across ${SCHEDULES} seeded interleavings on web, desktop and phone engines`, async () => {
  for (let schedule = 0; schedule < SCHEDULES; schedule += 1) await runSchedule(SEED + schedule);
  for (const [index, { base, seed, steps }] of REGRESSIONS.entries()) await runSchedule(seed, base, steps, 810_000_000_000 + index * 100);
  if (process.env.RECORDER_MODEL_REPORT) console.log(JSON.stringify(coverage, null, 1));
  const missing = REQUIRED.filter((name) => (coverage[name] ?? 0) < MIN_PER_CELL).map((name) => `${name}: ${coverage[name] ?? 0}`);
  expect(missing).toEqual([]);
}, 120_000);
