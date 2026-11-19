import { expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { IDBFactory } from "fake-indexeddb";
import { installDom } from "@/test/dom";
import { mountVoiceNoteAccount } from "@/lib/voiceNotes/accountContext";
import { captureCapabilities, __resetCaptureEngineForTests, __setInstalledEngineForTests } from "@/lib/voiceNotes/captureEngine";
import { VoiceNotes, __setVoiceNotesForTests, type VoiceNoteRecording } from "@/lib/voiceNotes/nativeVoiceNotes";
import { localStorageVoiceNotePendingStore } from "@/lib/voiceNotes/voiceNoteTranscription";
import { setAudioCacheAccount } from "@/lib/voiceNotes/audioReceiptUpgrade";
import { AudioCacheSettings } from "./AudioCacheSettings";

const DID = "did:test:audio-cache-settings";
const originalVoiceNotes = VoiceNotes;
const originalIndexedDb = globalThis.indexedDB;
const originalStorage = (globalThis as typeof globalThis & { localStorage?: Storage }).localStorage;

test("Settings reports retained local recording bytes separately from playback cache", async () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  } as Storage;
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
  globalThis.indexedDB = new IDBFactory() as unknown as IDBFactory;
  const restoreDom = installDom();
  const unmountAccount = mountVoiceNoteAccount(DID);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    const size = 32;
    const note = {
      id: "local-note", owner: DID, startedAt: 1, sizeBytes: size,
      ledger: { audio: { state: "saved", rowId: "row", at: 1, verifiedInSpace: { sha256: "a".repeat(64), size } } },
    } as unknown as VoiceNoteRecording;
    __setVoiceNotesForTests({ ...VoiceNotes,
      listPending: async () => ({ recordings: [note] }),
      localAudioSize: async () => ({ size }),
    } as never, { available: true });
    localStorageVoiceNotePendingStore(DID, storage).write(note.id, {
      attemptId: "attempt-1", transcriptionId: "ptx-1",
    });
    __resetCaptureEngineForTests();
    __setInstalledEngineForTests("web", captureCapabilities());
    setAudioCacheAccount(null);

    await act(async () => { root.render(<AudioCacheSettings />); });
    for (let attempt = 0; attempt < 10 && !host.querySelector("[data-testid=cached-audio-pinned]"); attempt++)
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

    expect(host.textContent).toContain("32 B in saved recordings; kept when playback cache is cleared.");
    expect(host.textContent).toContain("32 B stored; 500 MB soft playback-cache limit");
  } finally {
    await act(async () => root.unmount());
    unmountAccount();
    setAudioCacheAccount(null);
    __setVoiceNotesForTests(originalVoiceNotes, { available: null });
    __resetCaptureEngineForTests();
    globalThis.indexedDB = originalIndexedDb;
    if (originalStorage === undefined) Reflect.deleteProperty(globalThis, "localStorage");
    else Object.defineProperty(globalThis, "localStorage", { configurable: true, value: originalStorage });
    restoreDom();
  }
});
