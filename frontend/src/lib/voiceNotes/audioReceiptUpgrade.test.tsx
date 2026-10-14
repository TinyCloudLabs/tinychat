import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { IDBFactory } from "fake-indexeddb";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { installDom } from "@/test/dom";
import { AudioCacheSettings } from "@/capture/AudioCacheSettings";
import { audioBaseKey, blobPartSource, putAudio, type TinyCloudKv } from "@/lib/audio/audioStore";
import { cachedAudioSize, trimCachedAudio } from "./audioPlaybackCache";
import { bytesToBase64 } from "./voiceNoteAudio";
import { VoiceNotes, __setVoiceNotesForTests, type VoiceNoteRecording, type VoiceNotesPlugin } from "./nativeVoiceNotes";
import { reconcileAudioCache, useAudioCacheBoot } from "./audioReceiptUpgrade";

const original = VoiceNotes;
const originalIdb = globalThis.indexedDB;
let root: Root | null = null;
let restoreDom: (() => void) | null = null;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  restoreDom?.(); restoreDom = null;
  globalThis.indexedDB = originalIdb;
  __setVoiceNotesForTests(original, { available: null });
});

class SpaceKv {
  entries = new Map<string, Uint8Array>();
  gets: string[] = [];
  async put(key: string, value: unknown) {
    const bytes = value instanceof Blob ? new Uint8Array(await value.arrayBuffer())
      : value instanceof Uint8Array ? value : new TextEncoder().encode(String(value));
    this.entries.set(key, bytes);
    return { ok: true as const, data: { data: undefined, headers: {} } };
  }
  async get(key: string, options?: { binary?: boolean; maxResponseBytes?: number }) {
    this.gets.push(key);
    const bytes = this.entries.get(key);
    if (!bytes) return { ok: false as const, error: { code: "KV_NOT_FOUND", message: key, service: "kv" } };
    if (options?.maxResponseBytes && bytes.length > options.maxResponseBytes)
      return { ok: false as const, error: { code: "KV_RESPONSE_TOO_LARGE", message: key, service: "kv" } };
    return { ok: true as const, data: { data: options?.binary ? bytes : JSON.parse(new TextDecoder().decode(bytes)), headers: {} } };
  }
  async list({ path }: { path: string }) {
    return { ok: true as const, data: { keys: [...this.entries.keys()].filter((key) => key.startsWith(path)), truncated: false } };
  }
  kv() { return this as unknown as TinyCloudKv; }
}

function Boot({ tcw }: { tcw: TinyCloudWeb }) {
  useAudioCacheBoot(tcw);
  return <AudioCacheSettings />;
}

async function fixture(mismatch = false, uploadAudio?: boolean) {
  restoreDom = installDom();
  globalThis.indexedDB = new IDBFactory() as unknown as IDBFactory;
  const did = "did:test:receipt-upgrade";
  const id = mismatch ? "unverifiable" : "pre-receipt";
  const local = new Uint8Array(1024 * 1024).fill(mismatch ? 2 : 1);
  const remote = new Uint8Array(1024 * 1024).fill(1);
  const kv = new SpaceKv();
  const base = audioBaseKey("exo-voice-note", id);
  const modern = await putAudio(kv.kv(), base, blobPartSource(new Blob([remote])),
    { fileName: `${id}.m4a`, mimeType: "audio/mp4" });
  await kv.put(`${base}/manifest`, JSON.stringify({ ...modern, sha256: null,
    parts: modern.parts.map(({ size, etag }) => ({ size, etag })) }));
  let size = local.length;
  let evictions = 0;
  const note: VoiceNoteRecording = { id, owner: did, rev: 1, startedAt: 1,
    durationMs: 1000, mimeType: "audio/mp4", sizeBytes: local.length,
    silencedMs: 0, silencedEvents: 0, noSignalMs: 0,
    ledger: { audio: { state: "saved", rowId: "row", at: 1 } },
    ...(uploadAudio === undefined ? {} : { options: { uploadAudio } as VoiceNoteRecording["options"] }),
  };
  __setVoiceNotesForTests({
    listPending: async () => ({ recordings: [note] }),
    localAudioSize: async () => ({ size }),
    readAudioChunk: async ({ offset, length }: { offset: number; length: number }) =>
      ({ base64: bytesToBase64(local.slice(offset, offset + length)), size: local.length }),
    updateLedger: async ({ patch }: { patch: { audio: VoiceNoteRecording["ledger"]["audio"] } }) => {
      note.ledger!.audio = patch.audio; note.rev = (note.rev ?? 0) + 1;
    },
    evictCachedAudio: async () => { if (!note.ledger?.audio.verifiedInSpace) throw new Error("unverified eviction"); size = 0; evictions++; },
  } as VoiceNotesPlugin, { available: true });
  const tcw = { did, spaceId: "space", kv: kv.kv() } as TinyCloudWeb;
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(<Boot tcw={tcw} />));
  // The boot pass and Settings refresh share one authenticated reconciliation.
  await act(async () => { await reconcileAudioCache(tcw); });
  for (let attempt = 0; attempt < 20 && !container.textContent?.includes("used"); attempt++) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
  }
  return { note, kv, tcw, container, size: () => size, evictions: () => evictions };
}

test("real authenticated boot upgrades a pre-receipt saved file in one remote part read before eviction", async () => {
  const { note, kv, container, evictions } = await fixture();
  expect(note.ledger?.audio.verifiedInSpace).toMatchObject({ size: 1024 * 1024 });
  expect(kv.gets.filter((key) => key.endsWith("/p/000000"))).toHaveLength(1);
  expect(container.textContent).toContain("1 MB");
  expect((await cachedAudioSize()).bytes).toBe(1024 * 1024);
  await trimCachedAudio(0);
  expect(evictions()).toBe(1);
});

test("completed reconciliation is cooled down until Settings explicitly requests another pass", async () => {
  const { kv, tcw } = await fixture(true);
  const before = kv.gets.length;
  await reconcileAudioCache(tcw);
  expect(kv.gets.length).toBe(before);
  await reconcileAudioCache(tcw, true);
  expect(kv.gets.length).toBeGreaterThan(before);
});

test("real authenticated boot keeps unverifiable pre-receipt audio protected", async () => {
  const { note, size, evictions } = await fixture(true);
  expect(note.ledger?.audio.verifiedInSpace).toBeUndefined();
  await trimCachedAudio(0);
  expect(evictions()).toBe(0);
  expect(size()).toBe(1024 * 1024);
});

test("a note saved without audio upload is never probed against the space", async () => {
  const { note, kv, evictions, size } = await fixture(false, false);
  expect(kv.gets).toEqual([]);
  expect(note.ledger?.audio.verifiedInSpace).toBeUndefined();
  await trimCachedAudio(0);
  expect(evictions()).toBe(0);
  expect(size()).toBe(1024 * 1024);
});
