import { expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { installDom } from "@/test/dom";
import { PlatformContext } from "@/lib/platform";
import { StaticRecorderProvider } from "@/capture/recorder/RecorderProvider";
import { ActivityNoteSection } from "@/capture/activity/ActivityPanel";
import { activityForNote } from "@/capture/activity/activitySelector";
import { NoteDetailView } from "@/capture/library/NoteDetailView";
import { __resetCaptureEngineForTests, __setInstalledEngineForTests, captureCapabilities } from "./captureEngine";
import { __setVoiceNotesForTests, VoiceNotes, type LocalTranscript } from "./nativeVoiceNotes";
import { __setOnDeviceSttForTests, OnDeviceStt, type OnDeviceSttStatus } from "./onDeviceStt";
import { createFakeVoiceNotes } from "./fakeVoiceNotes";
import { createFakeOnDeviceStt } from "./fakeOnDeviceStt";
import { __resetOnDeviceSttStoreForTests } from "./onDeviceSttStore";
import { openWebStore, memoryLocks, recordingFromSession } from "./web/webStore";
import { newIdbEnv } from "./web/testing/idb";
import { useNotePipeline, type NotePipelineView } from "./useNotePipeline";

// Native accepts cancellation before its decoder checkpoint writes the final ledger/status.
// A status-only terminal event must refresh that ledger even though no transcript/failed event fires.
test("both surfaces follow asynchronous on-device cancellation settlement and retain the previous transcript", async () => {
  const clean = installDom();
  const originalNative = VoiceNotes;
  const originalStt = OnDeviceStt;
  const id = "native-cancel-note";
  const store = await openWebStore({ env: newIdbEnv(), dbName: crypto.randomUUID(), locks: memoryLocks(), decodeCheck: null });
  await store.beginSession({ id, startedAt: 1, source: "in_app", owner: null, transitionGen: 0,
    options: { transcriber: "on-device", identifySpeakers: false }, mimeType: "audio/wav", input: null, maxDurationMs: 60000 });
  await store.appendChunk(id, new Uint8Array([1, 2, 3, 4]), { audioMs: 2000 });
  await store.commitSession(id, (session, size) => recordingFromSession(session, size, {
    endedAt: 2001, durationMs: 2000, recovered: false, endedUnexpectedly: false, exitReason: null }));
  const previous: LocalTranscript = { version: 2, noteId: id, rev: 1, transcriber: "on-device", engine: "apple-speech",
    model: null, language: "en", outcome: "transcribed", diarized: false, createdAt: "2026-01-01T00:00:00Z",
    segments: [{ start: 0, end: 1000, text: "Previous saved transcript", speaker: null }] };
  await store.putTranscript({ id, transcript: previous });
  const running = { state: "running" as const, pack: null, engine: "apple-speech" as const,
    segmentsDone: 0, windowsDone: 0, error: null, rerunRev: 2, rerunBaseRev: 1, rerunBaseHash: "previous-hash" };
  await store.updateStt(id, running);
  const status: OnDeviceSttStatus = { models: [], pack: "full", autoDownload: true,
    download: { policy: "system", state: "idle" }, engine: "apple-speech", appleSpeech: "ready",
    queue: [{ id, state: "running", percent: 20, error: null }] };
  const statusListeners = new Set<(value: OnDeviceSttStatus) => void>();
  const accepted = Promise.withResolvers<void>();
  const fake = createFakeOnDeviceStt();
  const native = createFakeVoiceNotes().plugin;
  let nativeRead = Promise.withResolvers<void>();
  __setVoiceNotesForTests({ ...native, listPending: async () => {
    const result = await store.listPending();
    nativeRead.resolve();
    return result;
  }, getTranscript: store.getTranscript }, { available: true });
  __setOnDeviceSttForTests({ ...fake.plugin, status: async () => structuredClone(status),
    cancel: async () => { accepted.resolve(); },
    addListener: (async (event: string, listener: (value: OnDeviceSttStatus) => void) => {
      if (event === "status") statusListeners.add(listener);
      return { remove: async () => { statusListeners.delete(listener); } };
    }) as typeof OnDeviceStt.addListener,
  });
  __resetOnDeviceSttStoreForTests();
  __setInstalledEngineForTests("native", { ...captureCapabilities(), localTranscription: true, desktopWhisper: false });
  const host = document.createElement("div"); document.body.append(host);
  let root = createRoot(host);
  let latest: NotePipelineView | null = null;
  const item = { id: "row-native", source: "exo-voice-note", sourceId: id, title: "Disposable native note", startedAt: null, durationSecs: 2 };
  const metadata = { transcription_outcome: "transcribed", capture: { options: { transcriber: "on-device" } }, audio: { stored: false } };
  const source = { tcw: null, rowExists: true, audioSaved: true, metadata, durationSecs: 2 };
  const noop = () => {};
  function Surface() {
    const view = useNotePipeline(id, source); latest = view;
    return view ? <><ActivityNoteSection item={item} jobs={activityForNote(view, "ios")} onOpenNote={noop} onClose={noop} />
      <NoteDetailView item={item} listStatus="ready" metadata={{ status: "ok", metadata }} transcript={{ status: "ok", sentences: [
        { index: 0, text: "Previous saved transcript", speaker_name: "You", start_time: 0, end_time: 1 },
      ] }} localTranscript={previous} audio={null} copyState="idle" onCopy={noop} onRetry={noop} onBack={noop} pushed={false}
        platform="ios" desktopWhisper={false} activityView={view} /></> : null;
  }
  const mount = () => root.render(<MemoryRouter><PlatformContext.Provider value="ios"><StaticRecorderProvider value={{ tcw: null, transcription: undefined, signIn: null }}><Surface /></StaticRecorderProvider></PlatformContext.Provider></MemoryRouter>);
  try {
    await act(async () => { mount(); });
    await act(async () => { await nativeRead.promise; });
    const buttons = () => [...host.querySelectorAll<HTMLButtonElement>('[data-testid="activity-transcription-status"] button, [data-testid="transcription-status"] button')];
    expect(buttons().map((button) => button.textContent)).toEqual(["Cancel", "Cancel"]);
    await act(async () => { buttons()[1]!.click(); await accepted.promise; });
    expect(latest?.input?.transcript.onDevice?.stt?.state).toBe("running");
    await act(async () => {
      nativeRead = Promise.withResolvers<void>();
      await store.updateStt(id, { ...running, state: "cancelled" });
      status.queue = [];
      for (const listener of statusListeners) listener(structuredClone(status));
      await nativeRead.promise;
    });
    expect(buttons().map((button) => button.textContent)).toEqual(["Transcribe now", "Transcribe now"]);
    const statuses = [...host.querySelectorAll('[data-testid="activity-transcription-status"], [data-testid="transcription-status"]')];
    expect(statuses[0]!.textContent).toBe(statuses[1]!.textContent);
    expect((await store.getTranscript({ id })).transcript).toEqual(previous);
    await act(async () => root.unmount());
    root = createRoot(host);
    nativeRead = Promise.withResolvers<void>();
    await act(async () => mount());
    await act(async () => { await nativeRead.promise; });
    expect((await store.listPending()).recordings[0]?.stt?.state).toBe("cancelled");
    expect((await store.getTranscript({ id })).transcript).toEqual(previous);
  } finally {
    await act(async () => root.unmount());
    __resetOnDeviceSttStoreForTests();
    __setOnDeviceSttForTests(originalStt);
    __setVoiceNotesForTests(originalNative, { available: null });
    __resetCaptureEngineForTests();
    clean();
  }
});
