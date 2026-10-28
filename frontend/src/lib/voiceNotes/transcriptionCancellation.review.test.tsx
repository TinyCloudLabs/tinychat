import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { act, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { installDom } from "@/test/dom";
import { PlatformContext } from "@/lib/platform";
import { StaticRecorderProvider } from "@/capture/recorder/RecorderProvider";
import { transcriptionProps } from "@/capture/recorder/transcriptionProps";
import { ActivityNoteSection } from "@/capture/activity/ActivityPanel";
import { activityForNote } from "@/capture/activity/activitySelector";
import { NoteDetailView } from "@/capture/library/NoteDetailView";
import { _resetConnectorSchemaMemoForTests } from "../connectors/connectorStore";
import { createPrivateCloudApi } from "../privateCloud";
import { createFakeVoiceNotes } from "./fakeVoiceNotes";
import { __setVoiceNotesForTests, VoiceNotes, type VoiceNoteRecording } from "./nativeVoiceNotes";
import { createVoiceNoteCloud, createVoiceNoteTranscriber, localStorageVoiceNoteHoldStore,
  localStorageVoiceNotePendingStore, localStorageVoiceNotePrivateChoiceStore, prepareVoiceNoteTranscript,
  type NoteTranscriptionState, type VoiceNoteTranscriber } from "./voiceNoteTranscription";
import { loadVoiceNoteAudio, saveVoiceNote, saveVoiceNoteTranscript, voiceNoteAudioSourceFromBase64 } from "./voiceNoteStore";
import { readTranscriptCommit } from "./voiceNoteCommits";
import { createDesktopWhisperQueue, registerDesktopWhisperQueue } from "./desktop/desktopWhisper";
import { openWebStore, memoryLocks, recordingFromSession } from "./web/webStore";
import { newIdbEnv } from "./web/testing/idb";
import { __resetCaptureEngineForTests, __setInstalledEngineForTests, captureCapabilities } from "./captureEngine";
import { useNotePipeline, type NotePipelineView } from "./useNotePipeline";

const CAPS = { max_bytes: 1_000_000, max_duration_seconds: 100, content_types: ["audio/wav"], admission: "open" as const };
const OLD = "trn_aaaaaaaaaaaaaaaa";
const NEW = "trn_bbbbbbbbbbbbbbbb";
const AUDIO = { mimeType: "audio/wav", base64: "AQIDBA==" };
const text = (value: string) => ({ text: value, segments: [{ channel: 0, start: 0, end: 1, text: value }] });

function syntheticSpace() {
  _resetConnectorSchemaMemoForTests();
  const sqlite = new Database(":memory:");
  const values = new Map<string, string | Uint8Array>();
  const run = <T,>(operation: () => T) => {
    try { return { ok: true, data: operation() }; }
    catch (error) { return { ok: false, error: { code: "SQL", message: String(error) } }; }
  };
  const tcw = { did: `did:test:${crypto.randomUUID()}`, spaceId: crypto.randomUUID(),
    sql: { db: () => ({
      query: async (sql: string, args: never[] = []) => run(() => ({ rows: sqlite.query(sql).values(...args) })),
      execute: async (sql: string, args: never[] = []) => run(() => { sqlite.query(sql).run(...args); return { rows: [] }; }),
    }) },
    kv: {
      get: async (key: string) => values.has(key) ? { ok: true, data: { data: values.get(key) } }
        : { ok: false, error: { code: "KV_NOT_FOUND", message: "missing" } },
      put: async (key: string, value: string | Uint8Array, options?: { ifNoneMatch?: string }) => {
        if (options?.ifNoneMatch === "*" && values.has(key)) return { ok: false, error: { code: "KV_PRECONDITION_FAILED", message: "exists" } };
        values.set(key, value); return { ok: true, data: { headers: {} } };
      },
      list: async ({ path }: { path: string }) => ({ ok: true, data: { keys: [...values.keys()].filter((key) => key.startsWith(path)) } }),
    },
  } as unknown as TinyCloudWeb;
  return { tcw, sqlite, values };
}

function storage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
}

function stateReached(transcriber: VoiceNoteTranscriber, predicate: (job: NoteTranscriptionState | undefined) => boolean) {
  const { promise, resolve } = Promise.withResolvers<void>();
  if (predicate(transcriber.snapshot().jobs.get("note"))) resolve();
  else {
    const stop = transcriber.subscribe(() => {
      if (predicate(transcriber.snapshot().jobs.get("note"))) { stop(); resolve(); }
    });
  }
  return promise;
}

for (const lateStatus of [200, 503]) {
  test(`an overlapping OLD cancel response (${lateStatus}) cannot change NEW pending, status, or transcript`, async () => {
    const space = syntheticSpace();
    const previousNative = VoiceNotes;
    __setVoiceNotesForTests(createFakeVoiceNotes().plugin, { available: false });
    const pending = localStorageVoiceNotePendingStore(space.tcw.did, storage());
    const firstCancel = Promise.withResolvers<Response>();
    const secondCancel = Promise.withResolvers<Response>();
    const bothCancelling = Promise.withResolvers<void>();
    const oldResult = Promise.withResolvers<Response>();
    const oldStarted = Promise.withResolvers<void>();
    const replacementStatus = Promise.withResolvers<Response>();
    const replacementStarted = Promise.withResolvers<void>();
    let cancelCount = 0;
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      expect(request.headers.get("Authorization")).toBe("Bearer synthetic-session");
      const path = new URL(request.url).pathname;
      if (path.endsWith("capabilities")) return Response.json(CAPS);
      if (path.endsWith("/cancel")) {
        if (++cancelCount === 1) return firstCancel.promise;
        bothCancelling.resolve(); return secondCancel.promise;
      }
      if (request.method === "DELETE") return new Response(null, { status: 204 });
      if (path.endsWith(`${OLD}/result`)) { oldStarted.resolve(); return oldResult.promise; }
      if (path.endsWith(`${NEW}/result`)) return Response.json(text("Replacement transcript"));
      if (path.endsWith(NEW)) { replacementStarted.resolve(); return replacementStatus.promise; }
      return Response.json({ id: OLD, status: "completed" });
    } });
    const api = createPrivateCloudApi(server.url.origin, { sessionStore: { getToken: () => "synthetic-session", isExpired: () => false } });
    const cloud = createVoiceNoteCloud({ origin: server.url.origin, api, pending,
      create: async () => ({ id: NEW, status: "queued", upload: null }), put: async () => { throw new Error("No test job requires an upload"); } });
    const transcriber = createVoiceNoteTranscriber({ cloud, tcw: () => space.tcw,
      holds: localStorageVoiceNoteHoldStore(space.tcw.did, storage()), consent: { get: () => true, set() {} } });
    const recording = { id: "note", source: "in_app", startedAt: 1, durationMs: 2000, mimeType: "audio/wav", sizeBytes: 4,
      options: { transcriber: "private-cloud", identifySpeakers: false, uploadAudio: true } } as VoiceNoteRecording;
    try {
      expect((await saveVoiceNote(space.tcw, recording, voiceNoteAudioSourceFromBase64(AUDIO), "web")).ok).toBe(true);
      expect((await saveVoiceNoteTranscript(space.tcw, "note", prepareVoiceNoteTranscript(text("Original transcript"), "2026-01-01T00:00:00Z", 1))).ok).toBe(true);
      const original = await readTranscriptCommit(space.tcw, "note");
      await transcriber.check();
      pending.write("note", { attemptId: "old-attempt", transcriptionId: OLD });
      await transcriber.transcribeAgain!("note", "private-cloud");
      await oldStarted.promise;
      const first = transcriber.cancel!("note");
      const second = transcriber.cancel!("note");
      await bothCancelling.promise;
      firstCancel.resolve(Response.json({ id: OLD, status: "cancelled" }));
      await first;
      await transcriber.transcribeAgain!("note", "private-cloud");
      await replacementStarted.promise;
      const replacement = pending.read("note");
      expect(replacement?.transcriptionId).toBe(NEW);
      expect(replacement?.attemptId).not.toBe("old-attempt");
      secondCancel.resolve(lateStatus === 200 ? Response.json({ id: OLD, status: "cancelled" })
        : Response.json({ error: { code: "service_unavailable", message: "The old cancellation response failed" } }, { status: lateStatus }));
      await second;
      expect(transcriber.snapshot().jobs.get("note")?.kind).toBe("active");
      expect(pending.read("note")).toEqual(replacement);
      expect(await readTranscriptCommit(space.tcw, "note")).toEqual(original);
      const completed = stateReached(transcriber, (job) => job?.kind === "done");
      replacementStatus.resolve(Response.json({ id: NEW, status: "completed" }));
      await completed;
      const committed = await readTranscriptCommit(space.tcw, "note");
      expect(committed?.rev).toBe(2);
      expect(JSON.parse(String(space.values.get(committed!.bodyKey))).map((sentence: { text: string }) => sentence.text)).toEqual(["Replacement transcript"]);
      expect(await loadVoiceNoteAudio(space.tcw, "note")).toMatchObject({ ok: true, data: AUDIO });
    } finally {
      firstCancel.resolve(Response.json({ id: OLD, status: "cancelled" }));
      secondCancel.resolve(Response.json({ id: OLD, status: "cancelled" }));
      oldResult.resolve(Response.json(text("Late old transcript")));
      replacementStatus.resolve(Response.json({ id: NEW, status: "cancelled" }));
      await server.stop(true);
      __setVoiceNotesForTests(previousNative, { available: null });
      space.sqlite.close();
    }
  });
}

test("Activity and note cancel and restart the selected Private override despite a cancelled Local snapshot, including reload", async () => {
  const cleanup = installDom();
  const previousNative = VoiceNotes;
  const space = syntheticSpace();
  const local = storage();
  const pending = localStorageVoiceNotePendingStore(space.tcw.did, local);
  const firstEntered = Promise.withResolvers<void>();
  const firstResult = Promise.withResolvers<Response>();
  const nextEntered = Promise.withResolvers<void>();
  const nextResult = Promise.withResolvers<Response>();
  const cancellations: string[] = [];
  const created: string[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    expect(request.headers.get("Authorization")).toBe("Bearer synthetic-session");
    const path = new URL(request.url).pathname;
    if (path.endsWith("capabilities")) return Response.json(CAPS);
    if (path.endsWith("/cancel")) {
      cancellations.push(path); return Response.json({ status: "cancelled" });
    }
    if (path.endsWith(`${OLD}/result`)) { firstEntered.resolve(); return firstResult.promise; }
    if (path.endsWith(`${NEW}/result`)) { nextEntered.resolve(); return nextResult.promise; }
    return Response.json({ id: path.endsWith(NEW) ? NEW : OLD, status: "completed" });
  } });
  const store = await openWebStore({ env: newIdbEnv(), dbName: crypto.randomUUID(), locks: memoryLocks(), decodeCheck: null });
  await store.beginSession({ id: "note", startedAt: 1, source: "in_app", owner: null, transitionGen: 0,
    options: { transcriber: "on-device", identifySpeakers: false, uploadAudio: true }, mimeType: "audio/wav", input: null, maxDurationMs: 60000 });
  await store.appendChunk("note", new Uint8Array([1, 2, 3, 4]), { audioMs: 2000 });
  await store.commitSession("note", (session, size) => recordingFromSession(session, size, {
    endedAt: 2001, durationMs: 2000, recovered: false, endedUnexpectedly: false, exitReason: null }));
  const queue = createDesktopWhisperQueue({ store, captureLive: () => true, files: { invoke: async () => undefined } as never,
    whisper: { startServer: async () => "http://127.0.0.1:1", stopServer: async () => {}, startTranscription: async () => {},
      stopTranscription: async () => {}, onTranscription: async () => () => {} } });
  await queue.noteCommitted((await store.listPending()).recordings[0]!);
  await queue.cancel("note");
  registerDesktopWhisperQueue(queue);
  __setVoiceNotesForTests({ ...createFakeVoiceNotes().plugin, listPending: store.listPending,
    getTranscript: store.getTranscript, readAudioChunk: store.readAudioChunk }, { available: false });
  __setInstalledEngineForTests("tauri", { ...captureCapabilities(), desktopWhisper: true, localTranscription: false, nativeFileUpload: false });
  const api = createPrivateCloudApi(server.url.origin, { sessionStore: { getToken: () => "synthetic-session", isExpired: () => false } });
  const makeTranscriber = () => createVoiceNoteTranscriber({
    cloud: createVoiceNoteCloud({ pending, origin: server.url.origin, api,
      create: async ({ attemptId }) => { created.push(attemptId); return { id: NEW, status: "completed", upload: null }; },
      put: async () => { throw new Error("No test job requires an upload"); } }),
    tcw: () => space.tcw, consent: { get: () => true, set() {} },
    choices: localStorageVoiceNotePrivateChoiceStore(space.tcw.did, local), holds: localStorageVoiceNoteHoldStore(space.tcw.did, local),
  });
  let transcriber = makeTranscriber();
  const recording = (await store.listPending()).recordings[0]!;
  expect((await saveVoiceNote(space.tcw, recording, voiceNoteAudioSourceFromBase64(AUDIO), "tauri")).ok).toBe(true);
  await transcriber.check();
  pending.write("note", { attemptId: "private-override", transcriptionId: OLD });
  transcriber.transcribePrivately("note", 2, 4);
  await firstEntered.promise;
  const metadata = { capture: { options: { transcriber: "on-device" } }, audio: { stored: true } };
  const source = { tcw: null, rowExists: true, audioSaved: true, metadata, durationSecs: 2 };
  const item = { id: "row-note", source: "exo-voice-note", sourceId: "note", title: "Synthetic", startedAt: null, durationSecs: 2 };
  let latest: NotePipelineView | null = null;
  const noop = () => {};
  function Probe() {
    const view = useNotePipeline("note", source); latest = view;
    return view ? <><ActivityNoteSection item={item} jobs={activityForNote(view, "tauri")} onOpenNote={noop} onClose={noop} />
      <NoteDetailView item={item} listStatus="ready" metadata={{ status: "ok", metadata }} transcript={{ status: "ok", sentences: [] }}
        audio={null} copyState="idle" onCopy={noop} onRetry={noop} onBack={noop} pushed={false} platform="tauri" desktopWhisper activityView={view} /></> : null;
  }
  function Surface() {
    const snapshot = useSyncExternalStore(transcriber.subscribe, transcriber.snapshot, transcriber.snapshot);
    return <MemoryRouter><PlatformContext.Provider value="tauri"><StaticRecorderProvider value={{ tcw: null, signIn: null,
      transcription: transcriptionProps(transcriber, snapshot) }}><Probe /></StaticRecorderProvider></PlatformContext.Provider></MemoryRouter>;
  }
  const host = document.createElement("div"); document.body.append(host);
  let root = createRoot(host);
  const buttons = () => [...host.querySelectorAll<HTMLButtonElement>('[data-testid="activity-transcription-status"] button, [data-testid="transcription-status"] button')];
  try {
    await act(async () => root.render(<Surface />));
    expect(latest?.route).toBe("private-cloud");
    expect(latest?.provider).toBe("private");
    expect(buttons().map((button) => button.textContent)).toEqual(["Cancel", "Cancel"]);
    const firstCancelled = stateReached(transcriber, (job) => job?.kind === "cancelled" && !job.pending);
    await act(async () => { buttons()[0]!.click(); await firstCancelled; });
    expect(cancellations).toEqual([`/api/transcriber/private-cloud/transcriptions/${OLD}/cancel`]);
    expect(queue.snapshot().get("note")?.state).toBe("cancelled");
    expect(latest?.provider).toBe("private");
    expect(buttons().map((button) => button.textContent)).toEqual(["Transcribe now", "Transcribe now"]);
    await act(async () => { buttons()[1]!.click(); await nextEntered.promise; });
    expect(transcriber.snapshot().jobs.get("note")?.kind).toBe("active");
    expect(pending.read("note")?.transcriptionId).toBe(NEW);
    expect(queue.snapshot().get("note")?.state).toBe("cancelled");
    expect(latest?.provider).toBe("private");
    expect(buttons().map((button) => button.textContent)).toEqual(["Cancel", "Cancel"]);
    const nextCancelled = stateReached(transcriber, (job) => job?.kind === "cancelled" && !job.pending);
    await act(async () => { buttons()[1]!.click(); await nextCancelled; });
    expect(cancellations).toEqual([`/api/transcriber/private-cloud/transcriptions/${OLD}/cancel`, `/api/transcriber/private-cloud/transcriptions/${NEW}/cancel`]);
    expect((await store.readNoteAudio("note")).bytes).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(await loadVoiceNoteAudio(space.tcw, "note")).toMatchObject({ ok: true, data: AUDIO });
    await act(async () => root.unmount());
    transcriber = makeTranscriber();
    await transcriber.check();
    root = createRoot(host);
    await act(async () => root.render(<Surface />));
    expect(latest?.provider).toBe("private");
    expect(buttons().map((button) => button.textContent)).toEqual(["Transcribe now", "Transcribe now"]);
    expect(created).toHaveLength(1);
    expect(queue.snapshot().get("note")?.state).toBe("cancelled");
  } finally {
    await act(async () => root.unmount());
    firstResult.resolve(Response.json(text("Late old transcript")));
    nextResult.resolve(Response.json(text("Late replacement transcript")));
    await server.stop(true);
    queue.dispose(); registerDesktopWhisperQueue(null);
    __setVoiceNotesForTests(previousNative, { available: null });
    __resetCaptureEngineForTests(); cleanup(); space.sqlite.close();
  }
});
