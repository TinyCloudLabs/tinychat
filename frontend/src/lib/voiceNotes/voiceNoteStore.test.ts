// Voice notes persistence. Rules:
//   1. audio is written to KV under the granted connectors/ prefix BEFORE the row exists, so a
//      listed note always has audio behind it; a failed audio write writes no row;
//   2. the row is a connector_meeting with source "exo-voice-note" and the OS capture evidence;
//   3. stored audio round-trips and malformed audio fails closed.

import { beforeEach, describe, expect, test } from "bun:test";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { _resetConnectorSchemaMemoForTests } from "../connectors/connectorStore";
import { APP_ID } from "../threadStore";
import {
  VOICE_NOTE_SOURCE,
  listVoiceNotes,
  loadVoiceNoteAudio,
  saveVoiceNote,
  voiceNoteAudioKvKey,
} from "./voiceNoteStore";
import type { VoiceNoteRecording } from "./nativeVoiceNotes";

type Call = { kind: "sql.execute" | "sql.query" | "kv.put" | "kv.get"; target: string; params?: unknown[]; value?: string };

function fakeTcw(opts: { kvPutOk?: boolean; kvGet?: unknown; rows?: unknown[][] } = {}) {
  const calls: Call[] = [];
  const tcw = {
    did: "did:pkh:eip155:1:0xabc",
    sql: {
      db(name: string) {
        return {
          async execute(sql: string, params: unknown[] = []) {
            calls.push({ kind: "sql.execute", target: name, params: [sql, ...params] });
            return { ok: true, data: {} };
          },
          async query(sql: string, params: unknown[] = []) {
            calls.push({ kind: "sql.query", target: name, params: [sql, ...params] });
            return { ok: true, data: { rows: sql.includes("SELECT id, source_id") ? opts.rows ?? [] : [] } };
          },
        };
      },
    },
    kv: {
      async put(key: string, value: string) {
        calls.push({ kind: "kv.put", target: key, value });
        return opts.kvPutOk === false ? { ok: false, error: { code: "KV_ERROR", message: "boom" } } : { ok: true, data: {} };
      },
      async get(key: string) {
        calls.push({ kind: "kv.get", target: key });
        return { ok: true, data: { data: opts.kvGet } };
      },
    },
  };
  return { tcw: tcw as unknown as TinyCloudWeb, calls };
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

beforeEach(() => _resetConnectorSchemaMemoForTests());

describe("saveVoiceNote", () => {
  test("writes audio under the granted connectors prefix, then the meeting row", async () => {
    const { tcw, calls } = fakeTcw();
    const res = await saveVoiceNote(tcw, recording, { mimeType: "audio/mp4", base64: "AAAA" }, "android");
    expect(res.ok).toBe(true);

    const audioKey = `${APP_ID}/connectors/exo-voice-note/audio/rec-1`;
    expect(voiceNoteAudioKvKey("rec-1")).toBe(audioKey);
    expect(calls[0]).toEqual({ kind: "kv.put", target: audioKey, value: JSON.stringify({ mimeType: "audio/mp4", base64: "AAAA" }) });

    const insert = calls.find((c) => c.kind === "sql.execute" && String(c.params?.[0]).includes("INSERT INTO connector_meeting"));
    expect(insert).toBeDefined();
    expect(insert!.params).toContain(VOICE_NOTE_SOURCE);
    expect(insert!.params).toContain("rec-1");
    const metadata = JSON.parse(String(insert!.params!.find((p) => typeof p === "string" && p.includes("audio_kv_key"))));
    expect(metadata.audio_kv_key).toBe(audioKey);
    expect(metadata.capture).toEqual({
      platform: "android",
      duration_ms: 12_400,
      silenced_ms: 1_500,
      silenced_events: 1,
      no_signal_ms: 0,
    });
  });

  test("a failed audio write writes no row", async () => {
    const { tcw, calls } = fakeTcw({ kvPutOk: false });
    const res = await saveVoiceNote(tcw, recording, { mimeType: "audio/mp4", base64: "AAAA" }, "android");
    expect(res.ok).toBe(false);
    expect(calls.filter((c) => c.kind.startsWith("sql"))).toEqual([]);
  });
});

describe("listVoiceNotes", () => {
  test("maps rows newest first for this source only", async () => {
    const { tcw, calls } = fakeTcw({ rows: [["row-1", "rec-1", "Voice note", "2026-09-29T05:40:00.000Z", 12]] });
    const res = await listVoiceNotes(tcw);
    expect(res).toEqual({
      ok: true,
      data: [{ id: "row-1", sourceId: "rec-1", title: "Voice note", startedAt: "2026-09-29T05:40:00.000Z", durationSecs: 12 }],
    });
    const list = calls.find((c) => c.kind === "sql.query" && String(c.params?.[0]).includes("SELECT id, source_id"));
    expect(list!.params).toContain(VOICE_NOTE_SOURCE);
  });
});

describe("listVoiceNotes dedup", () => {
  test("one note per recording id even if a racing save wrote two rows", async () => {
    const { tcw } = fakeTcw({
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

describe("loadVoiceNoteAudio", () => {
  test("round-trips the stored JSON", async () => {
    const { tcw } = fakeTcw({ kvGet: JSON.stringify({ mimeType: "audio/mp4", base64: "AAAA" }) });
    expect(await loadVoiceNoteAudio(tcw, "rec-1")).toEqual({ ok: true, data: { mimeType: "audio/mp4", base64: "AAAA" } });
  });

  test("malformed audio fails closed", async () => {
    const { tcw } = fakeTcw({ kvGet: JSON.stringify({ base64: 42 }) });
    const res = await loadVoiceNoteAudio(tcw, "rec-1");
    expect(res.ok).toBe(false);
  });
});
