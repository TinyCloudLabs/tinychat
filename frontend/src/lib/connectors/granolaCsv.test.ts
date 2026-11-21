import { describe, expect, test } from "bun:test";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import type { TranscriptSentence } from "@tinyboilerplate/core";

import {
  granolaCsvDedupeKey,
  granolaCsvSourceId,
  parseGranolaAttendees,
  parseGranolaCsv,
  tokenizeCsv,
  type GranolaCsvRow,
} from "./granolaCsv";
import { importGranolaCsv, type GranolaCsvImportStore } from "./granolaCsvImport";
import type { NormalizedMeeting, StoreResult, UpsertMeetingOutcome } from "./connectorStore";

// Synthetic fixtures: Granola documents no column list, so these use the aliases the parser accepts.
const tcw = {} as TinyCloudWeb;
const HEADER = "Title,Created,Attendees,Summary,Transcript";
const ROW_A = 'Weekly planning,2026-11-10T14:00:00Z,"Ada Owner <ada@example.com>; bob@example.com","Agreed the roadmap.","Ada: hello\nBob: hi"';
const ROW_B = 'Design review,2026-11-11T09:30:00Z,carol@example.com,"Reviewed mocks.",';

function csv(...lines: string[]): string {
  return lines.join("\n");
}

function parsed(text: string): GranolaCsvRow[] {
  const result = parseGranolaCsv(text);
  if (!result.ok) throw new Error(`parse failed: ${result.error.code}`);
  return result.data.rows;
}

class MemoryStore implements GranolaCsvImportStore {
  readonly rows = new Map<string, { meeting: NormalizedMeeting; sentences: TranscriptSentence[] }>();
  writes = 0;
  async ensureSchema(): Promise<StoreResult<void>> {
    return { ok: true, data: undefined };
  }
  async upsertMeeting(_tcw: TinyCloudWeb, meeting: NormalizedMeeting, sentences: TranscriptSentence[]): Promise<StoreResult<UpsertMeetingOutcome>> {
    this.writes++;
    const existing = this.rows.get(meeting.sourceId);
    this.rows.set(meeting.sourceId, { meeting, sentences });
    return { ok: true, data: { id: meeting.id, inserted: existing === undefined, createdAt: "2026-11-19T00:00:00Z" } };
  }
}

/** The owner's ledger as the backend answers it: ids deleted before the watermark are blocked. */
class FakeLedger {
  deleted = new Set<string>();
  checks: string[] = [];
  check = async (meetingId: string): Promise<boolean> => {
    this.checks.push(meetingId);
    return this.deleted.has(meetingId);
  };
  allowBack(): void {
    this.deleted.clear();
  }
}

const neverBlocked = async () => false;

describe("parse", () => {
  test("reads headers regardless of case, spacing, punctuation and order", () => {
    const rows = parsed(csv(
      "  SUMMARY ,transcript, Meeting-Title ,Start_Time,People",
      "S1,T1,Standup,2026-11-10T14:00:00Z,a@example.com",
    ));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      title: "Standup",
      summary: "S1",
      transcript: "T1",
      startedAt: "2026-11-10T14:00:00.000Z",
      attendees: [{ name: "a@example.com", email: "a@example.com" }],
    });
  });

  test("column order does not change the result", () => {
    const a = parsed(csv("Title,Created,Summary", "Sync,2026-11-10T14:00:00Z,Notes"));
    const b = parsed(csv("Summary,Title,Created", "Notes,Sync,2026-11-10T14:00:00Z"));
    expect(b).toEqual(a);
  });

  test("strips a byte order mark and accepts CRLF, LF and a lone CR", () => {
    const body = ["Title,Summary", "One,First", "Two,Second"];
    const expected = parsed(body.join("\n")).map((r) => r.title);
    expect(expected).toEqual(["One", "Two"]);
    expect(parsed(`\uFEFF${body.join("\r\n")}\r\n`).map((r) => r.title)).toEqual(expected);
    expect(parsed(body.join("\r")).map((r) => r.title)).toEqual(expected);
  });

  test("a quoted cell keeps its line breaks, commas and doubled quotes", () => {
    const text = 'Title,Summary,Transcript\r\n"Sync, weekly","Line one\r\nLine two with ""quotes""","Ada: hi\nBob: yes"\r\n';
    const [row] = parsed(text);
    expect(row!.title).toBe("Sync, weekly");
    expect(row!.summary).toBe('Line one\r\nLine two with "quotes"');
    expect(row!.transcript).toBe("Ada: hi\nBob: yes");
  });

  test("a multiline transcript becomes one sentence per line with speakers", async () => {
    const store = new MemoryStore();
    const result = await importGranolaCsv({ tcw, store, text: csv(HEADER, ROW_A), checkPurge: neverBlocked });
    expect(result.ok).toBe(true);
    const [{ sentences, meeting }] = [...store.rows.values()] as [{ sentences: TranscriptSentence[]; meeting: NormalizedMeeting }];
    expect(sentences.map((s) => [s.speaker_name, s.text])).toEqual([["Ada", "hello"], ["Bob", "hi"]]);
    expect(meeting.participants).toEqual([
      { name: "Ada Owner", email: "ada@example.com" },
      { name: "bob@example.com", email: "bob@example.com" },
    ]);
    expect(meeting.source).toBe("granola");
  });

  test("rejects malformed files with a code and imports nothing", async () => {
    const cases: [string, string][] = [
      ["", "empty"],
      ['Title,Summary\n"never closed,Body', "unterminated-quote"],
      ['Title,Summary\n"Done"junk,Body', "stray-quote"],
      ["Colour,Size\nred,big", "no-known-columns"],
      ["Title,Summary\nA,B,surplus", "ragged-row"],
    ];
    for (const [text, code] of cases) {
      const store = new MemoryStore();
      const result = await importGranolaCsv({ tcw, store, text, checkPurge: neverBlocked });
      expect(result).toMatchObject({ ok: false, error: { kind: "malformed", csv: { code } } });
      expect(store.writes).toBe(0);
    }
  });

  test("a bad row late in the file stops everything before any write", async () => {
    const store = new MemoryStore();
    const result = await importGranolaCsv({ tcw, store, text: csv(HEADER, ROW_A, "Broken,2026-11-10,\"open"), checkPurge: neverBlocked });
    expect(result.ok).toBe(false);
    expect(store.writes).toBe(0);
  });

  test("a short row is padded; rows with no title, summary or transcript are counted as blank", () => {
    const result = parseGranolaCsv(csv("Title,Summary,Transcript", "Only a title", ",,", "Has notes,Some notes,"));
    expect(result.ok && result.data.rows.map((r) => r.title)).toEqual(["Only a title", "Has notes"]);
    expect(result.ok && result.data.blank).toBe(1);
  });

  test("attendees read from JSON, semicolons, lines or commas", () => {
    expect(parseGranolaAttendees('[{"name":"Ada","email":"ada@example.com"},"bob@example.com"]')).toEqual([
      { name: "Ada", email: "ada@example.com" },
      { name: "bob@example.com", email: "bob@example.com" },
    ]);
    expect(parseGranolaAttendees("Smith, Ada <ada@example.com>; Bo")).toEqual([
      { name: "Smith, Ada", email: "ada@example.com" },
      { name: "Bo", email: null },
    ]);
    expect(parseGranolaAttendees("a@example.com, b@example.com").map((p) => p.email)).toEqual(["a@example.com", "b@example.com"]);
  });

  test("tokenizer treats a quote inside an unquoted cell as text", () => {
    expect(tokenizeCsv('a,5" pipe,c')).toEqual({ ok: true, records: [["a", '5" pipe', "c"]] });
  });
});

describe("identity", () => {
  test("never merges two meetings on the title alone", async () => {
    const [a, b, c] = parsed(csv(
      "Title,Created,Attendees,Summary",
      "Standup,2026-11-10T09:00:00Z,ada@example.com,x",
      "Standup,2026-11-11T09:00:00Z,ada@example.com,x",
      "Standup,2026-11-10T09:00:00Z,bob@example.com,x",
    )) as [GranolaCsvRow, GranolaCsvRow, GranolaCsvRow];
    const keys = await Promise.all([a, b, c].map(granolaCsvDedupeKey));
    expect(new Set(keys).size).toBe(3);
  });

  test("a title with no time or attendees is told apart by its text", async () => {
    const [a, b] = parsed(csv("Title,Summary", "Standup,First notes", "Standup,Other notes")) as [GranolaCsvRow, GranolaCsvRow];
    expect(await granolaCsvDedupeKey(a)).not.toBe(await granolaCsvDedupeKey(b));
  });

  test("an id column wins, ignoring title and time; an unusable id is hashed", async () => {
    const [a, b, c] = parsed(csv(
      "Note ID,Title,Created",
      "not_abc123,One,2026-11-10T09:00:00Z",
      "NOT_ABC123,Renamed,2026-11-12T09:00:00Z",
      "has spaces and/slashes,Two,",
    )) as [GranolaCsvRow, GranolaCsvRow, GranolaCsvRow];
    expect(await granolaCsvDedupeKey(a)).toBe(await granolaCsvDedupeKey(b));
    expect(await granolaCsvSourceId(a)).toBe("not_abc123");
    expect(await granolaCsvSourceId(c)).toMatch(/^csv-[0-9a-f]{32}$/);
  });
});

describe("import", () => {
  test("duplicates inside one file are stored once and counted", async () => {
    const store = new MemoryStore();
    const result = await importGranolaCsv({ tcw, store, text: csv(HEADER, ROW_A, ROW_B, ROW_A), checkPurge: neverBlocked });
    expect(result).toEqual({ ok: true, data: { added: 2, alreadyImported: 0, duplicatesInFile: 1, skippedDeleted: 0, blank: 0, failed: 0 } });
    expect(store.rows.size).toBe(2);
  });

  test("importing the same file again adds nothing", async () => {
    const store = new MemoryStore();
    const text = csv(HEADER, ROW_A, ROW_B);
    await importGranolaCsv({ tcw, store, text, checkPurge: neverBlocked });
    const ids = [...store.rows.keys()].sort();
    const again = await importGranolaCsv({ tcw, store, text, checkPurge: neverBlocked });
    expect(again).toMatchObject({ ok: true, data: { added: 0, alreadyImported: 2 } });
    expect([...store.rows.keys()].sort()).toEqual(ids);
    expect(store.rows.size).toBe(2);
  });

  test("a reordered export dedupes against an earlier import", async () => {
    const store = new MemoryStore();
    await importGranolaCsv({ tcw, store, text: csv(HEADER, ROW_A, ROW_B), checkPurge: neverBlocked });
    const reordered = csv(
      "Transcript,Attendees,Summary,Created,Title",
      '"Ada: hello\nBob: hi","Ada Owner <ada@example.com>; bob@example.com","Agreed the roadmap.",2026-11-10T14:00:00Z,Weekly planning',
    );
    const again = await importGranolaCsv({ tcw, store, text: reordered, checkPurge: neverBlocked });
    expect(again).toMatchObject({ ok: true, data: { added: 0, alreadyImported: 1 } });
    expect(store.rows.size).toBe(2);
  });

  test("a deleted meeting stays out, and allowing deleted meetings back brings it in", async () => {
    const store = new MemoryStore();
    const ledger = new FakeLedger();
    const text = csv(HEADER, ROW_A, ROW_B);
    await importGranolaCsv({ tcw, store, text, checkPurge: ledger.check });
    const weekly = [...store.rows.values()].find((r) => r.meeting.title === "Weekly planning")!.meeting.sourceId;

    // The owner deletes it: the row goes and its id is tombstoned.
    store.rows.delete(weekly);
    ledger.deleted.add(weekly);

    const blocked = await importGranolaCsv({ tcw, store, text, checkPurge: ledger.check });
    expect(blocked).toMatchObject({ ok: true, data: { added: 0, skippedDeleted: 1, alreadyImported: 1 } });
    expect(store.rows.has(weekly)).toBe(false);

    ledger.allowBack();
    const back = await importGranolaCsv({ tcw, store, text, checkPurge: ledger.check });
    expect(back).toMatchObject({ ok: true, data: { added: 1, skippedDeleted: 0 } });
    expect(store.rows.has(weekly)).toBe(true);
  });

  test("asks the purge check about every stored id before writing it", async () => {
    const store = new MemoryStore();
    const order: string[] = [];
    const checked = async (id: string) => {
      order.push(`check:${id}`);
      return false;
    };
    const instrumented: GranolaCsvImportStore = {
      ensureSchema: () => store.ensureSchema(),
      upsertMeeting: (t, meeting, sentences) => {
        order.push(`write:${meeting.sourceId}`);
        return store.upsertMeeting(t, meeting, sentences);
      },
    };
    await importGranolaCsv({ tcw, store: instrumented, text: csv(HEADER, ROW_A, ROW_B), checkPurge: checked });
    expect(order.map((o) => o.split(":")[0])).toEqual(["check", "write", "check", "write"]);
  });

  test("a purge check that cannot answer stops the import without writing that meeting", async () => {
    const store = new MemoryStore();
    const result = await importGranolaCsv({
      tcw, store, text: csv(HEADER, ROW_A, ROW_B),
      checkPurge: async () => { throw new Error("offline"); },
    });
    expect(result).toMatchObject({ ok: false, error: { kind: "purge-check" } });
    expect(store.writes).toBe(0);
  });
});
