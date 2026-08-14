import { describe, expect, it } from "bun:test";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { CONNECTORS_SQL_DB_NAME, transcriptKvKey } from "./connectorStore.js";
import type { FirefliesSentence } from "./firefliesClient.js";
import {
  listMeetings,
  readTranscriptSentences,
  transcriptCopyText,
} from "./meetingExplorer.js";

type SqlResult =
  | { ok: true; data: { rows: unknown[][] } }
  | { ok: true; data: Record<string, never> }
  | { ok: false; error: { code: string; message: string } };

type KvResult =
  | { ok: true; data: { data: unknown; headers: Record<string, string> } }
  | { ok: false; error: { code: string; message: string } };

interface SqlCall {
  db: string;
  sql: string;
  params: unknown[];
}

/** Minimal tcw stand-in: records what the explorer asked for, returns canned results. */
function fakeTcw(opts: { sql?: SqlResult; kv?: KvResult }) {
  const sqlCalls: SqlCall[] = [];
  const kvKeys: string[] = [];
  const tcw = {
    sql: {
      db(name: string) {
        return {
          async query(sql: string, params: unknown[] = []): Promise<SqlResult> {
            sqlCalls.push({ db: name, sql, params });
            return (
              opts.sql ?? { ok: true as const, data: { rows: [] as unknown[][] } }
            );
          },
        };
      },
    },
    kv: {
      async get(key: string): Promise<KvResult> {
        kvKeys.push(key);
        return (
          opts.kv ?? { ok: false as const, error: { code: "KV_NOT_FOUND", message: "no key" } }
        );
      },
    },
  };
  return { tcw: tcw as unknown as TinyCloudWeb, sqlCalls, kvKeys };
}

/**
 * A tcw whose storage surface throws instead of returning a Result — the
 * transport failing under the Result layer (SDK rejection, torn-down session).
 * `sync` throws from `sql.db()` itself, before any promise exists.
 */
function throwingTcw(mode: "async" | "sync" = "async") {
  const boom = () => {
    throw new Error("transport down");
  };
  return {
    sql: {
      db(_name: string) {
        if (mode === "sync") boom();
        return {
          query: async (): Promise<SqlResult> => boom(),
        };
      },
    },
    kv: {
      get: async (): Promise<KvResult> => boom(),
    },
  } as unknown as TinyCloudWeb;
}

function sentence(over: Partial<FirefliesSentence>): FirefliesSentence {
  return {
    index: 0,
    speaker_name: null,
    text: "hello",
    start_time: 0,
    end_time: 1,
    ...over,
  };
}

describe("listMeetings", () => {
  it("maps positional rows to MeetingListItem", async () => {
    const { tcw } = fakeTcw({
      sql: {
        ok: true,
        data: {
          rows: [
            ["row-1", "src-1", "Standup", "2026-08-01T10:00:00.000Z"],
            ["row-2", "src-2", "Retro", "2026-07-30T10:00:00.000Z"],
          ],
        },
      },
    });
    expect(await listMeetings(tcw)).toEqual([
      {
        id: "row-1",
        sourceId: "src-1",
        title: "Standup",
        startedAt: "2026-08-01T10:00:00.000Z",
      },
      {
        id: "row-2",
        sourceId: "src-2",
        title: "Retro",
        startedAt: "2026-07-30T10:00:00.000Z",
      },
    ]);
  });

  it("queries the fully-resolved connectors db and passes the source param", async () => {
    const { tcw, sqlCalls } = fakeTcw({ sql: { ok: true, data: { rows: [] } } });
    await listMeetings(tcw, "otter");
    expect(sqlCalls).toHaveLength(1);
    expect(sqlCalls[0].db).toBe(CONNECTORS_SQL_DB_NAME);
    expect(sqlCalls[0].params).toEqual(["otter"]);
    expect(sqlCalls[0].sql).toContain("FROM connector_meeting");
    expect(sqlCalls[0].sql).toContain("ORDER BY started_at DESC");
  });

  it("defaults the source to fireflies", async () => {
    const { tcw, sqlCalls } = fakeTcw({ sql: { ok: true, data: { rows: [] } } });
    await listMeetings(tcw);
    expect(sqlCalls[0].params).toEqual(["fireflies"]);
  });

  it("returns [] when the query fails (not connected / missing table)", async () => {
    const { tcw } = fakeTcw({
      sql: { ok: false, error: { code: "STORE_ERROR", message: "no such table: connector_meeting" } },
    });
    expect(await listMeetings(tcw)).toEqual([]);
  });

  it("returns [] when rows is undefined", async () => {
    const { tcw } = fakeTcw({ sql: { ok: true, data: {} } });
    expect(await listMeetings(tcw)).toEqual([]);
  });

  it("maps non-string title / started_at cells to null", async () => {
    const { tcw } = fakeTcw({
      sql: { ok: true, data: { rows: [["row-1", "src-1", null, 1723600000]] } },
    });
    expect(await listMeetings(tcw)).toEqual([
      { id: "row-1", sourceId: "src-1", title: null, startedAt: null },
    ]);
  });

  it("skips rows with a falsy id or source_id", async () => {
    const { tcw } = fakeTcw({
      sql: {
        ok: true,
        data: {
          rows: [
            ["", "src-1", "No id", null],
            [null, "src-2", "Null id", null],
            ["row-3", "", "No source id", null],
            ["row-4", null, "Null source id", null],
            ["row-5", "src-5", "Keeper", null],
          ],
        },
      },
    });
    expect(await listMeetings(tcw)).toEqual([
      { id: "row-5", sourceId: "src-5", title: "Keeper", startedAt: null },
    ]);
  });

  it("never throws on a rejected-shaped error result", async () => {
    const { tcw } = fakeTcw({
      sql: { ok: false, error: { code: "AUTH_UNAUTHORIZED", message: "unauthorized" } },
    });
    await expect(listMeetings(tcw)).resolves.toEqual([]);
  });

  it("returns [] when the query rejects instead of returning a Result", async () => {
    await expect(listMeetings(throwingTcw())).resolves.toEqual([]);
  });

  it("returns [] when resolving the db throws synchronously", async () => {
    await expect(listMeetings(throwingTcw("sync"))).resolves.toEqual([]);
  });
});

describe("readTranscriptSentences", () => {
  const stored = [
    sentence({ index: 0, speaker_name: "Ada", text: "Morning." }),
    sentence({ index: 1, speaker_name: null, text: "Morning back." }),
  ];

  it("parses a JSON-stringified payload", async () => {
    const { tcw } = fakeTcw({
      kv: { ok: true, data: { data: JSON.stringify(stored), headers: {} } },
    });
    expect(await readTranscriptSentences(tcw, "src-1")).toEqual(stored);
  });

  it("accepts an already-parsed array payload", async () => {
    const { tcw } = fakeTcw({ kv: { ok: true, data: { data: stored, headers: {} } } });
    expect(await readTranscriptSentences(tcw, "src-1")).toEqual(stored);
  });

  it("reads the prefixed transcript key for the source", async () => {
    const { tcw, kvKeys } = fakeTcw({
      kv: { ok: true, data: { data: JSON.stringify([]), headers: {} } },
    });
    await readTranscriptSentences(tcw, "src-9", "otter");
    expect(kvKeys).toEqual([transcriptKvKey("otter", "src-9")]);
  });

  it("defaults the source to fireflies", async () => {
    const { tcw, kvKeys } = fakeTcw({
      kv: { ok: true, data: { data: JSON.stringify([]), headers: {} } },
    });
    await readTranscriptSentences(tcw, "src-9");
    expect(kvKeys).toEqual([transcriptKvKey("fireflies", "src-9")]);
  });

  it("returns null on malformed JSON", async () => {
    const { tcw } = fakeTcw({ kv: { ok: true, data: { data: "{not json", headers: {} } } });
    expect(await readTranscriptSentences(tcw, "src-1")).toBeNull();
  });

  it("returns null when the read fails", async () => {
    const { tcw } = fakeTcw({
      kv: { ok: false, error: { code: "KV_NOT_FOUND", message: "no key" } },
    });
    expect(await readTranscriptSentences(tcw, "src-1")).toBeNull();
  });

  it("returns null when the read rejects instead of returning a Result", async () => {
    await expect(readTranscriptSentences(throwingTcw(), "src-1")).resolves.toBeNull();
  });

  it("returns null when the payload is not an array", async () => {
    const { tcw } = fakeTcw({
      kv: { ok: true, data: { data: { sentences: [] }, headers: {} } },
    });
    expect(await readTranscriptSentences(tcw, "src-1")).toBeNull();
  });

  it("filters out entries without a string text", async () => {
    const { tcw } = fakeTcw({
      kv: {
        ok: true,
        data: {
          data: JSON.stringify([
            { index: 0, speaker_name: "Ada", text: "kept" },
            { index: 1, speaker_name: "Ada" },
            { index: 2, speaker_name: "Ada", text: 42 },
            null,
            "not an object",
          ]),
          headers: {},
        },
      },
    });
    expect(await readTranscriptSentences(tcw, "src-1")).toEqual([
      { index: 0, speaker_name: "Ada", text: "kept" } as FirefliesSentence,
    ]);
  });
});

describe("transcriptCopyText", () => {
  it("attributes each line to its speaker", () => {
    expect(
      transcriptCopyText([
        sentence({ speaker_name: "Ada", text: "Morning." }),
        sentence({ speaker_name: "Grace", text: "Morning back." }),
      ]),
    ).toBe("Ada: Morning.\nGrace: Morning back.");
  });

  it("emits a bare line when the speaker is unknown", () => {
    expect(transcriptCopyText([sentence({ speaker_name: null, text: "Anon line." })])).toBe(
      "Anon line.",
    );
  });

  it("joins lines with a single newline", () => {
    const out = transcriptCopyText([
      sentence({ speaker_name: null, text: "a" }),
      sentence({ speaker_name: null, text: "b" }),
      sentence({ speaker_name: "C", text: "c" }),
    ]);
    expect(out).toBe("a\nb\nC: c");
    expect(out.split("\n")).toHaveLength(3);
  });

  it("returns an empty string for an empty transcript", () => {
    expect(transcriptCopyText([])).toBe("");
  });
});
