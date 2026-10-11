// The pipeline's input from composed fake stores: each case builds the stores' answers as plain facts
// (`buildNotePipelineInput`), runs the real selector, and asserts what it says. The actions run against the real
// store functions with the native plugin faked.
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import type { VoiceNoteTranscriptionProps } from "@/capture/recorder/transcriptionProps";
import { notePipeline, type NotePipeline } from "./notePipeline";
import type { OnDeviceSttStatus, OnDeviceSttPlugin, SttModelId } from "./onDeviceStt";
import { __setOnDeviceSttForTests } from "./onDeviceStt";
import { __resetOnDeviceSttStoreForTests } from "./onDeviceSttStore";
import {
  buildNotePipelineInput,
  combinedModel,
  notesSyncState,
  pipelineRoute,
  runPipelineAction,
  transcriptRetryTarget,
  type NotePipelineFacts,
  type PipelineActionEnv,
} from "./useNotePipeline";
import { pendingStore } from "./recorderSaves";
import { voiceNoteMarkdownKvKey } from "./voiceNoteStore";

const ID = "note-1";
const IDLE_LANE = { busy: false, depth: 0 };
const EDITED = "2026-10-11T10:00:00.000Z";

function status(models: Partial<Record<SttModelId, Partial<OnDeviceSttStatus["models"][number]>>> = {}, patch: Partial<OnDeviceSttStatus> = {}): OnDeviceSttStatus {
  const ids: SttModelId[] = ["parakeet-tdt-0.6b-v3-int8", "parakeet-tdt-110m-en-int8", "silero-vad", "diarization"];
  return {
    models: ids.map((id) => ({ id, state: "absent" as const, bytes: 0, totalBytes: 0, error: null, ...models[id] })),
    pack: "full", autoDownload: true, download: { policy: "wifi", state: "idle" },
    engine: "none", appleSpeech: "unsupported", queue: [], ...patch,
  };
}
const READY = { state: "ready" as const, bytes: 100, totalBytes: 100 };
const BOTH_READY = status({ "parakeet-tdt-0.6b-v3-int8": READY, "silero-vad": { state: "ready", bytes: 10, totalBytes: 10 } });

function facts(patch: Partial<NotePipelineFacts> = {}): NotePipelineFacts {
  return {
    id: ID, device: "phone", online: true, saved: true, rowMetadata: null, localNote: null, native: null,
    capture: { finalizing: false, issue: null }, pending: null, lane: IDLE_LANE, onDeviceStatus: null,
    transcriptSync: null, cloudJob: null,
    noteSync: { syncing: false, failed: false, skip: null, syncedAt: null, attempting: false },
    ...patch,
  };
}
const run = (patch: Partial<NotePipelineFacts>): NotePipeline => notePipeline(buildNotePipelineInput(facts(patch)));
const stateOf = (pipeline: NotePipeline, key: "phone" | "space" | "transcript" | "notes") => pipeline.steps.find((step) => step.key === key)?.state;

describe("the pipeline from composed stores", () => {
  test("a private-cloud note still uploading: the space step is active and the note is not done", () => {
    const pipeline = run({
      saved: false,
      native: { transcriber: "private-cloud", stt: null },
      pending: { id: ID, startedAt: 0, durationMs: 1000, upload: { state: "uploading", bytes: 40, total: 100 } },
    });
    expect(stateOf(pipeline, "space")).toBe("active");
    expect(pipeline.current).toBe("space");
    expect(pipeline.done).toBe(false);
    expect(pipeline.blocker).toBeUndefined();
  });

  test("signed out: the space step is blocked with the sign-in action, from the selector's own copy", () => {
    const pipeline = run({
      saved: false,
      native: { transcriber: "off", stt: null },
      pending: { id: ID, startedAt: 0, durationMs: 1000, held: "signed-out" },
    });
    expect(stateOf(pipeline, "space")).toBe("blocked");
    expect(pipeline.blocker?.action?.kind).toBe("sign-in");
    expect(pipeline.blocker?.cause).not.toContain("ownership check");
  });

  test("a Local note whose model is absent is waiting for it, with the get-model action", () => {
    const pipeline = run({
      saved: true,
      native: { transcriber: "on-device", stt: { state: "waiting_for_model", error: null } },
      onDeviceStatus: status(),
    });
    expect(stateOf(pipeline, "transcript")).toBe("blocked");
    expect(pipeline.current).toBe("transcript");
    expect(pipeline.blocker?.action?.kind).toBe("get-model");
  });

  test("a Local note with the model ready and a transcript in the space is done", () => {
    const pipeline = run({
      saved: true,
      rowMetadata: { transcription_outcome: "transcribed" },
      native: { transcriber: "on-device", stt: { state: "done", error: null } },
      onDeviceStatus: BOTH_READY,
      transcriptSync: { state: "synced" },
    });
    expect(pipeline.done).toBe(true);
    expect(pipeline.current).toBeNull();
  });

  test("a private-cloud job that failed is a failed transcript step with a retry", () => {
    const pipeline = run({
      saved: true,
      native: { transcriber: "private-cloud", stt: null },
      cloudJob: { kind: "failed", message: "the service said no", retryable: true } as never,
    });
    expect(stateOf(pipeline, "transcript")).toBe("failed");
    expect(pipeline.blocker?.action?.kind).toBe("retry");
  });

  test("a note with written notes that never synced offers to sync them (idle), then synced on the row's own evidence", () => {
    const local = { editedAt: EDITED, hasContent: true };
    const before = run({ saved: true, native: { transcriber: "off", stt: null }, rowMetadata: {}, localNote: local });
    expect(stateOf(before, "notes")).toBe("blocked");
    expect(before.blocker?.action?.kind).toBe("retry");
    expect(before.done).toBe(false);
    const after = run({
      saved: true, native: { transcriber: "off", stt: null }, localNote: local,
      rowMetadata: { note_kv_key: voiceNoteMarkdownKvKey(ID), note_edited_at: EDITED },
    });
    expect(stateOf(after, "notes")).toBe("done");
    expect(after.done).toBe(true);
  });

  test("a failed notes sync is a failed notes step with a retry; the next edit makes the earlier success stale", () => {
    const local = { editedAt: EDITED, hasContent: true };
    const failed = run({ saved: true, native: { transcriber: "off", stt: null }, rowMetadata: {}, localNote: local, noteSync: { syncing: false, failed: true, skip: null, syncedAt: null } });
    expect(stateOf(failed, "notes")).toBe("failed");
    expect(failed.blocker?.action?.kind).toBe("retry");
    const stale = run({ saved: true, native: { transcriber: "off", stt: null }, rowMetadata: {}, localNote: local, noteSync: { syncing: false, failed: false, skip: null, syncedAt: "2026-10-11T09:00:00.000Z" } });
    expect(stateOf(stale, "notes")).not.toBe("done");
  });

  test("offline: the space step waits for the network, with nothing to press", () => {
    const pipeline = run({ saved: false, online: false, native: { transcriber: "off", stt: null }, pending: { id: ID, startedAt: 0, durationMs: 1000 } });
    expect(stateOf(pipeline, "space")).not.toBe("done");
    expect(pipeline.done).toBe(false);
  });
});

describe("route", () => {
  test("the committed mode decides; a Local note moved to private cloud shows as a cloud job", () => {
    expect(pipelineRoute({ transcriber: "off", stt: null }, true)).toBe("off");
    expect(pipelineRoute({ transcriber: "on-device", stt: null }, false)).toBe("on-device");
    expect(pipelineRoute({ transcriber: "on-device", stt: null }, true)).toBe("private-cloud");
    expect(pipelineRoute({ transcriber: "private-cloud", stt: null }, false)).toBe("private-cloud");
    expect(pipelineRoute({ transcriber: "assemblyai", stt: null }, false)).toBe("private-cloud");
  });

  test("a note this phone has no committed mode for: a cloud job or a native job says where, else nobody is transcribing it", () => {
    expect(pipelineRoute(null, true)).toBe("private-cloud");
    expect(pipelineRoute(null, false)).toBe("off");
    expect(pipelineRoute({ transcriber: null, stt: { state: "queued", error: null } }, false)).toBe("on-device");
  });
});

describe("decision (b): primary model and VAD combine into one model", () => {
  test("only both ready is ready; sizes add up", () => {
    const model = combinedModel(BOTH_READY);
    expect(model).toEqual({ state: "ready", bytes: 110, totalBytes: 110, error: null });
  });

  test("the least ready of the two wins, so a ready primary model with the VAD still downloading is downloading", () => {
    const model = combinedModel(status({ "parakeet-tdt-0.6b-v3-int8": READY, "silero-vad": { state: "downloading", bytes: 2, totalBytes: 10 } }));
    expect(model?.state).toBe("downloading");
    expect(model?.bytes).toBe(102);
    expect(model?.totalBytes).toBe(110);
  });

  test("a failure in either beats everything and carries its error", () => {
    const model = combinedModel(status({ "parakeet-tdt-0.6b-v3-int8": { state: "downloading", bytes: 1, totalBytes: 9 }, "silero-vad": { state: "failed", error: "checksum" } }));
    expect(model?.state).toBe("failed");
    expect(model?.error).toBe("checksum");
  });

  test("the RAM tier picks the primary model, and a status with no models says nothing", () => {
    const small = status({ "parakeet-tdt-110m-en-int8": READY, "silero-vad": READY, "parakeet-tdt-0.6b-v3-int8": { state: "absent" } }, { pack: "small" });
    expect(combinedModel(small)?.state).toBe("ready");
    expect(combinedModel({ ...status(), models: [] })).toBeNull();
  });
});

describe("decision (a): notes are synced on positive evidence only", () => {
  const base = { id: ID, saved: true, noteSync: { syncing: false, failed: false, skip: null, syncedAt: null, attempting: false } };
  const local = { editedAt: EDITED, hasContent: true };

  test("no error is not evidence", () => {
    expect(notesSyncState({ ...base, rowMetadata: null, localNote: local })).toEqual({ state: "idle" });
    expect(notesSyncState({ ...base, rowMetadata: {}, localNote: local })).toEqual({ state: "idle" });
  });

  test("the row's pointer for this revision is evidence; another revision is not", () => {
    const row = (editedAt: string) => ({ note_kv_key: voiceNoteMarkdownKvKey(ID), note_edited_at: editedAt });
    expect(notesSyncState({ ...base, rowMetadata: row(EDITED), localNote: local })).toEqual({ state: "synced" });
    expect(notesSyncState({ ...base, rowMetadata: row("2026-10-10T00:00:00.000Z"), localNote: local })).toEqual({ state: "idle" });
  });

  test("a sync that succeeded for the revision that is local now is evidence; an older one is not", () => {
    expect(notesSyncState({ ...base, rowMetadata: null, localNote: local, noteSync: { ...base.noteSync, syncedAt: EDITED } })).toEqual({ state: "synced" });
    expect(notesSyncState({ ...base, rowMetadata: null, localNote: local, noteSync: { ...base.noteSync, syncedAt: "2026-10-09T00:00:00.000Z" } })).toEqual({ state: "idle" });
  });

  test("running, failed and skipped syncs say so; nothing written and no row pointer is skipped", () => {
    expect(notesSyncState({ ...base, rowMetadata: null, localNote: local, noteSync: { ...base.noteSync, syncing: true } })).toEqual({ state: "syncing" });
    expect(notesSyncState({ ...base, rowMetadata: null, localNote: local, noteSync: { ...base.noteSync, failed: true } })).toEqual({ state: "failed" });
    expect(notesSyncState({ ...base, rowMetadata: null, localNote: local, noteSync: { ...base.noteSync, attempting: true } })).toEqual({ state: "syncing" });
    // The first attempt only stands in for "idle": a settled outcome in the stores outranks it.
    expect(notesSyncState({ ...base, rowMetadata: null, localNote: local, noteSync: { ...base.noteSync, attempting: true, failed: true } })).toEqual({ state: "failed" });
    expect(notesSyncState({ ...base, rowMetadata: null, localNote: local, noteSync: { ...base.noteSync, attempting: true, syncedAt: EDITED } })).toEqual({ state: "synced" });
    expect(notesSyncState({ ...base, rowMetadata: null, localNote: null })).toEqual({ state: "skipped", reason: "no-note" });
    expect(notesSyncState({ ...base, rowMetadata: { note_kv_key: "elsewhere" }, localNote: null })).toEqual({ state: "synced" });
  });
});

describe("failed reads are never read as absent or ready", () => {
  const local = { editedAt: EDITED, hasContent: true };

  test("a failed ledger read shows its cause on the transcript step, and the note is not done", () => {
    const pipeline = run({ saved: true, native: null, readError: "The phone's note list wouldn't open: busy" });
    expect(stateOf(pipeline, "transcript")).toBe("failed");
    expect(pipeline.blocker?.cause).toBe("Couldn't check this note's transcript · The phone's note list wouldn't open: busy");
    expect(pipeline.blocker?.action?.kind).toBe("retry");
    expect(pipeline.done).toBe(false);
  });

  test("a failed read of the note's own text is a failed notes step with its cause, never skipped", () => {
    const pipeline = run({ saved: true, native: { transcriber: "off", stt: null }, localNote: null, localNoteError: "EIO" });
    expect(stateOf(pipeline, "notes")).toBe("failed");
    expect(pipeline.blocker?.cause).toBe("Couldn't read this note's text on this phone · EIO");
    expect(pipeline.done).toBe(false);
  });

  test("a read that worked and found nothing is still skipped (absence is not an error)", () => {
    const pipeline = run({ saved: true, native: { transcriber: "off", stt: null }, localNote: null });
    expect(stateOf(pipeline, "notes")).toBe("skipped");
    expect(pipeline.done).toBe(true);
  });

  test("unsynced local notes offer Try again once the transcript is settled; they wait their turn behind a running one", () => {
    const idle = run({ saved: true, native: { transcriber: "off", stt: null }, rowMetadata: {}, localNote: local });
    expect(idle.blocker?.cause).toBe("Your notes haven't reached your space yet");
    const behind = run({ saved: true, native: { transcriber: "private-cloud", stt: null }, rowMetadata: {}, localNote: local, cloudJob: { kind: "active", status: { kind: "processing", completed: 1, total: 3 } } as never });
    expect(stateOf(behind, "notes")).toBe("upcoming");
    expect(behind.current).toBe("transcript");
  });
});

describe("durable transcript evidence without a library row (the receipt)", () => {
  const onDevice = { transcriber: "on-device" as const, stt: { state: "done" as const, error: null } };

  test("the ledger's saved transcript sync covers the outcome it was written for", () => {
    const pipeline = run({
      saved: true, rowMetadata: null, onDeviceStatus: BOTH_READY,
      native: { ...onDevice, transcriptSync: { state: "saved" } as never, transcriptOutcome: "transcribed" },
    });
    expect(stateOf(pipeline, "transcript")).toBe("done");
  });

  test("a ledger sync that is not saved proves nothing", () => {
    const pipeline = run({
      saved: true, rowMetadata: null, onDeviceStatus: BOTH_READY,
      native: { ...onDevice, transcriptSync: { state: "pending" } as never, transcriptOutcome: "transcribed" },
    });
    expect(stateOf(pipeline, "transcript")).not.toBe("done");
  });

  test("the space row's own outcome is the evidence when a row was read", () => {
    const pipeline = run({ saved: true, rowMetadata: { transcription_outcome: "no_speech" }, native: { ...onDevice, transcriptSync: null, transcriptOutcome: null }, onDeviceStatus: BOTH_READY });
    expect(stateOf(pipeline, "transcript")).toBe("done");
  });
});

describe("a parked recording", () => {
  test("shows Couldn't recover with the audio kept, and no upload progress", () => {
    const pipeline = run({
      saved: false, native: { transcriber: "off", stt: null },
      capture: { finalizing: false, issue: { kind: "quarantined" } },
      pending: { id: ID, startedAt: 0, durationMs: 1000, upload: { state: "uploading", bytes: 40, total: 100 } },
    });
    expect(stateOf(pipeline, "phone")).toBe("failed");
    expect(pipeline.blocker?.cause).toBe("Couldn't recover · audio kept");
    expect(stateOf(pipeline, "space")).toBe("upcoming");
  });
});

describe("transcriptRetryTarget", () => {
  test("says which retry the transcript step means", () => {
    const input = (patch: Partial<NotePipelineFacts>) => buildNotePipelineInput(facts(patch));
    expect(transcriptRetryTarget(input({ native: { transcriber: "private-cloud", stt: null } }))).toBe("private-cloud");
    expect(transcriptRetryTarget(input({ native: { transcriber: "on-device", stt: { state: "waiting_for_model", error: null } }, onDeviceStatus: status() }))).toBe("model");
    expect(transcriptRetryTarget(input({ native: { transcriber: "on-device", stt: { state: "failed", error: "x" } }, onDeviceStatus: BOTH_READY }))).toBe("note");
    expect(transcriptRetryTarget(input({
      native: { transcriber: "on-device", stt: { state: "done", error: null } }, onDeviceStatus: BOTH_READY,
      transcriptSync: { state: "failed", message: "write refused" },
    }))).toBe("sync");
  });
});

describe("actions", () => {
  let errors: ReturnType<typeof spyOn>;
  beforeEach(() => { errors = spyOn(console, "error").mockImplementation(() => {}); });
  afterEach(() => { errors.mockRestore(); });

  const transcription = (patch: Partial<VoiceNoteTranscriptionProps> = {}): VoiceNoteTranscriptionProps => ({
    availability: "available", consented: true, maxSeconds: 600, jobs: new Map(), onTranscribe: () => {}, onConsent: () => {}, onTurnOff: () => {}, onRecheck: () => {}, ...patch,
  } as VoiceNoteTranscriptionProps);
  const envFor = (patch: Partial<NotePipelineFacts>, env: Partial<PipelineActionEnv> = {}): PipelineActionEnv => {
    const input = buildNotePipelineInput(facts(patch));
    return { id: ID, tcw: null, pipeline: notePipeline(input), input, transcription: undefined, latestTranscription: () => env.transcription, saveNow: () => {}, signIn: null, reread: () => {}, ...env };
  };
  const signedOutEnv = (env: Partial<PipelineActionEnv> = {}) => envFor({
    saved: false, native: { transcriber: "off", stt: null }, pending: { id: ID, startedAt: 0, durationMs: 1, held: "signed-out" },
  }, env);

  test("sign-in calls the app's entry; a rejection gets calm copy", async () => {
    let calls = 0;
    expect(await runPipelineAction("sign-in", signedOutEnv({ signIn: () => { calls += 1; } }))).toBeNull();
    expect(calls).toBe(1);
    expect(await runPipelineAction("sign-in", signedOutEnv({ signIn: async () => { throw new Error("the browser would not open"); } }))).toBe("Couldn't complete this step. Try again.");
    expect(await runPipelineAction("sign-in", signedOutEnv({ signIn: null }))).toBe("Signing in isn't available here.");
  });

  test("retry on the space step is Save now", async () => {
    let saves = 0;
    const env = envFor({ saved: false, native: { transcriber: "off", stt: null }, pending: { id: ID, startedAt: 0, durationMs: 1, failed: { kind: "timeout", message: "deadline" } } }, { saveNow: () => { saves += 1; } });
    expect(env.pipeline.current).toBe("space");
    expect(await runPipelineAction("retry", env)).toBeNull();
    expect(saves).toBe(1);
  });

  test("retry on a private-cloud transcript sends the note to the transcriber", async () => {
    const sent: string[] = [];
    const env = envFor(
      { saved: true, native: { transcriber: "private-cloud", stt: null }, cloudJob: { kind: "failed", message: "no", retryable: true } as never },
      { transcription: transcription({ onTranscribe: (id: string) => { sent.push(id); } }) },
    );
    expect(env.pipeline.current).toBe("transcript");
    expect(await runPipelineAction("retry", env)).toBeNull();
    expect(sent).toEqual([ID]);
  });

  test("check-again asks the transcriber; its rejection gets calm copy", async () => {
    let checks = 0;
    expect(await runPipelineAction("check-again", envFor({}, { transcription: transcription({ onRecheck: () => { checks += 1; } }) }))).toBeNull();
    expect(checks).toBe(1);
    expect(await runPipelineAction("check-again", envFor({}, { transcription: transcription({ onRecheck: async () => { throw new Error("offline"); } }) }))).toBe("Couldn't complete this step. Try again.");
    expect(await runPipelineAction("check-again", envFor({}))).toBe("Private transcription isn't available here.");
  });

  test("check-again shows the cause the transcriber kept when its check settles on a failure", async () => {
    const failed = transcription({ availability: "failed", checkError: "the capability request timed out" });
    expect(await runPipelineAction("check-again", envFor({}, { transcription: failed, latestTranscription: () => failed })))
      .toBe("Couldn't check private transcription right now. Try again.");
    const noCause = transcription({ availability: "failed" });
    expect(await runPipelineAction("check-again", envFor({}, { transcription: noCause, latestTranscription: () => noCause })))
      .toBe("Couldn't check private transcription right now. Try again.");
    const ok = transcription();
    expect(await runPipelineAction("check-again", envFor({}, { transcription: ok, latestTranscription: () => ok }))).toBeNull();
  });

  test("space retry awaits Save now: its rejection, and a failure the store reports instead of throwing, both come back", async () => {
    const env = (saveNow: PipelineActionEnv["saveNow"]) => envFor({ saved: false, native: { transcriber: "off", stt: null }, pending: { id: ID, startedAt: 0, durationMs: 1, failed: { kind: "timeout", message: "deadline" } } }, { saveNow });
    expect(await runPipelineAction("retry", env(async () => { throw new Error("the account is not ready"); }))).toBe("Couldn't complete this step. Try again.");
    pendingStore.reportError("Couldn't set up your space defaults");
    try {
      expect(await runPipelineAction("retry", env(async () => { await Promise.resolve(); }))).toBe("Couldn't save this note. It is safe on this phone. Try again.");
    } finally {
      await pendingStore.refresh(null);
    }
  });

  test("retry on a failed read reads again; it does not pretend to do more", async () => {
    let rereads = 0;
    const env = envFor({ saved: true, native: null, readError: "The phone's note list wouldn't open: busy" }, { reread: () => { rereads += 1; } });
    expect(env.pipeline.current).toBe("transcript");
    expect(await runPipelineAction("retry", env)).toBeNull();
    expect(rereads).toBe(1);
  });

  test("a failed parked-recordings read reaches the pipeline, and its action rereads", async () => {
    let rereads = 0;
    const env = envFor({ saved: true, native: null, capture: { finalizing: false, issue: null, readError: "EIO" } }, { reread: () => { rereads += 1; } });
    expect(env.pipeline.blocker?.cause).toBe("Couldn't check for recordings that failed to save · EIO");
    expect(env.pipeline.blocker?.action?.kind).toBe("reread");
    expect(env.pipeline.done).toBe(false);
    expect(await runPipelineAction("reread", env)).toBeNull();
    expect(rereads).toBe(1);
  });

  test("get-model and the on-device retry go to the on-device plugin, and a refusal keeps its message", async () => {
    const calls: string[] = [];
    let refuse = false;
    __setOnDeviceSttForTests({
      status: async () => ({ ...BOTH_READY, engine: "parakeet" as const }),
      downloadNow: async () => { calls.push("downloadNow"); if (refuse) throw new Error("no network"); },
      enqueue: async ({ id }: { id: string }) => { calls.push(`enqueue:${id}`); },
    } as unknown as OnDeviceSttPlugin);
    const waiting = envFor({ saved: true, native: { transcriber: "on-device", stt: { state: "waiting_for_model", error: null } }, onDeviceStatus: status() });
    expect(await runPipelineAction("get-model", waiting)).toBeNull();
    expect(await runPipelineAction("retry", waiting)).toBeNull();
    const failed = envFor({ saved: true, native: { transcriber: "on-device", stt: { state: "failed", error: "decoder" } }, onDeviceStatus: BOTH_READY });
    expect(await runPipelineAction("retry", failed)).toBeNull();
    expect(calls).toEqual(["downloadNow", "downloadNow", `enqueue:${ID}`]);
    refuse = true;
    expect(await runPipelineAction("get-model", waiting)).toBe("Couldn't download the on-device model: no network");
    __resetOnDeviceSttStoreForTests();
  });

  test("retry on the notes step with no account says so instead of doing nothing", async () => {
    const env = envFor({ saved: true, native: { transcriber: "off", stt: null }, rowMetadata: {}, localNote: { editedAt: EDITED, hasContent: true }, noteSync: { syncing: false, failed: true, skip: null, syncedAt: null } }, { tcw: null as TinyCloudWeb | null });
    expect(env.pipeline.current).toBe("notes");
    expect(await runPipelineAction("retry", env)).toBe("Sign in to sync this note.");
  });
});
