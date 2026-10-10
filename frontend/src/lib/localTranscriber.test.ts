import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
  createLocalTranscriptSaver,
  normalizeLocalTranscript,
  LOCAL_MEETING_SOURCE,
  LOCAL_WHISPER_MODELS,
  NO_SPEECH_MESSAGE,
  prepareLocalTranscript,
  saveLocalTranscript,
  type LocalTranscriptResult,
} from "./localTranscriber";
import { transcriptKvKey } from "./connectors/connectorStore";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function batchResponse(words: { word: string; start: number; end: number; channel?: number; punctuated_word?: string }[]) {
  return {
    metadata: {},
    results: {
      channels: [{ alternatives: [{ transcript: "", confidence: 1, words }] }],
    },
  };
}

function resultWith(words: Parameters<typeof batchResponse>[0]): LocalTranscriptResult {
  return {
    sessionId: "sess-1",
    startedAt: "2026-09-28T18:00:00.000Z",
    model: "QuantizedTinyEn",
    language: "en",
    response: batchResponse(words) as never,
  };
}

describe("normalizeLocalTranscript", () => {
  test("groups words into You (mic) / Others (system audio) turns, merging a speaker's consecutive segments", () => {
    const { meeting, sentences } = normalizeLocalTranscript(
      resultWith([
        { word: "hello", punctuated_word: "Hello", start: 0.0, end: 0.4, channel: 0 },
        { word: "there", punctuated_word: "there.", start: 0.5, end: 0.9, channel: 0 },
        // 2.6 s gap: a new segment, but the same speaker's turn continues
        { word: "again", start: 3.5, end: 3.9, channel: 0 },
        // the other channel: a new turn
        { word: "hi", punctuated_word: "Hi", start: 4.0, end: 4.2, channel: 1 },
        { word: "back", punctuated_word: "back.", start: 4.3, end: 4.6, channel: 1 },
      ]),
    );

    expect(meeting.source).toBe(LOCAL_MEETING_SOURCE);
    expect(meeting.sourceId).toBe("local:sess-1");
    expect(meeting.title).toContain("Local recording");
    expect(meeting.startedAt).toBe("2026-09-28T18:00:00.000Z");
    expect(meeting.durationSecs).toBe(5);
    expect(meeting.metadata.capture).toBe("local");
    expect(meeting.metadata.transcript_provider).toBe("whispercpp");
    expect(meeting.metadata.model).toBe("QuantizedTinyEn");
    expect(Object.keys(meeting.metadata).join(",")).not.toContain("audio_path");

    expect(meeting.metadata.speaker_labels).toBe("channel-you-others");

    expect(sentences).toHaveLength(2);
    expect(sentences[0]).toMatchObject({
      index: 0,
      speaker_name: "You",
      text: "Hello there. again",
      start_time: 0,
      end_time: 3.9,
    });
    expect(sentences[1]).toMatchObject({
      index: 1,
      speaker_name: "Others",
      text: "Hi back.",
      start_time: 4.0,
      end_time: 4.6,
    });
    // participants carry the distinct speaker labels
    expect(meeting.participants.map((p) => p.name)).toEqual(["You", "Others"]);
  });

  test("drops mic echo of system audio from a two-channel whisper response", () => {
    // Real whisper-local output: one results channel per audio channel, each
    // word tagged with its channel and spread evenly across its VAD chunk.
    const spread = (channel: number, start: number, end: number, text: string) => {
      const parts = text.split(" ");
      const step = (end - start) / parts.length;
      return parts.map((word, i) => ({ word, start: start + i * step, end: start + (i + 1) * step, channel }));
    };
    const remote = ["Ship the release on Thursday.", "Blue kites fly over the harbor."];
    const { meeting, sentences } = normalizeLocalTranscript({
      ...resultWith([]),
      response: {
        metadata: {},
        results: {
          channels: [
            { alternatives: [{ transcript: "", confidence: 1, words: [
              ...spread(0, 0, 2, "Can everyone hear me?"),
              ...spread(0, 3.2, 6.1, remote[0]!),
              ...spread(0, 7.2, 10.1, remote[1]!),
            ] }] },
            { alternatives: [{ transcript: "", confidence: 1, words: [
              ...spread(1, 3, 6, remote[0]!),
              ...spread(1, 7, 10, remote[1]!),
            ] }] },
          ],
        },
      } as never,
    });

    expect(sentences.map((s) => `${s.speaker_name}: ${s.text}`)).toEqual([
      "You: Can everyone hear me?",
      `Others: ${remote.join(" ")}`,
    ]);
    expect(meeting.metadata.transcript_text).toBe(`Can everyone hear me?\n${remote.join(" ")}`);
    expect(meeting.participants.map((p) => p.name)).toEqual(["You", "Others"]);
  });

  test("duration is the latest turn end, not the last turn's end", () => {
    const { meeting, sentences } = normalizeLocalTranscript(
      resultWith([
        // A long mic turn that starts first and ends last…
        { word: "one", start: 0, end: 10, channel: 0 },
        { word: "two", start: 10, end: 30, channel: 0 },
        // …and a short system-audio turn inside it, ordered after it.
        { word: "hi", start: 5, end: 6, channel: 1 },
      ]),
    );
    expect(sentences.map((s) => s.speaker_name)).toEqual(["You", "Others"]);
    expect(meeting.durationSecs).toBe(30);
  });

  test("falls back to whole-channel transcript when words have no timings", () => {
    const { sentences } = normalizeLocalTranscript({
      sessionId: "s2",
      startedAt: "2026-09-28T18:00:00.000Z",
      model: "QuantizedTinyEn",
      language: "en",
      response: {
        metadata: {},
        results: {
          channels: [
            { alternatives: [{ transcript: "  full sentence without words.  ", confidence: 1 }] },
          ],
        },
      } as never,
    });
    expect(sentences).toHaveLength(1);
    expect(sentences[0]).toMatchObject({ speaker_name: "You", text: "full sentence without words." });
  });

  test("empty response yields an empty sentence list and no duration", () => {
    const { meeting, sentences } = normalizeLocalTranscript(resultWith([]));
    expect(sentences).toHaveLength(0);
    expect(meeting.durationSecs).toBeNull();
  });
});

/** Connector store backed by real SQLite plus an in-memory KV whose next puts can be failed. */
function sqliteStore() {
  const sqlite = new Database(":memory:");
  const kv = new Map<string, string>();
  let failingKvPuts = 0;
  const tcw = {
    did: `did:test:${crypto.randomUUID()}`,
    sql: {
      db: () => ({
        query: async (sql: string, params: unknown[] = []) => {
          try {
            return { ok: true, data: { rows: sqlite.query(sql).values(...(params as never[])) } };
          } catch (error) {
            return { ok: false, error: { code: "SQL", message: String(error) } };
          }
        },
        execute: async (sql: string, params: unknown[] = []) => {
          try {
            sqlite.query(sql).run(...(params as never[]));
            return { ok: true, data: { rows: [] } };
          } catch (error) {
            return { ok: false, error: { code: "SQL", message: String(error) } };
          }
        },
      }),
    },
    kv: {
      put: async (key: string, value: string) => {
        if (failingKvPuts > 0) {
          failingKvPuts--;
          return { ok: false, error: { code: "KV_UNAVAILABLE", message: "kv write failed" } };
        }
        kv.set(key, value);
        return { ok: true, data: null };
      },
    },
  } as never;
  return { tcw, sqlite, kv, failNextKvPut: () => { failingKvPuts++; } };
}

describe("prepareLocalTranscript", () => {
  test("refuses a transcript with no speech so silence is never saved as a meeting", () => {
    expect(() => prepareLocalTranscript(resultWith([]))).toThrow(NO_SPEECH_MESSAGE);
    expect(NO_SPEECH_MESSAGE).toBe("No speech was transcribed — nothing was saved.");
    expect(prepareLocalTranscript(resultWith([{ word: "hi", start: 0, end: 1, channel: 0 }])).sentences).toHaveLength(1);
  });
});

describe("LOCAL_WHISPER_MODELS", () => {
  test("sizes match anarlog's model_size_bytes in decimal MB", () => {
    const bytes: Record<string, number> = {
      QuantizedTiny: 43537433,
      QuantizedTinyEn: 43550795,
      QuantizedBase: 81768585,
      QuantizedBaseEn: 81781811,
      QuantizedSmall: 264464607,
      QuantizedSmallEn: 264477561,
      QuantizedLargeTurbo: 874188075,
    };
    for (const m of LOCAL_WHISPER_MODELS) {
      expect(m.approxSizeMb).toBe(Math.round(bytes[m.id]! / 1_000_000));
    }
  });
});

describe("saveLocalTranscript", () => {
  test("a retry of the identical prepared transcript repairs a failed KV write with one meeting", async () => {
    const store = sqliteStore();
    const prepared = prepareLocalTranscript(resultWith([{ word: "hello", start: 0, end: 1, channel: 0 }]));

    store.failNextKvPut();
    const first = await saveLocalTranscript(store.tcw, prepared);
    expect(first.ok).toBe(false);
    // The partial write: the row landed, the transcript body did not.
    expect(store.sqlite.query("SELECT COUNT(*) FROM connector_meeting").values()[0]![0]).toBe(1);
    expect(store.kv.size).toBe(0);

    const retry = await saveLocalTranscript(store.tcw, prepared);
    expect(retry).toEqual({ ok: true, data: expect.objectContaining({ id: prepared.meeting.id, inserted: false }) });
    const rows = store.sqlite.query("SELECT id, source, source_id FROM connector_meeting").values();
    expect(rows).toEqual([[prepared.meeting.id, LOCAL_MEETING_SOURCE, "local:sess-1"]]);
    expect(JSON.parse(store.kv.get(transcriptKvKey(LOCAL_MEETING_SOURCE, "local:sess-1"))!)).toEqual(prepared.sentences);
  });

  test("delegates to upsertMeeting with the prepared meeting and sentences", async () => {
    // upsertMeeting is module-bound; drive the real store contract with a tcw
    // fake that captures the SQL INSERT row and KV put.
    const writes: { sql: string; params: unknown[] }[] = [];
    const kvPuts: string[] = [];
    const tcw = {
      sql: {
        db: () => ({
          query: async (sql: string, params: unknown[] = []) => {
            writes.push({ sql, params });
            if (sql.startsWith("SELECT source_id")) return { ok: true, data: { rows: [] } };
            if (sql.startsWith("SELECT id, created_at")) return { ok: true, data: { rows: [] } };
            return { ok: true, data: { rows: [] } };
          },
          execute: async (sql: string, params: unknown[] = []) => {
            writes.push({ sql, params });
            return { ok: true, data: { rows: [] } };
          },
        }),
      },
      kv: {
        put: async (key: string) => {
          kvPuts.push(key);
          return { ok: true, data: null };
        },
      },
    } as never;

    const r = await saveLocalTranscript(tcw, prepareLocalTranscript(resultWith([{ word: "hi", start: 0, end: 1, channel: 0 }])));
    expect(r.ok).toBe(true);
    const insert = writes.find((w) => w.sql.startsWith("INSERT INTO connector_meeting"));
    expect(insert).toBeTruthy();
    expect(insert!.params[1]).toBe(LOCAL_MEETING_SOURCE);
    expect(insert!.params[2]).toBe("local:sess-1");
    expect(kvPuts.some((k) => k.includes("exo-local/transcript/local:sess-1"))).toBe(true);
  });

  test("a timed-out save keeps the transcript; its retry waits for the first write instead of writing beside it", async () => {
    const prepared = prepareLocalTranscript(resultWith([{ word: "hello", start: 0, end: 1, channel: 0 }]));
    let calls = 0;
    let writing = 0;
    let maxWriting = 0;
    let finishFirst!: () => void;
    const saved = { ok: true as const, data: { id: prepared.meeting.id, inserted: true, createdAt: "2026-09-28T18:00:00.000Z" } };
    const save = async (_tcw: unknown, p: typeof prepared) => {
      expect(p).toBe(prepared);
      calls++;
      writing++;
      maxWriting = Math.max(maxWriting, writing);
      try {
        if (calls === 1) await new Promise<void>((resolve) => { finishFirst = resolve; });
        return saved;
      } finally {
        writing--;
      }
    };
    const saveTranscript = createLocalTranscriptSaver({} as never, { timeoutMs: 50, save: save as never });

    await expect(saveTranscript(prepared)).rejects.toThrow("Timed out waiting for TinyCloud to save the transcript");
    const retry = saveTranscript(prepared);
    // A concurrent second retry is refused rather than queued beside it.
    await expect(saveTranscript(prepared)).rejects.toThrow("already being saved");
    await tick();
    expect(calls).toBe(1);
    finishFirst();
    await expect(retry).resolves.toEqual(saved);
    expect(calls).toBe(2);
    expect(maxWriting).toBe(1);
  });

  test("a retry while the timed-out save is still writing is itself bounded and writes nothing", async () => {
    const prepared = prepareLocalTranscript(resultWith([{ word: "hello", start: 0, end: 1, channel: 0 }]));
    let calls = 0;
    const save = () => {
      calls++;
      return new Promise<never>(() => {});
    };
    const saveTranscript = createLocalTranscriptSaver({} as never, { timeoutMs: 20, save: save as never });
    await expect(saveTranscript(prepared)).rejects.toThrow("Timed out waiting for TinyCloud to save the transcript");
    await expect(saveTranscript(prepared)).rejects.toThrow("Timed out waiting for the previous save to finish");
    expect(calls).toBe(1);
  });
});
