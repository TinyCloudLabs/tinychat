// Voice notes persistence. Rules:
//   1. audio is written to KV under the granted connectors/ prefix BEFORE the row exists, so a
//      listed note always has audio behind it; a failed audio write writes no row;
//   2. audio is stored as raw parts of at most 1 MiB (the production ingress refuses larger request
//      bodies) plus a manifest written LAST, so a manifest always means a whole file;
//   3. a save that fails part-way leaves no manifest and no row (the recording stays pending on the
//      phone), and saving again resumes after the stored parts, writing nothing twice;
//   4. the row is a connector_meeting with source "exo-voice-note" and the OS capture evidence;
//   5. stored audio round-trips (parts in order, or a pre-TC-517 single value), and malformed or
//      mismatched audio fails closed.

import { beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { _resetConnectorSchemaMemoForTests } from "../connectors/connectorStore";
import { APP_ID } from "../threadStore";
import { bytesToBase64 } from "./voiceNoteAudio";
import { MAX_AUDIO_PART_SIZE, parseAudioManifest } from "../audio/audioStore";
import {
  VOICE_NOTE_AUDIO_TOO_LARGE,
  VOICE_NOTE_SOURCE,
  VOICE_NOTE_STORAGE_FULL,
  listVoiceNotes,
  loadVoiceNoteAudio,
  loadVoiceNoteAudioBlob,
  putVoiceNoteAudio,
  saveVoiceNote,
  saveVoiceNoteTranscript,
  voiceNoteAudioKvKey,
  voiceNoteAudioManifestKey,
  voiceNoteAudioPartKey,
  voiceNoteAudioSourceFromBase64,
  voiceNoteMarkdownKvKey,
  syncRecordingNote,
  readRecordingNoteFromSpace,
  recordingNoteSyncError,
  type VoiceNoteAudioSource,
} from "./voiceNoteStore";
import { loadNote, noteMarkdown, saveNote } from "./recordingNotes";
import type { VoiceNoteRecording } from "./nativeVoiceNotes";

type KvValue = string | Uint8Array;
type KvFailure = { code: string; message: string; meta?: { status: number } };
type Call =
  | { kind: "sql.execute" | "sql.query"; target: string; params: unknown[] }
  | { kind: "kv.put"; target: string; value: KvValue; contentType?: string }
  | { kind: "kv.get" | "kv.list"; target: string; options?: unknown };
let fakeSpaceNumber = 0;

/**
 * A space with in-memory KV and a minimal SQL fake (rows by source_id). `failPut(key, n)` lets a
 * put fail; `kv` is the stored state, so a test can retry against what a failed attempt left.
 */
function fakeSpace(opts: { kv?: Map<string, KvValue>; rows?: unknown[][] } = {}) {
  const calls: Call[] = [];
  const kv = opts.kv ?? new Map<string, KvValue>();
  const sqlite = new Database(":memory:");
  let seeded = false;
  let putFailure: ((key: string) => KvFailure | null) | null = null;
  let listFailure: KvFailure | null = null;
  let getFailure: ((key: string) => KvFailure | null) | null = null;
  const inserted: string[] = [];
  const tcw = {
    did: `did:pkh:eip155:1:0xabc${++fakeSpaceNumber}`,
    sql: {
      db(name: string) {
        return {
          async execute(sql: string, params: unknown[] = []) {
            calls.push({ kind: "sql.execute", target: name, params: [sql, ...params] });
            if (sql.includes("INSERT INTO connector_meeting")) inserted.push(String(params.find((p) => p === "rec-1" || p === "rec-2")));
            try {
              const changes = sqlite.prepare(sql).run(...params as never[]).changes;
              if (!seeded && opts.rows && sql.includes("CREATE TABLE IF NOT EXISTS connector_meeting")) {
                seeded = true;
                for (const r of opts.rows) sqlite.prepare(`INSERT INTO connector_meeting
                  (id, source, source_id, title, started_at, duration_secs, participants, metadata, created_at, updated_at)
                  VALUES (?, 'exo-voice-note', ?, ?, ?, ?, '[]', ?, ?, ?)`).run(
                    r[0] as string, r[1] as string, r[2] as string, r[3] as string, r[4] as number,
                    (r[5] ?? "{}") as string, "2026-09-29T05:40:00.000Z", "2026-09-29T05:40:00.000Z");
              }
              return { ok: true, data: { changes } };
            } catch (e) { return { ok: false, error: { code: "SQL_ERROR", message: String(e) } }; }
          },
          async query(sql: string, params: unknown[] = []) {
            calls.push({ kind: "sql.query", target: name, params: [sql, ...params] });
            try { return { ok: true, data: { rows: sqlite.prepare(sql).all(...params as never[]).map((r) => Object.values(r as object)) } }; }
            catch (e) { return { ok: false, error: { code: "SQL_ERROR", message: String(e) } }; }
          },
        };
      },
    },
    kv: {
      async put(key: string, value: KvValue, options?: { contentType?: string; ifNoneMatch?: string }) {
        calls.push({ kind: "kv.put", target: key, value, contentType: options?.contentType });
        const failure = putFailure?.(key) ?? null;
        if (failure) return { ok: false, error: failure };
        if (options?.ifNoneMatch === "*" && kv.has(key))
          return { ok: false, error: { code: "KV_PRECONDITION_FAILED", message: "412" } };
        kv.set(key, value);
        return { ok: true, data: { data: undefined, headers: { etag: `"etag-${key.split("/").pop()}"` } } };
      },
      async get(key: string, options?: { binary?: boolean }) {
        calls.push({ kind: "kv.get", target: key, options });
        const failure = getFailure?.(key) ?? null;
        if (failure) return { ok: false, error: failure };
        if (!kv.has(key)) return { ok: false, error: { code: "KV_NOT_FOUND", message: "missing" } };
        return { ok: true, data: { data: kv.get(key) } };
      },
      async list(options: { path: string }) {
        calls.push({ kind: "kv.list", target: options.path });
        if (listFailure) return { ok: false, error: listFailure };
        return { ok: true, data: { keys: [...kv.keys()].filter((k) => k.startsWith(options.path)) } };
      },
    },
  };
  return {
    tcw: tcw as unknown as TinyCloudWeb,
    calls,
    kv,
    inserted,
    failPut(fn: ((key: string) => KvFailure | null) | null) {
      putFailure = fn;
    },
    failGet(fn: ((key: string) => KvFailure | null) | null) {
      getFailure = fn;
    },
    failList(failure: KvFailure | null) {
      listFailure = failure;
    },
  };
}

const recording: VoiceNoteRecording = {
  id: "rec-1",
  startedAt: Date.parse("2026-09-29T05:40:00.000Z"),
  durationMs: 12_400,
  mimeType: "audio/mp4",
  sizeBytes: 98_000,
  silencedMs: 1_500,
  silencedEvents: 1,
  noSignalMs: 0,
};

function audioBytes(size: number): Uint8Array {
  return new Uint8Array(size).map((_, i) => (i * 7 + 3) % 256);
}

/** A source over `bytes` that records every read, like the phone's readAudioChunk. */
function trackedSource(bytes: Uint8Array) {
  const reads: [number, number][] = [];
  const source: VoiceNoteAudioSource = {
    mimeType: "audio/mp4",
    size: bytes.byteLength,
    async readPart(offset, length) {
      reads.push([offset, length]);
      return bytes.slice(offset, offset + length);
    },
  };
  return { source, reads };
}

const noWait = { retryDelaysMs: [0, 0] };
const puts = (calls: Call[]) => calls.filter((c): c is Extract<Call, { kind: "kv.put" }> => c.kind === "kv.put");
const AUDIO_BASE = `${APP_ID}/connectors/exo-voice-note/audio/rec-1`;

beforeEach(() => _resetConnectorSchemaMemoForTests());

describe("saveVoiceNote", () => {
  test("a Markdown sync failure leaves the audio save successful and retries separately", async () => {
    const space = fakeSpace();
    const withNote = { ...recording, id: `rec-note-sync-${++fakeSpaceNumber}` };
    await saveNote(withNote.id, "# Local draft");
    const noteKey = voiceNoteMarkdownKvKey(withNote.id);
    space.failPut((key) => key === noteKey ? { code: "KV_ERROR", message: "notes offline" } : null);
    const saved = await saveVoiceNote(space.tcw, withNote,
      voiceNoteAudioSourceFromBase64({ mimeType: "audio/mp4", base64: "AAAA" }), "android");
    expect(saved.ok).toBe(true);
    if (!saved.ok) throw new Error(saved.error.message);
    expect(saved.data.noteSyncError).toBe("sync_failed");
    expect(recordingNoteSyncError(space.tcw, withNote.id)).toBe("sync_failed");
    expect(recordingNoteSyncError({ ...space.tcw, did: "did:other" } as TinyCloudWeb, withNote.id)).toBeNull();
    expect(space.kv.has(voiceNoteAudioManifestKey(withNote.id))).toBe(true);
    expect(space.kv.has(noteKey)).toBe(false);

    space.failPut(null);
    expect(await syncRecordingNote(space.tcw, withNote.id)).toBe(true);
    expect(recordingNoteSyncError(space.tcw, withNote.id)).toBeNull();
    expect(space.kv.get(noteKey)).toContain("# Local draft");
  });

  test("sync carries the saved-edit time to the space and a recorder write after it does not clear it", async () => {
    const space = fakeSpace();
    const withNote = { ...recording, id: `rec-note-saved-edit-${++fakeSpaceNumber}` };
    const noteKey = voiceNoteMarkdownKvKey(withNote.id);
    await saveNote(withNote.id, "# Recorded");
    await saveVoiceNote(space.tcw, withNote,
      voiceNoteAudioSourceFromBase64({ mimeType: "audio/mp4", base64: "AAAA" }), "android");
    expect(space.kv.get(noteKey)).not.toContain("edited:");
    expect((await readRecordingNoteFromSpace(space.tcw, withNote.id))?.savedEditAt).toBeNull();

    const edited = await saveNote(withNote.id, "# Edited after saving", { savedEdit: true });
    expect(await syncRecordingNote(space.tcw, withNote.id)).toBe(true);
    expect((await readRecordingNoteFromSpace(space.tcw, withNote.id))?.savedEditAt).toBe(edited.savedEditAt);
    expect(edited.savedEditAt).toBe(edited.editedAt);

    await saveNote(withNote.id, "# Edited after saving, then a recorder write");
    expect(await syncRecordingNote(space.tcw, withNote.id)).toBe(true);
    expect((await readRecordingNoteFromSpace(space.tcw, withNote.id))?.savedEditAt).toBe(edited.savedEditAt);
  });

  test("a stale device's sync keeps the saved-edit time another device stored, and adopts it", async () => {
    const space = fakeSpace();
    const withNote = { ...recording, id: `rec-note-remote-edit-${++fakeSpaceNumber}` };
    const noteKey = voiceNoteMarkdownKvKey(withNote.id);
    await saveNote(withNote.id, "# Recorded on A");
    await saveVoiceNote(space.tcw, withNote,
      voiceNoteAudioSourceFromBase64({ mimeType: "audio/mp4", base64: "AAAA" }), "android");
    const first = (await loadNote(withNote.id))!;
    expect(first.savedEditAt).toBeNull();

    // Device B saves an edit and syncs its `edited:` line to the space.
    const bEditedAt = "2099-01-01T00:00:00.000Z";
    space.kv.set(noteKey, noteMarkdown({ ...first, md: "# Edited on B", savedEditAt: bEditedAt, editedAt: bEditedAt }));

    // Device A, still without a marker, writes again and syncs.
    await saveNote(withNote.id, "# Recorded on A, more");
    expect(await syncRecordingNote(space.tcw, withNote.id)).toBe(true);
    expect(space.kv.get(noteKey)).toContain(`edited: ${JSON.stringify(bEditedAt)}`);
    expect((await readRecordingNoteFromSpace(space.tcw, withNote.id))?.savedEditAt).toBe(bEditedAt);
    expect((await loadNote(withNote.id))?.savedEditAt).toBe(bEditedAt);
  });

  test("when both devices hold a saved-edit time the later one is written", async () => {
    const space = fakeSpace();
    const withNote = { ...recording, id: `rec-note-both-edit-${++fakeSpaceNumber}` };
    const noteKey = voiceNoteMarkdownKvKey(withNote.id);
    await saveNote(withNote.id, "# Recorded");
    await saveVoiceNote(space.tcw, withNote,
      voiceNoteAudioSourceFromBase64({ mimeType: "audio/mp4", base64: "AAAA" }), "android");
    const base = (await loadNote(withNote.id))!;

    const localEdit = await saveNote(withNote.id, "# Local edit", { savedEdit: true });
    const olderRemote = "2000-01-01T00:00:00.000Z";
    space.kv.set(noteKey, noteMarkdown({ ...base, savedEditAt: olderRemote }));
    expect(await syncRecordingNote(space.tcw, withNote.id)).toBe(true);
    expect((await readRecordingNoteFromSpace(space.tcw, withNote.id))?.savedEditAt).toBe(localEdit.savedEditAt);

    const newerRemote = "2099-01-01T00:00:00.000Z";
    space.kv.set(noteKey, noteMarkdown({ ...base, savedEditAt: newerRemote }));
    await saveNote(withNote.id, "# Local edit, recorder write");
    expect(await syncRecordingNote(space.tcw, withNote.id)).toBe(true);
    expect((await readRecordingNoteFromSpace(space.tcw, withNote.id))?.savedEditAt).toBe(newerRemote);
    expect((await loadNote(withNote.id))?.savedEditAt).toBe(newerRemote);
  });

  test("a failed read of the space note makes no put and shows a sync error", async () => {
    const space = fakeSpace();
    const withNote = { ...recording, id: `rec-note-read-fail-${++fakeSpaceNumber}` };
    const noteKey = voiceNoteMarkdownKvKey(withNote.id);
    await saveNote(withNote.id, "# Recorded");
    await saveVoiceNote(space.tcw, withNote,
      voiceNoteAudioSourceFromBase64({ mimeType: "audio/mp4", base64: "AAAA" }), "android");
    const stored = space.kv.get(noteKey);
    await saveNote(withNote.id, "# Changed while offline");
    const putsBefore = puts(space.calls).length;

    space.failGet((key) => key === noteKey ? { code: "KV_ERROR", message: "read offline" } : null);
    await expect(syncRecordingNote(space.tcw, withNote.id)).rejects.toThrow("Could not load recording note");
    expect(puts(space.calls).length).toBe(putsBefore);
    expect(space.kv.get(noteKey)).toBe(stored);
    expect(recordingNoteSyncError(space.tcw, withNote.id)).toBe("sync_failed");

    space.failGet(null);
    expect(await syncRecordingNote(space.tcw, withNote.id)).toBe(true);
    expect(recordingNoteSyncError(space.tcw, withNote.id)).toBeNull();
    expect(space.kv.get(noteKey)).toContain("# Changed while offline");
  });

  test("creates the indexed identity, then patches audio after its manifest", async () => {
    const { tcw, calls } = fakeSpace();
    const res = await saveVoiceNote(tcw, recording, voiceNoteAudioSourceFromBase64({ mimeType: "audio/mp4", base64: "AAAA" }), "android");
    expect(res.ok).toBe(true);

    expect(voiceNoteAudioKvKey("rec-1")).toBe(AUDIO_BASE);
    expect(voiceNoteAudioPartKey("rec-1", 0)).toBe(`${AUDIO_BASE}/p/000000`);
    expect(voiceNoteAudioManifestKey("rec-1")).toBe(`${AUDIO_BASE}/manifest`);
    expect(puts(calls).map((c) => c.target)).toEqual([expect.stringContaining("/transcript/rec-1"), `${AUDIO_BASE}/p/000000`, `${AUDIO_BASE}/manifest`]);
    expect(puts(calls)[1]).toEqual(expect.objectContaining({ value: new Uint8Array([0, 0, 0]), contentType: "application/octet-stream" }));
    const firstSql = calls.findIndex((c) => c.kind === "sql.execute" && String(c.params[0]).includes("INSERT INTO connector_meeting"));
    const manifestPut = calls.findIndex((c) => c.kind === "kv.put" && c.target.endsWith("/manifest"));
    expect(manifestPut).toBeGreaterThanOrEqual(0);
    expect(firstSql).toBeLessThan(manifestPut);

    const insert = calls.find((c) => c.kind === "sql.execute" && String(c.params[0]).includes("INSERT INTO connector_meeting"))!;
    expect(insert.params).toContain("rec-1");
    expect(insert.params).toContain("vn-rec-1");
    const patch = calls.find((c) => c.kind === "sql.execute" && String(c.params[1]).includes("audio_kv_key"))!;
    const metadata = JSON.parse(String(patch.params[1]));
    expect(metadata).toEqual(expect.objectContaining({
      audio_kv_key: AUDIO_BASE,
      audio_format: "parts-v1",
      audio_mime_type: "audio/mp4",
      audio_bytes: 3,
      audio_parts: 1,
      audio: { stored: true, base: AUDIO_BASE },
    }));
    expect(metadata.capture).toEqual({
      platform: "android",
      duration_ms: 12_400,
      silenced_ms: 1_500,
      silenced_events: 1,
      no_signal_ms: 0,
    });
  });

  test("a failed audio write leaves the identity row pending without a manifest", async () => {
    const space = fakeSpace();
    space.failPut((key) => key.includes("/audio/") ? { code: "KV_ERROR", message: "boom" } : null);
    const res = await saveVoiceNote(space.tcw, recording, voiceNoteAudioSourceFromBase64({ mimeType: "audio/mp4", base64: "AAAA" }), "android", noWait);
    expect(res.ok).toBe(false);
    expect(space.calls.some((c) => c.kind === "sql.execute" && String(c.params[0]).includes("INSERT INTO connector_meeting"))).toBe(true);
    expect([...space.kv.keys()]).toEqual([expect.stringContaining("/transcript/rec-1")]);
  });
});

describe("putVoiceNoteAudio (parts + manifest)", () => {
  test("a 60-minute note (~29 MB) is 1 MiB parts, each read from the phone only as it is sent", async () => {
    const size = 29 * 1024 * 1024 + 12_345;
    const bytes = audioBytes(size);
    const { source, reads } = trackedSource(bytes);
    const { tcw, calls, kv } = fakeSpace();
    const res = await putVoiceNoteAudio(tcw, "rec-1", source);
    expect(res.ok).toBe(true);
    const parts = puts(calls).filter((c) => c.target.includes("/p/"));
    expect(parts).toHaveLength(30);
    for (const part of parts) expect((part.value as Uint8Array).byteLength).toBeLessThanOrEqual(MAX_AUDIO_PART_SIZE);
    expect(MAX_AUDIO_PART_SIZE).toBe(1_048_576);
    expect(reads[0]).toEqual([0, MAX_AUDIO_PART_SIZE]);
    expect(reads.at(-1)).toEqual([29 * MAX_AUDIO_PART_SIZE, 12_345]);
    // Interleaved: read, put, read, put... (never the whole file first).
    expect(calls.filter((c) => c.kind === "kv.put").map((c) => c.target).at(-1)).toBe(`${AUDIO_BASE}/manifest`);
    const manifest = parseAudioManifest(kv.get(`${AUDIO_BASE}/manifest`));
    expect(manifest).toEqual(expect.objectContaining({ v: 1, mimeType: "audio/mp4", size, partSize: MAX_AUDIO_PART_SIZE, sha256: null }));
    expect(manifest!.parts).toHaveLength(30);
    expect(manifest!.parts[0]).toEqual({ size: MAX_AUDIO_PART_SIZE, etag: '"etag-000000"' });
  });

  test("a part read that comes back short fails before anything is sent for it", async () => {
    const { tcw, calls } = fakeSpace();
    const source: VoiceNoteAudioSource = { mimeType: "audio/mp4", size: 2_000, readPart: async (_o, length) => new Uint8Array(length - 1) };
    const res = await putVoiceNoteAudio(tcw, "rec-1", source, { partSize: 1_000 });
    expect(res).toEqual({ ok: false, error: expect.objectContaining({ code: "VOICE_NOTE_SOURCE_READ_FAILED" }) });
    expect(puts(calls)).toEqual([]);
  });

  test("a full space is reported as such (402/413), with no manifest", async () => {
    const space = fakeSpace();
    space.failPut((key) => (key.endsWith("/p/000001") ? { code: "KV_PUT_FAILED", message: "Payment Required", meta: { status: 402 } } : null));
    const res = await putVoiceNoteAudio(space.tcw, "rec-1", trackedSource(audioBytes(3_000)).source, { partSize: 1_000, ...noWait });
    expect(res).toEqual({ ok: false, error: expect.objectContaining({ code: VOICE_NOTE_STORAGE_FULL }) });
    expect(space.kv.has(`${AUDIO_BASE}/manifest`)).toBe(false);
  });

  test("a transient failure is retried in place (bounded), not reported", async () => {
    const space = fakeSpace();
    let failures = 2;
    space.failPut((key) => (key.endsWith("/p/000001") && failures-- > 0 ? { code: "NETWORK_ERROR", message: "Failed to fetch" } : null));
    const res = await putVoiceNoteAudio(space.tcw, "rec-1", trackedSource(audioBytes(3_000)).source, { partSize: 1_000, ...noWait });
    expect(res.ok).toBe(true);
    expect(puts(space.calls).filter((c) => c.target.endsWith("/p/000001"))).toHaveLength(3);
  });
});

describe("a save that fails part-way stays pending and retries without duplicates", () => {
  test("parts stored by the failed attempt are neither read nor sent again; the manifest and row are written once", async () => {
    const bytes = audioBytes(4_500);
    const space = fakeSpace();
    // Attempt 1: part 2 keeps failing (past the retries); nothing is listed as a note.
    space.failPut((key) => (key.endsWith("/p/000002") ? { code: "NETWORK_ERROR", message: "Failed to fetch" } : null));
    const first = trackedSource(bytes);
    const failed = await saveVoiceNote(space.tcw, recording, first.source, "android", { partSize: 1_000, ...noWait });
    expect(failed.ok).toBe(false);
    expect(space.kv.has(`${AUDIO_BASE}/manifest`)).toBe(false);
    expect(space.calls.some((c) => c.kind === "sql.execute" && String(c.params[0]).includes("INSERT INTO connector_meeting"))).toBe(true);
    expect([...space.kv.keys()].sort()).toEqual([`${AUDIO_BASE}/p/000000`, `${AUDIO_BASE}/p/000001`,
      `${APP_ID}/connectors/exo-voice-note/transcript/rec-1`]);

    // Attempt 2 (Save now): resumes at part 2.
    space.failPut(null);
    space.calls.length = 0;
    const second = trackedSource(bytes);
    const saved = await saveVoiceNote(space.tcw, recording, second.source, "android", { partSize: 1_000, ...noWait });
    expect(saved.ok).toBe(true);
    expect(second.reads).toEqual([[2_000, 1_000], [3_000, 1_000], [4_000, 500]]);
    expect(puts(space.calls).map((c) => c.target.replace(`${AUDIO_BASE}/`, ""))).toEqual([
      `${APP_ID}/connectors/exo-voice-note/transcript/rec-1`,
      "p/000002",
      "p/000003",
      "p/000004",
      "manifest",
    ]);
    const manifest = parseAudioManifest(space.kv.get(`${AUDIO_BASE}/manifest`))!;
    expect(manifest.parts.map((p) => p.size)).toEqual([1_000, 1_000, 1_000, 1_000, 500]);
    expect(manifest.parts.map((p) => p.etag)).toEqual([null, null, '"etag-000002"', '"etag-000003"', '"etag-000004"']);
    expect(space.inserted).toEqual(["rec-1", "rec-1"]);

    // The whole file reads back byte for byte.
    const blob = await loadVoiceNoteAudioBlob(space.tcw, "rec-1");
    expect(blob.ok && new Uint8Array(await blob.data.arrayBuffer())).toEqual(bytes);
  });

  test("a save that stored everything but failed on the row: the retry rewrites only the manifest and inserts one row", async () => {
    const space = fakeSpace();
    const bytes = audioBytes(1_500);
    await putVoiceNoteAudio(space.tcw, "rec-1", trackedSource(bytes).source, { partSize: 1_000 });
    space.calls.length = 0;
    const retry = trackedSource(bytes);
    expect((await saveVoiceNote(space.tcw, recording, retry.source, "android", { partSize: 1_000 })).ok).toBe(true);
    expect(retry.reads).toEqual([]);
    expect(puts(space.calls).filter((c) => c.target.includes("/audio/")).map((c) => c.target)).toEqual([`${AUDIO_BASE}/manifest`]);

    // And once more after the row exists (the device delete failed): still one row.
    expect((await saveVoiceNote(space.tcw, recording, trackedSource(bytes).source, "android", { partSize: 1_000 })).ok).toBe(true);
    expect(space.inserted).toEqual(["rec-1", "rec-1"]);
  });

  test("a resume whose list of stored parts fails writes nothing and stays pending", async () => {
    const space = fakeSpace();
    space.failList({ code: "NETWORK_ERROR", message: "Failed to fetch" });
    const source = trackedSource(audioBytes(2_500));

    const res = await saveVoiceNote(space.tcw, recording, source.source, "android", { partSize: 1_000, ...noWait });

    expect(res.ok).toBe(false);
    // Retried in place (two retries), then reported.
    expect(space.calls.filter((c) => c.kind === "kv.list")).toHaveLength(3);
    expect(source.reads).toEqual([]);
    expect(puts(space.calls).map((c) => c.target)).toEqual([expect.stringContaining("/transcript/rec-1")]);
    expect(space.calls.some((c) => c.kind === "sql.execute" && String(c.params[0]).includes("INSERT INTO connector_meeting"))).toBe(true);
    expect([...space.kv.keys()]).toEqual([expect.stringContaining("/transcript/rec-1")]);
  });
});

describe("listVoiceNotes", () => {
  test("maps rows newest first for this source only", async () => {
    const { tcw, calls } = fakeSpace({ rows: [["row-1", "rec-1", "Voice note", "2026-09-29T05:40:00.000Z", 12]] });
    const res = await listVoiceNotes(tcw);
    expect(res).toEqual({
      ok: true,
      data: [{
        id: "row-1",
        sourceId: "rec-1",
        title: "Voice note",
        startedAt: "2026-09-29T05:40:00.000Z",
        durationSecs: 12,
        transcript: { status: "none", preview: null },
      }],
    });
    const list = calls.find((c) => c.kind === "sql.query" && String(c.params[0]).includes("SELECT id, source_id"));
    expect(list!.kind === "sql.query" && list!.params).toContain(VOICE_NOTE_SOURCE);
  });

  test("a note's transcript state comes from the metadata its transcription wrote", async () => {
    const row = (metadata: unknown) => ["row-1", "rec-1", "Voice note", "2026-09-29T05:40:00.000Z", 12, metadata];
    const state = async (metadata: unknown) => {
      const res = await listVoiceNotes(fakeSpace({ rows: [row(metadata)] }).tcw);
      return res.ok ? res.data[0]!.transcript : null;
    };
    expect(await state(JSON.stringify({ audio_kv_key: "k" }))).toEqual({ status: "none", preview: null });
    expect(await state(JSON.stringify({ transcription_outcome: "transcribed", transcript_text: "Book the venue.\nSend the budget." }))).toEqual({
      status: "transcribed",
      preview: "Book the venue.\nSend the budget.",
    });
    expect(await state(JSON.stringify({ transcription_outcome: "no_speech", transcript_text: null }))).toEqual({ status: "no_speech", preview: null });
    expect(await state("not json")).toEqual({ status: "none", preview: null });
    expect(await state(null)).toEqual({ status: "none", preview: null });
    const long = await state(JSON.stringify({ transcription_outcome: "transcribed", transcript_text: "word ".repeat(200) }));
    expect(long!.status).toBe("transcribed");
    expect(long!.preview!.length).toBeLessThanOrEqual(281);
    expect(long!.preview!.endsWith("…")).toBe(true);
  });
});

describe("saveVoiceNoteTranscript", () => {
  const prepared = {
    rev: 1,
    sentences: [{ index: 0, speaker_name: "You", text: "Book the venue.", start_time: 0, end_time: 3 }],
    speakers: ["You"],
    metadata: { transcription_engine: "private-cloud", transcript_text: "Book the venue." },
  };

  test("requires a ledger revision before any storage call", async () => {
    const { tcw, calls } = fakeSpace();
    const result = await saveVoiceNoteTranscript(tcw, "rec", { ...prepared, rev: undefined as never });
    expect(result).toMatchObject({ ok: false, error: { code: "VOICE_NOTE_REV_REQUIRED" } });
    expect(calls).toEqual([]);
  });

  test("refuses a note that no longer exists instead of creating a row without audio", async () => {
    const { tcw, calls } = fakeSpace();
    const res = await saveVoiceNoteTranscript(tcw, "rec-gone", prepared);
    expect(res).toEqual({ ok: false, error: expect.objectContaining({ code: "VOICE_NOTE_NOT_FOUND" }) });
    expect(puts(calls)).toEqual([]);
    expect(calls.some((c) => c.kind === "sql.execute" && /INSERT INTO connector_meeting/.test(String(c.params[0])))).toBe(false);
  });
});

describe("listVoiceNotes dedup", () => {
  test("one note per recording id even if a racing save wrote two rows", async () => {
    const { tcw } = fakeSpace({
      rows: [
        ["row-2", "rec-1", "Voice note", "2026-09-29T05:40:00.000Z", 12],
        ["row-1", "rec-1", "Voice note", "2026-09-29T05:40:00.000Z", 12],
        ["row-3", "rec-2", "Voice note", "2026-09-29T05:30:00.000Z", 4],
      ],
    });
    const res = await listVoiceNotes(tcw);
    expect(res.ok && res.data.map((n) => n.sourceId)).toEqual(["rec-1", "rec-2"]);
  });
});

describe("loading a note's audio", () => {
  async function stored(bytes: Uint8Array, partSize = 1_000) {
    const space = fakeSpace();
    expect((await putVoiceNoteAudio(space.tcw, "rec-1", trackedSource(bytes).source, { partSize })).ok).toBe(true);
    space.calls.length = 0;
    return space;
  }

  test("parts come back in order as one typed Blob, each fetched as bytes with its size bound", async () => {
    const bytes = audioBytes(2_345);
    const space = await stored(bytes);
    const progress: number[] = [];
    const res = await loadVoiceNoteAudioBlob(space.tcw, "rec-1", { onProgress: (loaded) => progress.push(loaded) });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.type).toBe("audio/mp4");
    expect(new Uint8Array(await res.data.arrayBuffer())).toEqual(bytes);
    expect(progress).toEqual([1_000, 2_000, 2_345]);
    const partGets = space.calls.filter((c) => c.kind === "kv.get" && c.target.includes("/p/"));
    expect(partGets.map((c) => c.kind === "kv.get" && c.options)).toEqual([
      { binary: true, maxResponseBytes: 1_000 },
      { binary: true, maxResponseBytes: 1_000 },
      { binary: true, maxResponseBytes: 345 },
    ]);
  });

  test("as base64 for transcription, too", async () => {
    const bytes = audioBytes(2_345);
    const space = await stored(bytes);
    expect(await loadVoiceNoteAudio(space.tcw, "rec-1")).toEqual({ ok: true, data: { mimeType: "audio/mp4", base64: bytesToBase64(bytes) } });
  });

  test("a note saved before TC-517 (one JSON value, no manifest) still plays and transcribes", async () => {
    const kv = new Map<string, KvValue>([[AUDIO_BASE, JSON.stringify({ mimeType: "audio/mp4", base64: "AAECAw==" })]]);
    const { tcw } = fakeSpace({ kv });
    expect(await loadVoiceNoteAudio(tcw, "rec-1")).toEqual({ ok: true, data: { mimeType: "audio/mp4", base64: "AAECAw==" } });
    const blob = await loadVoiceNoteAudioBlob(tcw, "rec-1");
    expect(blob.ok && blob.data.type).toBe("audio/mp4");
    expect(blob.ok && new Uint8Array(await blob.data.arrayBuffer())).toEqual(new Uint8Array([0, 1, 2, 3]));
  });

  test("an interrupted save (parts, no manifest) reads as no audio, not as a short file", async () => {
    const space = fakeSpace();
    space.failPut((key) => (key.endsWith("/manifest") ? { code: "KV_ERROR", message: "boom" } : null));
    await putVoiceNoteAudio(space.tcw, "rec-1", trackedSource(audioBytes(1_500)).source, { partSize: 1_000, ...noWait });
    const res = await loadVoiceNoteAudioBlob(space.tcw, "rec-1");
    expect(res).toEqual({ ok: false, error: expect.objectContaining({ code: "KV_NOT_FOUND" }) });
  });

  test("a note over maxBytes is refused from its manifest, before any part is read", async () => {
    const space = await stored(audioBytes(2_345));
    const res = await loadVoiceNoteAudio(space.tcw, "rec-1", { maxBytes: 2_000 });
    expect(res).toEqual({ ok: false, error: expect.objectContaining({ code: VOICE_NOTE_AUDIO_TOO_LARGE }) });
    expect(space.calls.filter((c) => c.kind === "kv.get" && c.target.includes("/p/"))).toEqual([]);
  });

  test("a part that disagrees with the manifest fails closed", async () => {
    const space = await stored(audioBytes(2_345));
    space.kv.set(`${AUDIO_BASE}/p/000001`, new Uint8Array(999));
    expect(await loadVoiceNoteAudioBlob(space.tcw, "rec-1")).toEqual({ ok: false, error: expect.objectContaining({ code: "STORE_CORRUPT_AUDIO" }) });
  });

  test("malformed audio fails closed", async () => {
    const legacy = fakeSpace({ kv: new Map([[AUDIO_BASE, JSON.stringify({ base64: 42 })]]) });
    expect((await loadVoiceNoteAudio(legacy.tcw, "rec-1")).ok).toBe(false);
    const manifest = fakeSpace({ kv: new Map([[`${AUDIO_BASE}/manifest`, JSON.stringify({ v: 1, mimeType: "audio/mp4", size: 5, parts: [{ size: 4, etag: null }] })]]) });
    expect(await loadVoiceNoteAudioBlob(manifest.tcw, "rec-1")).toEqual({ ok: false, error: expect.objectContaining({ code: "STORE_CORRUPT_AUDIO" }) });
  });
});
