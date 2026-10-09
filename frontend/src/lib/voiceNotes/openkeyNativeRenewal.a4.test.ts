import { expect, mock, test } from "bun:test";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import type { NativeSession, OpenKeyNative } from "@openkey/sdk-capacitor";
import { putAudio } from "../audio/audioStore";
import { __setVoiceNotesForTests, type VoiceNoteRecording, type VoiceNotesPlugin } from "./nativeVoiceNotes";

const manifestAndParts = new Map<string, unknown>();
const records = new Map<string, unknown>();
const store = await import("./voiceNoteStore");
mock.module("./voiceNoteStore", () => ({
  ...store,
  saveVoiceNote: async (tcw: TinyCloudWeb, recording: VoiceNoteRecording, source: Parameters<typeof store.saveVoiceNote>[2]) => {
    const base = store.voiceNoteAudioKvKey(recording.id);
    const manifest = await putAudio(tcw.kv, base, source, {
      partSize: 2, fileName: `${recording.id}.m4a`, mimeType: recording.mimeType,
    });
    records.set(recording.id, { audio: base, parts: manifest.parts.length });
    return { ok: true, data: { inserted: true } };
  },
}));

const { savePendingRecordings } = await import("./recorderSaves");
const { NativeRenewal, guardNativeTinyCloudCalls } = await import("../openkeyNativeRenewal");
const { registerPendingVoiceNotesRecovery, schedulePendingVoiceNotesRecovery } = await import("../../chat/PendingVoiceNotesSaver");

test("forced swap aborts an outstanding part and schedules pending manifest and record recovery", async () => {
  const note: VoiceNoteRecording = {
    id: "a4-forced-swap", startedAt: 1_000_000, durationMs: 1000, mimeType: "audio/mp4",
    sizeBytes: 4, silencedMs: 0, silencedEvents: 0, noSignalMs: 0,
  };
  let pending = true;
  __setVoiceNotesForTests({
    listPending: async () => ({ recordings: pending ? [note] : [] }),
    deleteAudio: async () => { pending = false; },
    readAudioChunk: async ({ offset, length }: { offset: number; length: number }) => ({
      id: note.id, offset, base64: btoa("x".repeat(length)), bytesRead: length, size: 4, eof: offset + length === 4,
    }),
  } as unknown as VoiceNotesPlugin, { available: true });

  let partInFlight!: () => void;
  const atPart = new Promise<void>((resolve) => { partInFlight = resolve; });
  let live: ReturnType<typeof graph>;
  let now = 1_200_000;
  let failNextPartOnNewGraph = false;
  function graph() {
    const controller = new AbortController();
    return {
      retire: () => controller.abort(),
      kv: {
        list: async () => ({ ok: true, data: { keys: [...manifestAndParts.keys()], truncated: false } }),
        put: async (key: string, value: unknown) => {
          if (key.endsWith("/p/000001") && !controller.signal.aborted && live?.kv === old.kv) {
            partInFlight();
            await new Promise<void>((resolve) => controller.signal.addEventListener("abort", () => resolve(), { once: true }));
            return { ok: false, error: { code: "ABORTED", message: "Request was aborted.", service: "kv" } };
          }
          if (key.endsWith("/p/000001") && failNextPartOnNewGraph) {
            failNextPartOnNewGraph = false;
            return { ok: false, error: { code: "ABORTED", message: "Request was aborted.", service: "kv" } };
          }
          manifestAndParts.set(key, value);
          return { ok: true, data: { headers: {} } };
        },
      },
    };
  }
  const old = graph();
  live = old;
  const raw = { get kv() { return live.kv; } } as unknown as TinyCloudWeb;
  const original = {
    delegation: { address: "0x1111111111111111111111111111111111111111", delegationCid: "old", issuedAt: new Date(1_000_000).toISOString(), expiresAt: new Date(1_300_000).toISOString() },
  } as NativeSession;
  const next = { delegation: { ...original.delegation, delegationCid: "new", issuedAt: new Date(1_225_000).toISOString(), expiresAt: new Date(1_525_000).toISOString() } } as NativeSession;
  const renewal = new NativeRenewal({
    openkey: { current: async () => original, renew: async () => next } as unknown as OpenKeyNative,
    tcw: raw, session: original, sessionStore: { setSession: () => {} },
    requestNonce: async () => "nonce", verifySession: async () => ({ token: "jwt", expiresIn: 300, address: original.delegation.address! }),
    install: async () => { old.retire(); failNextPartOnNewGraph = true; live = graph(); },
    onTerminal: () => {}, onStorage: () => {}, now: () => now, jitter: () => 0,
    recoverPendingSave: schedulePendingVoiceNotesRecovery,
  });
  const guarded = guardNativeTinyCloudCalls(raw, renewal);
  let finishRecovery!: () => void;
  const recovered = new Promise<void>((resolve) => { finishRecovery = resolve; });
  const unregister = registerPendingVoiceNotesRecovery(async () => {
    const result = await savePendingRecordings(guarded);
    expect(result.saved.map((item) => item.id)).toEqual([note.id]);
    finishRecovery();
  });
  try {
    const first = savePendingRecordings(guarded);
    await atPart; // the old graph has a storage request in flight
    now = 1_240_000;
    await renewal.check(); // the forced deadline retires that graph
    expect((await first).left.map((item) => item.id)).toEqual([note.id]);
    await recovered; // scheduled after the save's single-flight guard settles
    expect(manifestAndParts.has(store.voiceNoteAudioManifestKey(note.id))).toBe(true);
    expect(records.get(note.id)).toEqual({ audio: store.voiceNoteAudioKvKey(note.id), parts: 2 });
    expect(pending).toBe(false);
  } finally {
    unregister();
    renewal.stop();
    manifestAndParts.clear();
    records.clear();
  }
});
