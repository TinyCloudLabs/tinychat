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
import { createFakeVoiceNotes } from "./fakeVoiceNotes";
import { __setVoiceNotesForTests, VoiceNotes, type VoiceNoteRecording } from "./nativeVoiceNotes";
import { localStorageVoiceNotePendingStore, localStorageVoiceNoteConsentStore, prepareVoiceNoteTranscript, voiceNoteTranscriberFor, type VoiceNoteTranscriber } from "./voiceNoteTranscription";
import { loadVoiceNoteAudio, saveVoiceNote, saveVoiceNoteTranscript, voiceNoteAudioSourceFromBase64 } from "./voiceNoteStore";
import { readTranscriptCommit } from "./voiceNoteCommits";
import { resolveVoiceNoteRow } from "./voiceNoteRows";
import { memoryLocks, openWebStore, recordingFromSession } from "./web/webStore";
import { newIdbEnv } from "./web/testing/idb";
import { useNotePipeline, type NotePipelineView } from "./useNotePipeline";
import { __setInstalledEngineForTests, __resetCaptureEngineForTests, captureCapabilities } from "./captureEngine";

const AUDIO = { mimeType: "audio/wav", base64: "AQIDBA==" };

function syntheticSpace() {
  _resetConnectorSchemaMemoForTests();
  const sqlite = new Database(":memory:");
  const values = new Map<string, string | Uint8Array>();
  const etags = new Map<string, string>();
  let revision = 0;
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
      get: async (key: string) => values.has(key)
        ? { ok: true, data: { data: values.get(key), headers: { etag: etags.get(key) } } }
        : { ok: false, error: { code: "KV_NOT_FOUND", message: "missing" } },
      put: async (key: string, value: string | Uint8Array, options?: { ifNoneMatch?: string; ifMatch?: string }) => {
        if (options?.ifNoneMatch === "*" && values.has(key) || options?.ifMatch && options.ifMatch !== etags.get(key))
          return { ok: false, error: { code: "KV_PRECONDITION_FAILED", message: "etag changed" } };
        values.set(key, value); etags.set(key, String(++revision));
        return { ok: true, data: { headers: { etag: etags.get(key) } } };
      },
      list: async ({ path }: { path: string }) => ({ ok: true, data: { keys: [...values.keys()].filter((key) => key.startsWith(path)) } }),
    },
  } as unknown as TinyCloudWeb;
  return { tcw, sqlite };
}

function storage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
}

function nextFailure(transcriber: VoiceNoteTranscriber, subscriptions: Set<() => void>) {
  const { promise, resolve } = Promise.withResolvers<void>();
  const stop = transcriber.subscribe(() => {
    if (transcriber.snapshot().jobs.get("note")?.kind === "failed") resolve();
  });
  subscriptions.add(stop);
  return promise.then(() => { stop(); subscriptions.delete(stop); });
}

for (const queuedFirst of [true, false]) {
  test(`current Powerful failure and both retry controls retain Powerful over old Private cancellation (${queuedFirst ? "queued" : "immediate"} error)`, async () => {
    const restoreDom = installDom();
    const previousNative = VoiceNotes;
    const previousStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    const previousOrigin = process.env.VITE_EXO_PTX_UPLOAD_ORIGIN;
    const local = storage();
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: local });
    const space = syntheticSpace();
    const subscriptions = new Set<() => void>();
    const gates = Array.from({ length: 3 }, () => Promise.withResolvers<Response>());
    const entered = Array.from({ length: 3 }, () => Promise.withResolvers<void>());
    let reads = 0;
    let attempts = 0;
    const failure = () => Response.json({ id: "synthetic-handle", status: "error", error: "Synthetic provider failure" });
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      expect(request.headers.get("Authorization")).toBe("Bearer synthetic-session");
      const path = new URL(request.url).pathname;
      if (path.endsWith("/capabilities")) return Response.json(path.includes("assemblyai")
        ? { hosted: true, max_bytes: 1000000, content_types: ["audio/wav"], part_size: 1024 }
        : { max_bytes: 1000000, max_duration_seconds: 100, content_types: ["audio/wav"], admission: "open" });
      if (path.endsWith("/hosted/transcripts/synthetic-handle")) {
        if (++reads === 1 && queuedFirst) return Response.json({ id: "synthetic-handle", status: "queued" });
        const index = attempts++;
        entered[index]!.resolve();
        return gates[index]!.promise;
      }
      throw new Error(`Unexpected provider request: ${request.method} ${path}`);
    } });
    let root: ReturnType<typeof createRoot> | undefined;
    try {
      const store = await openWebStore({ env: newIdbEnv(), dbName: crypto.randomUUID(), locks: memoryLocks(), decodeCheck: null });
      await store.beginSession({ id: "note", startedAt: 1, source: "in_app", owner: null, transitionGen: 0,
        options: { transcriber: "assemblyai", identifySpeakers: false, uploadAudio: true }, mimeType: "audio/wav", input: null, maxDurationMs: 60000 });
      await store.appendChunk("note", new Uint8Array([1, 2, 3, 4]), { audioMs: 2000 });
      await store.commitSession("note", (session, size) => recordingFromSession(session, size, {
        endedAt: 2001, durationMs: 2000, recovered: false, endedUnexpectedly: false, exitReason: null }));
      const recording = (await store.listPending()).recordings[0]!;
      __setVoiceNotesForTests({ ...createFakeVoiceNotes().plugin, listPending: store.listPending,
        getTranscript: store.getTranscript, readAudioChunk: store.readAudioChunk, localAudioSize: async () => ({ size: 4 }) }, { available: false });
      expect((await saveVoiceNote(space.tcw, recording, voiceNoteAudioSourceFromBase64(AUDIO), "web")).ok).toBe(true);
      localStorageVoiceNotePendingStore(space.tcw.did, local).write("note", {
        attemptId: "older-private-attempt", transcriptionId: null, failure: "cancelled" });
      local.setItem(`exo.voiceNotes.powerfulConsent:${space.tcw.did}`, "1");
      await space.tcw.kv.put("exo/voiceNotes/hostedJobs/note", JSON.stringify({
        version: 1, status: "submitted", token: "submitted-powerful-attempt", handle: "synthetic-handle" }));
      process.env.VITE_EXO_PTX_UPLOAD_ORIGIN = "https://127.0.0.1";
      __setInstalledEngineForTests("web", { ...captureCapabilities(), localTranscription: false, desktopWhisper: false, nativeFileUpload: false });
      const transcriber = voiceNoteTranscriberFor(space.tcw, server.url.origin, {
        getToken: () => "synthetic-session", isExpired: () => false,
      })!;
      expect(transcriber.providerFor!("note")).toBe("private");
      expect(transcriber.snapshot().jobs.get("note")?.kind).toBe("cancelled");
      await transcriber.check();
      transcriber.transcribe("note");
      await entered[0]!.promise;
      if (queuedFirst) {
        expect(transcriber.providerFor!("note")).toBe("powerful");
        expect(transcriber.snapshot().jobs.get("note")?.kind).toBe("active");
      }
      const failed = nextFailure(transcriber, subscriptions);
      gates[0]!.resolve(failure());
      await failed;
      expect(transcriber.providerFor!("note")).toBe("powerful");
      expect(transcriber.snapshot().jobs.get("note")?.kind).toBe("failed");

      const metadata = (await resolveVoiceNoteRow(space.tcw, "note"))!.metadata;
      const source = { tcw: null, rowExists: true, audioSaved: true, metadata, durationSecs: 2 };
      const item = { id: "row-note", source: "exo-voice-note", sourceId: "note", title: "Synthetic", startedAt: null, durationSecs: 2 };
      let latest: NotePipelineView | null = null;
      const noop = () => {};
      function Probe() {
        const view = useNotePipeline("note", source); latest = view;
        return view ? <><ActivityNoteSection item={item} jobs={activityForNote(view, "web")} onOpenNote={noop} onClose={noop} />
          <NoteDetailView item={item} listStatus="ready" metadata={{ status: "ok", metadata }} transcript={{ status: "ok", sentences: [] }}
            audio={null} copyState="idle" onCopy={noop} onRetry={noop} onBack={noop} pushed={false} platform="web" activityView={view} /></> : null;
      }
      function Surface() {
        const snapshot = useSyncExternalStore(transcriber.subscribe, transcriber.snapshot, transcriber.snapshot);
        return <MemoryRouter><PlatformContext.Provider value="web"><StaticRecorderProvider value={{ tcw: null, signIn: null,
          transcription: transcriptionProps(transcriber, snapshot) }}><Probe /></StaticRecorderProvider></PlatformContext.Provider></MemoryRouter>;
      }
      const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
      await act(async () => { root!.render(<Surface />); await store.listPending(); });
      expect(latest?.provider).toBe("powerful");
      for (const [index, selector] of [
        [1, '[data-testid="activity-transcription-status"] button'],
        [2, '[data-testid="transcription-status"] button'],
      ] as const) {
        await act(async () => {
          host.querySelector<HTMLButtonElement>(selector)!.click();
          await entered[index]!.promise;
          const retried = nextFailure(transcriber, subscriptions);
          gates[index]!.resolve(failure());
          await retried;
        });
        expect(latest?.provider).toBe("powerful");
        expect(transcriber.snapshot().jobs.get("note")?.kind).toBe("failed");
      }
      expect(await readTranscriptCommit(space.tcw, "note")).toBeNull();
      expect(await loadVoiceNoteAudio(space.tcw, "note")).toMatchObject({ ok: true, data: AUDIO });
      expect((await store.readNoteAudio("note")).bytes).toEqual(new Uint8Array([1, 2, 3, 4]));
    } finally {
      for (const gate of gates) gate.resolve(failure());
      for (const stop of subscriptions) stop();
      if (root) await act(async () => root!.unmount());
      await server.stop(true);
      __setVoiceNotesForTests(previousNative, { available: null });
      __resetCaptureEngineForTests();
      if (previousOrigin === undefined) delete process.env.VITE_EXO_PTX_UPLOAD_ORIGIN;
      else process.env.VITE_EXO_PTX_UPLOAD_ORIGIN = previousOrigin;
      if (previousStorage) Object.defineProperty(globalThis, "localStorage", previousStorage);
      else Reflect.deleteProperty(globalThis, "localStorage");
      restoreDom(); space.sqlite.close();
    }
  }, 15000);
}

test("combined Private rerun reports acceptance and cancellation preserves the committed transcript and audio", async () => {
  const previousNative = VoiceNotes;
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const previousOrigin = process.env.VITE_EXO_PTX_UPLOAD_ORIGIN;
  const previousIdb = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  const previousRange = Object.getOwnPropertyDescriptor(globalThis, "IDBKeyRange");
  const local = storage();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: local });
  const space = syntheticSpace();
  const id = `trn_${"B".repeat(26)}`;
  const entered = Promise.withResolvers<void>();
  const result = Promise.withResolvers<Response>();
  const producer = new AbortController();
  const subscriptions = new Set<() => void>();
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    expect(request.headers.get("Authorization")).toBe("Bearer synthetic-session");
    const path = new URL(request.url).pathname;
    if (path.endsWith("/capabilities")) return Response.json(path.includes("assemblyai")
      ? { hosted: true, max_bytes: 1000000, content_types: ["audio/wav"], part_size: 1024 }
      : { max_bytes: 1000000, max_duration_seconds: 100, content_types: ["audio/wav"], admission: "open" });
    if (path.endsWith("/hosted/transcripts/synthetic-handle"))
      return Response.json({ id: "synthetic-handle", status: "error", error: "Older Powerful failure" });
    if (request.method === "POST" && path.endsWith("/private-cloud/transcriptions")) {
      return Response.json({ id, status: "completed", upload: null }, { status: 201 });
    }
    if (path.endsWith("/cancel")) { producer.abort(); return Response.json({ id, status: "cancelled" }); }
    if (path.endsWith("/result")) { entered.resolve(); return result.promise; }
    if (path.endsWith(id)) return Response.json({ id, status: "completed" });
    throw new Error(`Unexpected provider request: ${request.method} ${path}`);
  } });
  try {
    const idb = newIdbEnv();
    Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: idb.factory });
    Object.defineProperty(globalThis, "IDBKeyRange", { configurable: true, value: idb.keyRange });
    process.env.VITE_EXO_PTX_UPLOAD_ORIGIN = "https://127.0.0.1";
    __setInstalledEngineForTests("web", { ...captureCapabilities(), localTranscription: false, desktopWhisper: false, nativeFileUpload: false });
    const recording = { id: "note", source: "in_app", startedAt: 1, durationMs: 2000, mimeType: "audio/wav", sizeBytes: 4,
      options: { transcriber: "assemblyai", identifySpeakers: false, uploadAudio: true } } as VoiceNoteRecording;
    const native = createFakeVoiceNotes();
    native.controls.commitLegacy(recording);
    __setVoiceNotesForTests({ ...native.plugin, listPending: async () => ({ recordings: [recording] }) }, { available: false });
    expect((await saveVoiceNote(space.tcw, recording, voiceNoteAudioSourceFromBase64(AUDIO), "web")).ok).toBe(true);
    localStorageVoiceNoteConsentStore(space.tcw.did, local).set(true);
    const pending = localStorageVoiceNotePendingStore(space.tcw.did, local);
    pending.write("note", { attemptId: "old-cancelled-private", transcriptionId: null, failure: "cancelled" });
    local.setItem(`exo.voiceNotes.powerfulConsent:${space.tcw.did}`, "1");
    await space.tcw.kv.put("exo/voiceNotes/hostedJobs/note", JSON.stringify({
      version: 1, status: "submitted", token: "older-powerful", handle: "synthetic-handle" }));
    const transcriber = voiceNoteTranscriberFor(space.tcw, server.url.origin, { getToken: () => "synthetic-session", isExpired: () => false })!;
    await transcriber.check();
    const olderFailed = nextFailure(transcriber, subscriptions);
    transcriber.transcribe("note");
    await olderFailed;
    expect(transcriber.providerFor!("note")).toBe("powerful");
    expect(transcriber.snapshot().jobs.get("note")?.kind).toBe("failed");
    // A committed revision arrives from space before the explicit replacement.
    const previous = prepareVoiceNoteTranscript({ text: "Previous synthetic transcript", segments: [{ channel: 0, start: 0, end: 1, text: "Previous synthetic transcript" }] }, "2026-01-01T00:00:00Z", 1);
    expect((await saveVoiceNoteTranscript(space.tcw, "note", previous)).ok).toBe(true);
    const committed = await readTranscriptCommit(space.tcw, "note");
    const premature = Promise.withResolvers<never>();
    const stop = transcriber.subscribe(() => {
      const job = transcriber.snapshot().jobs.get("note");
      if (job?.kind === "failed" || job?.kind === "done")
        premature.reject(new Error(`Private settled before result: ${job.kind} ${"code" in job ? job.code : ""}`));
    });
    subscriptions.add(stop);
    expect(await transcriber.transcribeAgain!("note", "private-cloud")).toBeNull();
    await Promise.race([entered.promise, premature.promise]);
    stop(); subscriptions.delete(stop);
    expect(transcriber.providerFor!("note")).toBe("private");
    expect(transcriber.snapshot().jobs.get("note")?.kind).toBe("active");
    await transcriber.cancel!("note");
    expect(producer.signal.aborted).toBe(true);
    expect(transcriber.providerFor!("note")).toBe("private");
    expect(transcriber.snapshot().jobs.get("note")?.kind).toBe("cancelled");
    expect(await readTranscriptCommit(space.tcw, "note")).toEqual(committed);
    const body = await space.tcw.kv.get(committed!.bodyKey!);
    expect(body.ok && JSON.parse(String(body.data.data)).map((sentence: { text: string }) => sentence.text).join("\n")).toBe("Previous synthetic transcript");
    expect(await loadVoiceNoteAudio(space.tcw, "note")).toMatchObject({ ok: true, data: AUDIO });
  } finally {
    for (const stop of subscriptions) stop();
    result.resolve(Response.json({ text: "Uncommitted late result", segments: [] }));
    await server.stop(true);
    __setVoiceNotesForTests(previousNative, { available: null });
    __resetCaptureEngineForTests();
    if (previousOrigin === undefined) delete process.env.VITE_EXO_PTX_UPLOAD_ORIGIN;
    else process.env.VITE_EXO_PTX_UPLOAD_ORIGIN = previousOrigin;
    if (previousStorage) Object.defineProperty(globalThis, "localStorage", previousStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
    if (previousIdb) Object.defineProperty(globalThis, "indexedDB", previousIdb);
    else Reflect.deleteProperty(globalThis, "indexedDB");
    if (previousRange) Object.defineProperty(globalThis, "IDBKeyRange", previousRange);
    else Reflect.deleteProperty(globalThis, "IDBKeyRange");
    space.sqlite.close();
  }
}, 10000);
