import { beforeEach, describe, expect, test } from "bun:test";

import { CONNECTORS_KV_PREFIX, EXO_MERGED_SOURCE } from "@tinyboilerplate/core";

import { makeFakeTinyCloud, type FakeTinyCloud } from "../../../../test/connectors/fake-tinycloud";
import { combineMeetings } from "@/lib/connectors/combinedMeetingStore";
import { _resetConnectorSchemaMemoForTests } from "@/lib/connectors/connectorStore";
import type { CallFailure } from "./generateSummary";
import { chatComplete } from "./summaryChat";
import { createSummaryRunner, storedSummaryView, type SummaryRunner, type SummaryView } from "./summaryRunner";

const GOOD = "OVERVIEW:\nThe team agreed to ship the beta.\nACTION ITEMS:\n- Ana: freeze the build\n- Ben: write the notes";
const classify = (error: unknown): CallFailure => (error instanceof Error ? (error.message as CallFailure) : "other");

// Two partial captures of one meeting (synthetic words), combined by the real store into the row under test.
const sentence = (seed: string, i: number) => ["a", "b", "c", "d", "e", "f"].map((t) => `${seed}${i}${t}`).join(" ");
const capture = (seed: string, from: number, to: number, speaker: (i: number) => string) => JSON.stringify(
  Array.from({ length: to - from }, (_, k) => ({ index: k, speaker_name: speaker(from + k), text: sentence(seed, from + k), start_time: k * 12, end_time: k * 12 + 11 })));

let f: FakeTinyCloud;
let COMBINED_ROW_ID: string;
let COMBINED_SOURCE_ID: string;
let runner: SummaryRunner;
let calls: string[][];
let reply: (call: number) => string | Error | Promise<string>;

const isWrite = (sql: string) => /^(INSERT|UPDATE|DELETE)/i.test(sql);
/** Writes after the combine was seeded (a mark is taken once the row exists). */
let mark = 0;
const writes = () => f.sql.log.slice(mark).filter((c) => isWrite(c.sql));
const kvWrites = () => f.kv.log.filter((c) => c.method === "put" || c.method === "delete");
const row = () => f.sql.meetings.get(COMBINED_ROW_ID)!;
const setRow = (patch: Record<string, unknown>) => f.sql.meetings.set(COMBINED_ROW_ID, { ...row(), ...patch });
const bodyKey = () => `${CONNECTORS_KV_PREFIX}/${EXO_MERGED_SOURCE}/transcript/${COMBINED_SOURCE_ID}`;
const view = () => runner.view(COMBINED_ROW_ID);
const settled = async (until: (v: SummaryView | undefined) => boolean) => {
  for (let i = 0; i < 200 && !until(view()); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  if (!until(view())) throw new Error(`timed out; view=${JSON.stringify(view())}`);
};
const done = () => settled((v) => v?.status === "ready" || v?.status === "unavailable");
const make = () => createSummaryRunner({
  space: f.tcw,
  classify,
  complete: async (messages) => {
    calls.push(messages.map((m) => m.content));
    const out = await reply(calls.length);
    if (out instanceof Error) throw out;
    return out;
  },
});

beforeEach(async () => {
  _resetConnectorSchemaMemoForTests();
  f = makeFakeTinyCloud({ did: "did:test:summary" });
  for (const [id, seed, from, to, speaker, startedAt, source] of [
    ["row-a", "p", 0, 30, (i: number) => (i % 2 ? "Ada" : "Grace"), "2026-10-19T10:00:00.000Z", "fireflies"],
    ["row-b", "p", 10, 40, (i: number) => `speaker_${i % 2}`, "2026-10-19T10:02:00.000Z", "tinycloud-transcriber"],
  ] as const) {
    f.sql.meetings.set(id, { id, source, source_id: id, title: "Weekly sync", started_at: startedAt, duration_secs: 360, organizer_email: null, participants: "[]", summary_overview: "provider summary", summary_action_items: null, keywords: null, meeting_type: null, metadata: "{}", created_at: startedAt, updated_at: startedAt });
    f.kv.entries.set(`${CONNECTORS_KV_PREFIX}/${source}/transcript/${id}`, capture(seed, from, to, speaker));
  }
  const res = await combineMeetings(f.tcw, { source: "fireflies", sourceId: "row-a" }, { source: "tinycloud-transcriber", sourceId: "row-b" }, { now: () => new Date("2026-10-20T09:00:00.000Z") });
  if (!res.ok || res.data.status !== "written") throw new Error("seed combine failed");
  COMBINED_ROW_ID = res.data.id;
  COMBINED_SOURCE_ID = res.data.sourceId;
  mark = f.sql.log.length;
  f.kv.log.length = 0;
  calls = [];
  reply = () => GOOD;
  runner = make();
});

describe("a combine's summary", () => {
  test("one call from the combined text; the result is written as exactly the two summary columns and nothing else", async () => {
    const before = { ...row() };
    const others = JSON.stringify([...f.sql.meetings.values()].filter((r) => r.id !== COMBINED_ROW_ID));
    runner.start(COMBINED_ROW_ID, { replacing: false });
    expect(view()).toEqual({ status: "generating" });
    await done();
    expect(view()).toEqual({ status: "ready", overview: "The team agreed to ship the beta.", actionItems: ["Ana: freeze the build", "Ben: write the notes"] });
    expect(calls).toHaveLength(1);
    // The model saw the combined body's text (speaker + words), nothing from the row's metadata.
    expect(calls[0]![1]).toContain("p0a");
    expect(calls[0]![1]).not.toContain("exo-merged");
    expect(calls[0]![1]).not.toContain("body_sha256");
    // ONE write: a single UPDATE naming only the two columns, with only the combined row's id.
    const w = writes();
    expect(w).toHaveLength(1);
    expect(w[0]!.sql).toBe("UPDATE connector_meeting SET summary_overview = ?, summary_action_items = ? WHERE id = ? AND source = 'exo-merged'");
    expect(w[0]!.params).toEqual(["The team agreed to ship the beta.", "Ana: freeze the build\nBen: write the notes", COMBINED_ROW_ID]);
    expect(kvWrites()).toEqual([]);
    expect(JSON.stringify([...f.sql.meetings.values()].filter((r) => r.id !== COMBINED_ROW_ID))).toBe(others);
    // Every other column, and the stored metadata string, is byte-identical.
    expect({ ...row(), summary_overview: null, summary_action_items: null }).toEqual({ ...before, summary_overview: null, summary_action_items: null });
    expect(row().metadata).toBe(before.metadata);
    expect(row().updated_at).toBe(before.updated_at);
    expect(row().summary_action_items).toBe("Ana: freeze the build\nBen: write the notes");
    // And the page, reading it back, shows the same.
    expect(storedSummaryView({ overview: row().summary_overview, actionItems: row().summary_action_items })).toEqual(view()!);
  });

  test("a failed call leaves the combine and the row exactly as they were, and the page says unavailable", async () => {
    const before = JSON.stringify([...f.sql.meetings]) + JSON.stringify([...f.kv.entries]);
    reply = () => new Error("boom");
    runner.start(COMBINED_ROW_ID, { replacing: false });
    await done();
    expect(view()).toEqual({ status: "unavailable", reason: "failed" });
    expect(writes()).toEqual([]);
    expect(JSON.stringify([...f.sql.meetings]) + JSON.stringify([...f.kv.entries])).toBe(before);
  });

  test("a reply that is not the expected shape is unavailable and writes nothing", async () => {
    reply = () => "HACKED";
    runner.start(COMBINED_ROW_ID, { replacing: false });
    await done();
    expect(view()).toEqual({ status: "unavailable", reason: "failed" });
    expect(writes()).toEqual([]);
  });

  test("a model reply with no content (finish_reason length, reasoning only) is unavailable and writes nothing", async () => {
    const realFetch = globalThis.fetch;
    const sessionStore = { getToken: () => "token", isExpired: () => false, clear: () => {} } as never;
    globalThis.fetch = (async () => new Response(
      'data: {"choices":[{"delta":{"reasoning":"still thinking"},"finish_reason":null}]}\n\n' +
        'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n' +
        "data: [DONE]\n\n",
      { status: 200, headers: { "content-type": "text/event-stream" } },
    )) as typeof fetch;
    try {
      runner = createSummaryRunner({ space: f.tcw, classify, complete: chatComplete("http://backend.test", sessionStore) });
      runner.start(COMBINED_ROW_ID, { replacing: false });
      await done();
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(view()).toEqual({ status: "unavailable", reason: "failed" });
    expect(writes()).toEqual([]);
  });

  test("out of credits is unavailable with its own reason, after one call", async () => {
    reply = () => new Error("paywall");
    runner.start(COMBINED_ROW_ID, { replacing: false });
    await done();
    expect(view()).toEqual({ status: "unavailable", reason: "paywall" });
    expect(calls).toHaveLength(1);
  });

  test("Retry regenerates after a failure and writes; a second Retry while it runs makes no second call", async () => {
    reply = () => new Error("boom");
    runner.start(COMBINED_ROW_ID, { replacing: false });
    await done();
    let release!: () => void;
    reply = () => new Promise<string>((resolve) => { release = () => resolve(GOOD); });
    runner.retry(COMBINED_ROW_ID);
    runner.retry(COMBINED_ROW_ID);
    runner.retry(COMBINED_ROW_ID);
    expect(view()).toEqual({ status: "generating" });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(calls).toHaveLength(2);
    release();
    await done();
    expect(view()?.status).toBe("ready");
    expect(writes()).toHaveLength(1);
  });

  test("a long meeting that overflows goes through the chunked path inside the run, in order, and still writes once", async () => {
    // A combined body of 150 long segments: ~150k characters.
    const big = JSON.stringify(Array.from({ length: 150 }, (_, i) => ({ index: i, speaker_name: "Ana", text: `point ${i} `.padEnd(1000, "w"), start_time: i, end_time: i + 1, sources: [] })));
    f.kv.entries.set(bodyKey(), big);
    reply = (n) => (n === 1 ? new Error("overflow") : GOOD);
    runner.start(COMBINED_ROW_ID, { replacing: false });
    await done();
    expect(view()?.status).toBe("ready");
    expect(calls).toHaveLength(5); // refused whole call + 3 chunks + merge
    expect(writes()).toHaveLength(1);
  });

  test("a meeting above the chunk cap is unavailable (too long) and nothing is sent", async () => {
    const huge = JSON.stringify(Array.from({ length: 18 }, (_, i) => ({ index: i, speaker_name: "Ana", text: `p${i} `.padEnd(1400, "w"), start_time: i, end_time: i + 1 })).flatMap((s) => Array.from({ length: 45 }, () => s)));
    f.kv.entries.set(bodyKey(), huge);
    runner.start(COMBINED_ROW_ID, { replacing: false });
    await done();
    expect(view()).toEqual({ status: "unavailable", reason: "too_long" });
    expect(calls).toHaveLength(0);
    expect(writes()).toEqual([]);
  });
});

describe("Re-combine", () => {
  test("regenerates and overwrites the old summary (still one UPDATE of the two columns)", async () => {
    setRow({ summary_overview: "Old overview.", summary_action_items: "Old item" });
    runner.start(COMBINED_ROW_ID, { replacing: true });
    await done();
    expect(row().summary_overview).toBe("The team agreed to ship the beta.");
    // Clear first, then the new summary: two UPDATEs of the same two columns.
    expect(writes().map((w) => w.sql)).toEqual(Array(2).fill("UPDATE connector_meeting SET summary_overview = ?, summary_action_items = ? WHERE id = ? AND source = 'exo-merged'"));
    expect(writes()[0]!.params).toEqual([null, null, COMBINED_ROW_ID]);
  });

  test("the old summary is gone the moment a Re-combine starts: cancelling mid-run, or a failed clear, never leaves it as current", async () => {
    setRow({ summary_overview: "Old overview.", summary_action_items: "Old item" });
    reply = () => new Promise<string>(() => undefined);
    runner.start(COMBINED_ROW_ID, { replacing: true });
    await new Promise((resolve) => setTimeout(resolve, 30));
    runner.cancelAll();
    expect(row().summary_overview).toBeNull();
    expect(storedSummaryView({ overview: row().summary_overview, actionItems: row().summary_action_items })).toEqual({ status: "idle" });
    setRow({ summary_overview: "Old overview.", summary_action_items: "Old item" });
    calls.length = 0;
    f.sql.nextMeetingWriteError = { code: "SQL_ERROR", message: "injected" };
    runner.start(COMBINED_ROW_ID, { replacing: true });
    await done();
    expect(view()).toEqual({ status: "unavailable", reason: "failed" });
    expect(calls).toHaveLength(0);
  });

  test("if the new summary fails, the old one (of the old text) is cleared rather than left", async () => {
    setRow({ summary_overview: "Old overview.", summary_action_items: "Old item" });
    reply = () => new Error("boom");
    runner.start(COMBINED_ROW_ID, { replacing: true });
    await done();
    expect(view()).toEqual({ status: "unavailable", reason: "failed" });
    expect(row().summary_overview).toBeNull();
    expect(row().summary_action_items).toBeNull();
    expect(writes()).toHaveLength(1);
    expect(writes()[0]!.sql).toContain("SET summary_overview = ?, summary_action_items = ?");
  });

  test("a second Re-combine while one runs drops the first result: one summary is written, from the second run", async () => {
    const releases: ((text: string) => void)[] = [];
    reply = () => new Promise<string>((resolve) => { releases.push(resolve); });
    runner.start(COMBINED_ROW_ID, { replacing: true });
    await new Promise((resolve) => setTimeout(resolve, 30));
    runner.start(COMBINED_ROW_ID, { replacing: true });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(releases).toHaveLength(2);
    releases[0]!("OVERVIEW:\nFirst run.\nACTION ITEMS:\n- None");
    releases[1]!("OVERVIEW:\nSecond run.\nACTION ITEMS:\n- None");
    await done();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(row().summary_overview).toBe("Second run.");
    expect(writes().filter((w) => w.params[0] !== null)).toHaveLength(1);
  });
});

describe("saving", () => {
  test("a summary that could not be saved is retried WITHOUT another model call", async () => {
    f.sql.nextMeetingWriteError = { code: "SQL_ERROR", message: "injected" };
    runner.start(COMBINED_ROW_ID, { replacing: false });
    await done();
    expect(view()).toEqual({ status: "unavailable", reason: "failed" });
    expect(calls).toHaveLength(1);
    runner.retry(COMBINED_ROW_ID);
    await done();
    await settled((v) => v?.status === "ready");
    expect(calls).toHaveLength(1);
    expect(row().summary_overview).toBe("The team agreed to ship the beta.");
  });
});

describe("cancel and reopen", () => {
  test("cancelAll (another account, or leaving) stops the run: its result is never written", async () => {
    let release!: () => void;
    reply = () => new Promise<string>((resolve) => { release = () => resolve(GOOD); });
    runner.start(COMBINED_ROW_ID, { replacing: false });
    await new Promise((resolve) => setTimeout(resolve, 30));
    runner.cancelAll();
    release();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(view()).toBeUndefined();
    expect(writes()).toEqual([]);
  });

  test("nothing starts a run but start and retry: reading a view or a stored summary makes no call", async () => {
    setRow({ summary_overview: "Stored overview.", summary_action_items: "One\nTwo" });
    expect(view()).toBeUndefined();
    expect(storedSummaryView({ overview: "Stored overview.", actionItems: "One\nTwo" })).toEqual({ status: "ready", overview: "Stored overview.", actionItems: ["One", "Two"] });
    expect(storedSummaryView({ overview: null, actionItems: null })).toEqual({ status: "idle" });
    expect(calls).toHaveLength(0);
  });
});

describe("clear and settle", () => {
  test("clear drops a combine's old summary with no model call, and reads back as idle", async () => {
    setRow({ summary_overview: "Old overview.", summary_action_items: "Old item" });
    runner.clear(COMBINED_ROW_ID);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(row().summary_overview).toBeNull();
    expect(row().summary_action_items).toBeNull();
    expect(view()).toEqual({ status: "idle" });
    expect(storedSummaryView({ overview: row().summary_overview, actionItems: row().summary_action_items })).toEqual({ status: "idle" });
    expect(calls).toHaveLength(0);
  });

  test("clear shows idle before its write lands, so the stored summary is never shown as current", () => {
    setRow({ summary_overview: "Old overview.", summary_action_items: "Old item" });
    runner.clear(COMBINED_ROW_ID);
    expect(view()).toEqual({ status: "idle" });
  });

  test("a clear whose write fails shows Retry, not the old summary", async () => {
    setRow({ summary_overview: "Old overview.", summary_action_items: "Old item" });
    f.sql.nextMeetingWriteError = { code: "SQL_ERROR", message: "write failed" };
    runner.clear(COMBINED_ROW_ID);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(view()).toEqual({ status: "unavailable", reason: "failed" });
    expect(row().summary_overview).toBe("Old overview.");
  });

  test("onSettled fires once when a run ends with a summary, and again when it ends in failure", async () => {
    let settledCount = 0;
    const counted = createSummaryRunner({ space: f.tcw, classify, complete: async (messages) => {
      calls.push(messages.map((m) => m.content));
      const out = await reply(calls.length);
      if (out instanceof Error) throw out;
      return out;
    }, onSettled: () => { settledCount++; } });
    counted.start(COMBINED_ROW_ID, { replacing: false });
    for (let i = 0; i < 200 && counted.view(COMBINED_ROW_ID)?.status !== "ready"; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settledCount).toBe(1);
    reply = () => new Error("boom");
    counted.retry(COMBINED_ROW_ID);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(settledCount).toBe(2);
  });
});
