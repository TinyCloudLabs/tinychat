// A closed (detached) recorder is inert: every entry point that reaches the engine or changes a recording's options
// does nothing once it has closed, including a call that was already waiting when it closed. The recording it left
// runs on, followed by its tracker (which reads status, and stops it only past the grace: not part of these tests).
import { afterEach, beforeEach, expect, test } from "bun:test";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { createFakeVoiceNotes, type FakeVoiceNotes } from "@/lib/voiceNotes/fakeVoiceNotes";
import { VoiceNotes, __setVoiceNotesForTests, type VoiceNotesPlugin } from "@/lib/voiceNotes/nativeVoiceNotes";
import { __resetCaptureEngineForTests, __setInstalledEngineForTests, type CaptureCapabilities } from "@/lib/voiceNotes/captureEngine";
import { __resetHomeWorkForTests } from "@/lib/homeReauthorizing";
import { isDiscarded, unmarkDiscarded } from "@/lib/voiceNotes/recorderSaves";
import { readTranscriberPreference, setDefaultIdentifySpeakers, setDefaultTranscriber } from "@/lib/voiceNotes/transcriberPreference";
import type { VoiceNotePipeline } from "@/lib/voiceNotes/voiceNotePipeline";
import {
  clearPartialAudioIssue, partialAudioDismissed, partialAudioScope, pendingAudioLossIds, savedPartialAudioIssues, savePartialAudioIssue,
} from "./partialAudioIssues";
import { installDom } from "@/test/dom";
import {
  __resetRecorderOwnershipForTests, __setRecorderTrackerForTests, createVoiceNoteRecorderController, type VoiceNoteRecorderController,
} from "./voiceNoteRecorderController";

const CAPABILITIES: CaptureCapabilities = {
  nativeShortcuts: true, presentRecorder: false, openSettings: true, micDeniedPresentation: true,
  background: false, localTranscription: false, desktopWhisper: true, offlineRecorder: false, nativeFileUpload: false,
  scopedDiscard: true, scopedStop: true, unattendedStop: "scoped",
};
const account = { did: "did:example:alice", spaceId: "space:alice" } as TinyCloudWeb;
const flush = async () => { for (let turn = 0; turn < 60; turn += 1) await Promise.resolve(); };
const saved = VoiceNotes;
let restoreDom: () => void;

// The saved default choices are shared by every test in the run: put back as they were. The notices and preferences
// these tests read are kept in a localStorage of their own.
let defaults: ReturnType<typeof readTranscriberPreference>;
let storageDescriptor: PropertyDescriptor | undefined;

beforeEach(() => {
  restoreDom = installDom();
  __resetHomeWorkForTests();
  __resetRecorderOwnershipForTests();
  defaults = readTranscriberPreference();
  storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  } });
  // The trackers a close leaves never reach the grace here.
  __setRecorderTrackerForTests({ sleep: () => new Promise<void>(() => {}) });
});
afterEach(async () => {
  if (storageDescriptor) Object.defineProperty(globalThis, "localStorage", storageDescriptor);
  else Reflect.deleteProperty(globalThis, "localStorage");
  await setDefaultTranscriber(defaults.transcriber);
  await setDefaultIdentifySpeakers(defaults.identifySpeakers);
  __setRecorderTrackerForTests(null);
  __resetRecorderOwnershipForTests();
  __resetCaptureEngineForTests();
  __setVoiceNotesForTests(saved, { available: null });
  __resetHomeWorkForTests();
  restoreDom();
});

/** Every engine call, by name. `hold`: calls of that name wait until released (or rejected). `retain`: events the engine
 * keeps until a listener is added, then replays to it in a microtask (as the browser engine does after a reload). */
function engineWithCalls(fake: FakeVoiceNotes) {
  const calls: string[] = [];
  const held = new Map<string, Array<(error?: unknown) => void>>();
  const holding = new Set<string>();
  const retained = new Map<string, unknown[]>();
  const engine = new Proxy(fake.plugin, {
    get(target, property: string) {
      const value = (target as unknown as Record<string, unknown>)[property];
      if (typeof value !== "function") return value;
      if (property === "addListener") {
        return async (event: string, listener: (payload: unknown) => void) => {
          const handle = await (value as (...a: unknown[]) => Promise<{ remove(): Promise<void> }>).apply(target, [event, listener]);
          const payloads = retained.get(event);
          if (!payloads?.length) return handle;
          let registered = true;
          queueMicrotask(() => { if (registered) for (const payload of payloads.splice(0)) listener(payload); });
          return { remove: async () => { registered = false; await handle.remove(); } };
        };
      }
      return async (...args: unknown[]) => {
        calls.push(property);
        if (holding.has(property)) {
          const error = await new Promise<unknown>((resolve) => { held.set(property, [...(held.get(property) ?? []), resolve]); });
          if (error !== undefined) throw error;
        }
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  }) as VoiceNotesPlugin;
  return {
    engine, calls,
    hold: (name: string) => { holding.add(name); },
    release: (name: string) => { holding.delete(name); for (const resolve of held.get(name)?.splice(0) ?? []) resolve(); },
    reject: (name: string, error: unknown) => { holding.delete(name); for (const resolve of held.get(name)?.splice(0) ?? []) resolve(error); },
    retain: (event: string, payload: unknown) => { retained.set(event, [...(retained.get(event) ?? []), payload]); },
  };
}

/** A pipeline that accepts saves and counts what is admitted. */
function countingPipeline() {
  const admitted: string[] = [];
  const pipeline = {
    isAccepting: () => true,
    resume: () => {},
    cancelAll: () => {},
    process: async (_account: unknown, id: string) => { admitted.push(`process ${id}`); return "saved"; },
    reconcileAll: async () => { admitted.push("reconcileAll"); },
  } as unknown as VoiceNotePipeline;
  return { pipeline, admitted };
}

function newController(pipeline?: VoiceNotePipeline): VoiceNoteRecorderController {
  return createVoiceNoteRecorderController({
    tcw: account, available: true, onDeviceReady: () => true, pipeline,
    transcriber: { check: async () => {}, noteSaved: () => {},
      snapshot: () => ({ availability: "available", consented: true, capabilities: { max_bytes: 1_000_000, diarization: true }, jobs: new Map() }) },
  });
}

/** The signed-in engine, its call log, and (not yet attached) a recorder on it. */
async function signedInEngine(pipeline?: VoiceNotePipeline) {
  const fake = createFakeVoiceNotes();
  const wrapped = engineWithCalls(fake);
  __setInstalledEngineForTests("tauri", CAPABILITIES);
  __setVoiceNotesForTests(wrapped.engine, { available: true });
  await fake.plugin.setCaptureDefaults({ accountDid: account.did!, transitionGen: 1, transcriber: "on-device", identifySpeakers: false });
  return { fake, recorder: newController(pipeline), ...wrapped };
}

/** A signed-in recorder recording on Local (its own choice for this recording), and the engine it talks to. */
async function recordingOnLocal(pipeline?: VoiceNotePipeline) {
  const engine = await signedInEngine(pipeline);
  const { fake, recorder } = engine;
  const detach = recorder.attach();
  await flush();
  await recorder.record();
  await flush();
  expect(recorder.getState().phase).toBe("recording");
  expect(await recorder.setTranscriber("on-device", { scope: "recording" })).toBe("ok");
  expect((await fake.plugin.status()).options?.transcriber).toBe("on-device");
  return { ...engine, detach };
}

/** The engine calls made after the recorder closed, but the status reads of the tracker following what it left. */
const after = (calls: string[], from: number) => calls.slice(from).filter((call) => call !== "status");

test("default choices (transcription and speakers) from a closed recorder change no default", async () => {
  const { fake, recorder, detach, calls } = await recordingOnLocal();
  // Private by default: speaker identification is a default an open recorder could change.
  expect(await recorder.setTranscriber("private-cloud", { scope: "default" })).toBe("ok");
  const before = await fake.plugin.getCaptureDefaults();
  detach();
  const closedAt = calls.length;
  expect(await recorder.setTranscriber("off", { scope: "default" })).toBe("unavailable");
  expect(await recorder.setIdentifySpeakers(true, "default")).toBe("unavailable");
  await flush();
  expect(after(calls, closedAt)).toEqual([]);
  expect(await fake.plugin.getCaptureDefaults()).toEqual(before);
});

test("a default Local choice waiting on the desktop model check when the recorder closes changes no default", async () => {
  const { fake, recorder, detach, calls } = await recordingOnLocal();
  expect(await recorder.setTranscriber("private-cloud", { scope: "default" })).toBe("ok");
  const before = await fake.plugin.getCaptureDefaults();
  const pending = recorder.setTranscriber("on-device", { scope: "default" });
  detach();
  const closedAt = calls.length;
  expect(await pending).toBe("unavailable");
  await flush();
  expect(after(calls, closedAt)).toEqual([]);
  expect(await fake.plugin.getCaptureDefaults()).toEqual(before);
});

test("a stale Private choice after the recorder closed leaves the live recording on Local", async () => {
  const { fake, recorder, detach, calls } = await recordingOnLocal();
  detach();
  const closedAt = calls.length;
  expect(await recorder.setTranscriber("private-cloud", { scope: "recording" })).toBe("unavailable");
  await flush();
  expect(after(calls, closedAt)).toEqual([]);
  expect(await fake.plugin.status()).toMatchObject({ state: "recording", options: { transcriber: "on-device" } });
  expect(recorder.getTranscriber().id).toBe("on-device");
});

test("a Local choice waiting on the desktop model check when the recorder closes changes nothing", async () => {
  const { fake, recorder, detach, calls } = await recordingOnLocal();
  await recorder.setTranscriber("off", { scope: "recording" });
  const pending = recorder.setTranscriber("on-device", { scope: "recording" });
  detach();
  const closedAt = calls.length;
  expect(await pending).toBe("unavailable");
  await flush();
  expect(after(calls, closedAt)).toEqual([]);
  expect((await fake.plugin.status()).options?.transcriber).toBe("off");
});

test("options read back after the recorder closed are not taken: its choice stays as it was at the close", async () => {
  const { fake, recorder, detach, hold, release } = await recordingOnLocal();
  hold("status");
  const choosing = recorder.setTranscriber("off", { scope: "recording" });
  await flush();
  detach();
  const atClose = recorder.getTranscriber();
  // The recording's options change on the device after the close; the held read answers with them.
  await fake.plugin.setRecordingOptions({ transcriber: "private-cloud" });
  release("status");
  await choosing;
  await flush();
  expect(recorder.getTranscriber()).toEqual(atClose);
});

test("speaker identification for the recording does nothing once the recorder closed", async () => {
  const { fake, recorder, detach, calls } = await recordingOnLocal();
  expect(await recorder.setTranscriber("private-cloud", { scope: "recording" })).toBe("ok");
  const before = (await fake.plugin.status()).options?.identifySpeakers;
  detach();
  const closedAt = calls.length;
  expect(await recorder.setIdentifySpeakers(!before, "recording")).toBe("unavailable");
  await flush();
  expect(after(calls, closedAt)).toEqual([]);
  expect((await fake.plugin.status()).options?.identifySpeakers).toBe(before);
});

test("Stop, Discard, Pause and Resume do nothing once the recorder closed", async () => {
  const { fake, recorder, detach, calls } = await recordingOnLocal();
  detach();
  const closedAt = calls.length;
  await recorder.pause();
  await recorder.resume();
  await recorder.stop();
  await recorder.discard();
  await flush();
  expect(after(calls, closedAt)).toEqual([]);
  expect(await fake.plugin.status()).toMatchObject({ state: "recording", intent: "recording" });
});

test("Record does nothing once the recorder closed", async () => {
  const fake = createFakeVoiceNotes(undefined, { idBase: 731_000_000_000 });
  const { engine, calls } = engineWithCalls(fake);
  __setInstalledEngineForTests("tauri", CAPABILITIES);
  __setVoiceNotesForTests(engine, { available: true });
  const recorder = createVoiceNoteRecorderController({ tcw: null, available: true, onDeviceReady: () => true,
    transcriber: { check: async () => {}, noteSaved: () => {} } });
  const detach = recorder.attach();
  await flush();
  expect(recorder.getState().ready).toBe(true);
  detach();
  const closedAt = calls.length;
  await recorder.record();
  await flush();
  expect(after(calls, closedAt)).toEqual([]);
  expect((await fake.plugin.status()).state).toBe("idle");
});

test("a Stop answered after the recorder closed leaves the save to the pending saves: the closed recorder calls nothing more", async () => {
  const { fake, recorder, detach, calls, hold, release } = await recordingOnLocal();
  hold("stop");
  const stopping = recorder.stop();
  await flush();
  detach();
  const closedAt = calls.length;
  release("stop");
  await stopping;
  await flush();
  expect(after(calls, closedAt)).toEqual([]);
  // Kept on the device, for the pending saves.
  expect((await fake.plugin.listPending()).recordings).toHaveLength(1);
});

test("a Discard answered after the recorder closed leaves its cleanup to the discard mark: the closed recorder calls nothing more", async () => {
  const { fake, recorder, detach, calls, hold, release } = await recordingOnLocal();
  // The limit stopped it first: an open recorder would now delete the committed audio itself.
  fake.plugin.discard = async () => { throw Object.assign(new Error("not recording"), { code: "not_recording" }); };
  hold("discard");
  const id = recorder.getState().recordingId!;
  const discarding = recorder.discard();
  await flush();
  detach();
  const closedAt = calls.length;
  release("discard");
  await discarding;
  await flush();
  try {
    expect(after(calls, closedAt)).toEqual([]);
    // The mark stays for the pending saves and the next launch to act on.
    expect(isDiscarded(id)).toBe(true);
  } finally {
    // Shared by every test in the run (the fake engine numbers its recordings the same way each time).
    unmarkDiscarded(id);
  }
});

test("dismissing the shortcut recovery, waiting on its status read when the recorder closes, dismisses nothing", async () => {
  const { fake, recorder, detach, calls, hold, release } = await recordingOnLocal();
  // The phone is showing its denied-microphone recovery: an open recorder's dismissal would reach the engine.
  const status = fake.plugin.status.bind(fake.plugin);
  fake.plugin.status = async () => ({ ...(await status()), micDeniedPresentation: true });
  hold("status");
  const pending = recorder.dismissShortcutRecovery();
  await flush();
  detach();
  release("status");
  await pending;
  await flush();
  expect(calls).not.toContain("dismissShortcutRecovery");
});

test("Keep going (the limit) does nothing once the recorder closed", async () => {
  const { recorder, detach, calls } = await recordingOnLocal();
  expect(recorder.getState().autoStop).toBe(true);
  const extend = recorder.extendLimit;
  expect(extend).toBeDefined();
  detach();
  const closedAt = calls.length;
  await extend!();
  await recorder.extendLimit?.("none");
  await flush();
  expect(after(calls, closedAt)).toEqual([]);
});

test("Open settings and Save now do nothing once the recorder closed", async () => {
  const { recorder, detach, calls } = await recordingOnLocal();
  detach();
  const closedAt = calls.length;
  await recorder.openSettings();
  await recorder.retryPending();
  await flush();
  expect(after(calls, closedAt)).toEqual([]);
});

test("a default transcription choice queued behind the engine's defaults read when the recorder closes writes nothing", async () => {
  const { recorder, detach, calls, hold, release } = await recordingOnLocal();
  const before = readTranscriberPreference();
  hold("getCaptureDefaults");
  const choosing = recorder.setTranscriber("off", { scope: "default" });
  await flush();
  detach();
  const closedAt = calls.length;
  release("getCaptureDefaults");
  expect(await choosing).toBe("unavailable");
  await flush();
  expect(after(calls, closedAt)).not.toContain("setCaptureDefaults");
  expect(readTranscriberPreference()).toEqual(before);
});

test("a default speaker choice queued behind the engine's defaults read when the recorder closes writes nothing", async () => {
  const { recorder, detach, calls, hold, release } = await recordingOnLocal();
  // Private by default: speaker identification is a default an open recorder could change.
  expect(await recorder.setTranscriber("private-cloud", { scope: "default" })).toBe("ok");
  const before = readTranscriberPreference();
  hold("getCaptureDefaults");
  const choosing = recorder.setIdentifySpeakers(!before.identifySpeakers, "default");
  await flush();
  detach();
  const closedAt = calls.length;
  release("getCaptureDefaults");
  expect(await choosing).toBe("unavailable");
  await flush();
  expect(after(calls, closedAt)).not.toContain("setCaptureDefaults");
  expect(readTranscriberPreference()).toEqual(before);
});

test("Save now waiting on the account defaults read when the recorder closes writes no default and saves nothing", async () => {
  const { pipeline, admitted } = countingPipeline();
  const { recorder, detach, calls, hold, release } = await recordingOnLocal(pipeline);
  hold("getCaptureDefaults");
  const saving = recorder.retryPending();
  await flush();
  detach();
  const closedAt = calls.length;
  release("getCaptureDefaults");
  await saving;
  await flush();
  expect(after(calls, closedAt)).not.toContain("setCaptureDefaults");
  expect(admitted).toEqual([]);
});

test("a retained auto-stop replayed to a recorder that closes in the same turn is saved, deleted and admitted by nothing", async () => {
  const { pipeline, admitted } = countingPipeline();
  const { fake, recorder, calls, retain } = await signedInEngine(pipeline);
  // An auto-stopped recording from before a reload, kept by the engine until a listener hears it.
  await fake.plugin.start();
  const recording = await fake.plugin.stop();
  // This account's own recording: an open recorder would admit its save at once.
  retain("autoStopped", { recording: { ...recording, owner: account.did }, reason: "max_duration", maxDurationMs: 60_000, id: recording.id });
  const detach = recorder.attach();
  detach();
  const closedAt = calls.length;
  await flush();
  expect(admitted).toEqual([]);
  // Only the reads the attach itself began (what is live, what is pending); nothing deleted, stopped or written.
  expect(after(calls, closedAt).filter((call) => call !== "status" && call !== "listPending")).toEqual([]);
});

test("an auto-stop of another recording, replayed to a recorder reattached and closed in the same turn, is admitted by nothing", async () => {
  const { pipeline, admitted } = countingPipeline();
  const { recorder, detach, retain } = await recordingOnLocal(pipeline);
  detach();
  // An earlier recording, not the one this recorder showed: an open recorder saves it in the background.
  const earlier = { id: "earlier-note", startedAt: 1, durationMs: 1_000, mimeType: "audio/mp4", sizeBytes: 4, owner: account.did,
    options: { transcriber: "off", identifySpeakers: false } };
  retain("autoStopped", { recording: earlier, reason: "max_duration", maxDurationMs: 60_000, id: earlier.id });
  const again = recorder.attach();
  again();
  await flush();
  expect(admitted).toEqual([]);
});

test("a write failure replayed to a recorder that closes in the same turn records no audio loss", async () => {
  const { recorder, retain } = await signedInEngine();
  retain("writeFailure", { id: "lost-note", error: "disk full" });
  const detach = recorder.attach();
  detach();
  await flush();
  expect(pendingAudioLossIds(partialAudioScope(account.did, account.spaceId)).has("lost-note")).toBe(false);
});

test("a Discard that succeeds after the recorder closed keeps the discard intent: the closed recorder cleans up nothing", async () => {
  const { recorder, detach, calls, hold, release } = await recordingOnLocal();
  hold("discard");
  const id = recorder.getState().recordingId!;
  const discarding = recorder.discard();
  await flush();
  detach();
  const closedAt = calls.length;
  release("discard");
  await discarding;
  await flush();
  try {
    expect(isDiscarded(id)).toBe(true);
    expect(after(calls, closedAt)).toEqual([]);
  } finally {
    unmarkDiscarded(id);
  }
});

test("a rejected Discard answered after the recorder closed keeps the discard intent and runs no recovery", async () => {
  const { fake, recorder, detach, calls, hold, release } = await recordingOnLocal();
  fake.plugin.discard = async () => { throw Object.assign(new Error("busy"), { code: "engine_busy" }); };
  hold("discard");
  const id = recorder.getState().recordingId!;
  const discarding = recorder.discard();
  await flush();
  detach();
  const closedAt = calls.length;
  release("discard");
  await discarding;
  await flush();
  try {
    expect(isDiscarded(id)).toBe(true);
    expect(after(calls, closedAt)).toEqual([]);
  } finally {
    unmarkDiscarded(id);
  }
});

test("a stopped recording whose audio is ready only after the recorder closed is not admitted by it", async () => {
  const { pipeline, admitted } = countingPipeline();
  const { fake, recorder, detach, hold, release } = await recordingOnLocal(pipeline);
  // The Mac imports the playable file after the stop: saves wait for it.
  const stop = fake.plugin.stop.bind(fake.plugin);
  fake.plugin.stop = async (options) => {
    const stopped = await stop(options);
    return { ...stopped, ledger: { ...stopped.ledger, localAudio: { state: "preparing" } } } as typeof stopped;
  };
  fake.plugin.awaitAudioReady = async () => {};
  hold("awaitAudioReady");
  await recorder.stop();
  await flush();
  detach();
  release("awaitAudioReady");
  await flush();
  expect(admitted).toEqual([]);
});

test("a partial-audio notice is not dismissed from a closed recorder (the next recorder shows it)", async () => {
  const scope = partialAudioScope(account.did, account.spaceId);
  const { fake, recorder } = await signedInEngine();
  await fake.plugin.start();
  const { id } = await fake.plugin.stop();
  savePartialAudioIssue(scope, id, { kind: "partial_audio" });
  const detach = recorder.attach();
  await flush();
  expect(recorder.getState().captureIssues[id]?.kind).toBe("partial_audio");
  detach();
  expect(recorder.dismissCaptureIssue(id)).toBe(false);
  expect(partialAudioDismissed(scope, id)).toBe(false);
});

test("a default choice whose defaults read fails after the recorder closed leaves another window's newer choice", async () => {
  const { recorder, detach, hold, reject } = await recordingOnLocal();
  expect(await recorder.setTranscriber("private-cloud", { scope: "default" })).toBe("ok");
  hold("getCaptureDefaults");
  const choosing = recorder.setIdentifySpeakers(true, "default").catch(() => "failed");
  await flush();
  detach();
  // Another window chooses Off meanwhile; then the closed recorder's read fails.
  localStorage.setItem("exo.voiceNotes.transcriber", "off");
  reject("getCaptureDefaults", Object.assign(new Error("unavailable"), { code: "unavailable" }));
  await choosing;
  await flush();
  expect(localStorage.getItem("exo.voiceNotes.transcriber")).toBe("off");
});

test("a default choice whose engine write fails still puts the engine's default back", async () => {
  const { fake, recorder, calls } = await recordingOnLocal();
  const write = fake.plugin.setCaptureDefaults.bind(fake.plugin);
  let failures = 1;
  fake.plugin.setCaptureDefaults = async (defaults) => {
    if (failures-- > 0) throw Object.assign(new Error("write failed"), { code: "unavailable" });
    return write(defaults);
  };
  const before = calls.length;
  await expect(recorder.setTranscriber("off", { scope: "default" })).rejects.toThrow("write failed");
  // The write, then the rollback.
  expect(calls.slice(before).filter((call) => call === "setCaptureDefaults")).toHaveLength(2);
});

test("a committed event replayed to a recorder reattached and closed in the same turn re-persists no deleted notice", async () => {
  const scope = partialAudioScope(account.did, account.spaceId);
  const { fake, recorder, retain } = await signedInEngine();
  await fake.plugin.start();
  const { id } = await fake.plugin.stop();
  savePartialAudioIssue(scope, id, { kind: "partial_audio" });
  const detach = recorder.attach();
  await flush();
  expect(recorder.getState().captureIssues[id]?.kind).toBe("partial_audio");
  detach();
  // The recording is deleted elsewhere: its notice goes.
  clearPartialAudioIssue(scope, id, false);
  retain("committed", { id });
  const again = recorder.attach();
  again();
  await flush();
  expect(savedPartialAudioIssues(scope)[id]).toBeUndefined();
});

test("a recovered event replayed to a recorder reattached and closed in the same turn re-persists no deleted notice", async () => {
  const scope = partialAudioScope(account.did, account.spaceId);
  const { fake, recorder, retain } = await signedInEngine();
  await fake.plugin.start();
  const { id } = await fake.plugin.stop();
  savePartialAudioIssue(scope, id, { kind: "partial_audio" });
  const detach = recorder.attach();
  await flush();
  expect(recorder.getState().captureIssues[id]?.kind).toBe("partial_audio");
  detach();
  clearPartialAudioIssue(scope, id, false);
  retain("recovered", { id });
  const again = recorder.attach();
  again();
  await flush();
  expect(savedPartialAudioIssues(scope)[id]).toBeUndefined();
});
