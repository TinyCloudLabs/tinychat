// TC-1152 S2b: combined-meeting store, against the in-memory TinyCloud fake (synthetic bodies only).
import { beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import { CONNECTORS_KV_PREFIX, EXO_MERGED_SOURCE, transcriptKvKey } from "@tinyboilerplate/core";

import { makeFakeTinyCloud, type FakeTinyCloud } from "../../../../test/connectors/fake-tinycloud";
import {
  combineMeetings,
  deleteCombined,
  deleteCombinedReferencing,
  staleMembers,
  sweepCombinedMeeting,
  sweepOnMemberRead,
  type MeetingRef,
} from "./combinedMeetingStore";
import { _resetConnectorSchemaMemoForTests, purgeConnector } from "./connectorStore";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const mergedKey = (sourceId: string) => `${CONNECTORS_KV_PREFIX}/${EXO_MERGED_SOURCE}/transcript/${sourceId}`;

// ── Synthetic captures ──────────────────────────────────────────────────
// Sentence i of a meeting is six tokens unique to (seed, i), so every 4-word run is a text anchor.
const sentence = (seed: string, i: number) => ["a", "b", "c", "d", "e", "f"].map((t) => `${seed}${i}${t}`).join(" ");

interface Capture { ref: MeetingRef; body: string; startedAt: string }

/** Two captures of one 8-minute meeting: A has sentences 0-29, B (own clock, +120 s start) has 10-39. */
function pair(seed: string, sourceA: string, sourceB: string): [Capture, Capture] {
  const body = (from: number, to: number, speaker: (i: number) => string) =>
    JSON.stringify(Array.from({ length: to - from }, (_, k) => ({
      index: k, speaker_name: speaker(from + k), text: sentence(seed, from + k), start_time: k * 12, end_time: k * 12 + 11,
    })));
  return [
    { ref: { source: sourceA, sourceId: `${seed}-a` }, body: body(0, 30, (i) => (i % 2 ? "Ada" : "Grace")), startedAt: "2026-10-19T10:00:00.000Z" },
    { ref: { source: sourceB, sourceId: `${seed}-b` }, body: body(10, 40, (i) => `speaker_${i % 2}`), startedAt: "2026-10-19T10:02:00.000Z" },
  ];
}

function seed(f: FakeTinyCloud, c: Capture): void {
  f.sql.meetings.set(`row-${c.ref.sourceId}`, {
    id: `row-${c.ref.sourceId}`, source: c.ref.source, source_id: c.ref.sourceId, title: "Weekly sync",
    started_at: c.startedAt, duration_secs: 360, organizer_email: null, participants: "[]", summary_overview: "provider summary",
    summary_action_items: null, keywords: null, meeting_type: null, metadata: "{}", created_at: "2026-10-19T11:00:00.000Z", updated_at: "2026-10-19T11:00:00.000Z",
  });
  f.kv.entries.set(transcriptKvKey(c.ref.source, c.ref.sourceId), c.body);
}

const NOW = () => new Date("2026-10-20T09:00:00.000Z");
let f: FakeTinyCloud;
let ff: [Capture, Capture];

beforeEach(() => {
  _resetConnectorSchemaMemoForTests();
  f = makeFakeTinyCloud({ did: "did:test:combined" });
  ff = pair("p", "fireflies", "tinycloud-transcriber");
  ff.forEach((c) => seed(f, c));
});

const mergedRows = () => [...f.sql.meetings.values()].filter((r) => r.source === EXO_MERGED_SOURCE);
const originals = () => JSON.stringify([...f.sql.meetings.values()].filter((r) => r.source !== EXO_MERGED_SOURCE));
const originalKv = () => JSON.stringify([...f.kv.entries].filter(([k]) => !k.includes(`/${EXO_MERGED_SOURCE}/`)));

async function combineOk(a: Capture, b: Capture, force = false) {
  const res = await combineMeetings(f.tcw, a.ref, b.ref, { force, now: NOW });
  if (!res.ok) throw new Error(`combine failed: ${res.error.code}`);
  if (res.data.status !== "written") throw new Error("combine refused");
  return res.data;
}

// ── 1. delete guard ─────────────────────────────────────────────────────
describe("deleteCombined guard", () => {
  test("throws for every source except exo-merged and issues zero SQL/KV calls", async () => {
    const written = await combineOk(ff[0], ff[1]);
    f.sql.log.length = 0;
    f.kv.log.length = 0;
    for (const source of ["fireflies", "google-meet", "tinycloud-transcriber", "exo-voice-note", "exo-upload", "exo-local", "EXO-MERGED", "exo-merged ", ""]) {
      await expect(deleteCombined(f.tcw, source, written.id)).rejects.toThrow();
      await expect(deleteCombined(f.tcw, source, "row-p-a")).rejects.toThrow();
    }
    expect(f.sql.log).toEqual([]);
    expect(f.kv.log).toEqual([]);
    expect(mergedRows()).toHaveLength(1);
  });

  test("second guard: handing an ORIGINAL's row id to the exo-merged path deletes nothing", async () => {
    await combineOk(ff[0], ff[1]);
    const before = originals() + originalKv();
    const res = await deleteCombined(f.tcw, EXO_MERGED_SOURCE, "row-p-a");
    expect(res).toEqual({ ok: true, data: { deleted: false } });
    expect(originals() + originalKv()).toBe(before);
    expect(f.kv.log.filter((c) => c.method === "delete")).toEqual([]);
  });
});

// ── 2. originals untouched ──────────────────────────────────────────────
describe("originals untouched", () => {
  test("combine, re-combine, sweep and delete never write a non-exo-merged row or key", async () => {
    const before = { rows: originals(), kv: originalKv(), body: sha(ff[0].body) + sha(ff[1].body) };
    const w = await combineOk(ff[0], ff[1]);
    await combineOk(ff[1], ff[0]);
    await staleMembers(f.tcw, w.id);
    await sweepCombinedMeeting(f.tcw, w.id);
    await deleteCombined(f.tcw, EXO_MERGED_SOURCE, w.id);

    expect(originals()).toBe(before.rows);
    expect(originalKv()).toBe(before.kv);
    expect(sha(f.kv.entries.get(transcriptKvKey("fireflies", "p-a"))!) + sha(f.kv.entries.get(transcriptKvKey("tinycloud-transcriber", "p-b"))!)).toBe(before.body);

    const writes = f.sql.log.filter((c) => /^(INSERT|UPDATE|DELETE)/i.test(c.sql));
    expect(writes.length).toBeGreaterThan(0);
    for (const w2 of writes) {
      const insertsMerged = /^INSERT/i.test(w2.sql) && w2.params[1] === EXO_MERGED_SOURCE;
      expect(insertsMerged || w2.sql.includes("source = 'exo-merged'")).toBe(true);
    }
    for (const c of f.kv.log.filter((c) => c.method !== "get" && c.method !== "head")) {
      expect(c.key.startsWith(`${CONNECTORS_KV_PREFIX}/${EXO_MERGED_SOURCE}/transcript/`)).toBe(true);
    }
  });
});

// ── 3. round trip ───────────────────────────────────────────────────────
describe("round trip", () => {
  test("combine writes the brief's row and body; delete leaves exactly the two originals", async () => {
    const before = { rows: originals(), kv: [...f.kv.entries.keys()].sort() };
    const w = await combineOk(ff[0], ff[1]);

    const [row] = mergedRows();
    expect(mergedRows()).toHaveLength(1);
    expect(row!.source_id).toBe(w.sourceId);
    const merge = JSON.parse(row!.metadata).merge;
    expect(merge).toMatchObject({ v: 1, decided_by: "user", decided_at: "2026-10-20T09:00:00.000Z", detection: { passed: true } });
    expect(merge.members.map((m: { source: string; source_id: string }) => `${m.source}:${m.source_id}`).sort())
      .toEqual(["fireflies:p-a", "tinycloud-transcriber:p-b"]);
    expect(merge.members.map((m: { body_sha256: string }) => m.body_sha256).sort()).toEqual([sha(ff[0].body), sha(ff[1].body)].sort());
    const body = JSON.parse(f.kv.entries.get(mergedKey(w.sourceId))!);
    expect(body.length).toBeGreaterThan(30);
    expect(body.every((s: { sources: unknown[] }) => s.sources.length > 0)).toBe(true);

    await deleteCombined(f.tcw, EXO_MERGED_SOURCE, w.id);
    expect(mergedRows()).toHaveLength(0);
    expect(originals()).toBe(before.rows);
    expect([...f.kv.entries.keys()].sort()).toEqual(before.kv);
  });

  test("a refused pair writes nothing; force writes it with detection.passed=false", async () => {
    const other = pair("q", "google-meet", "tinycloud-transcriber"); // different words entirely
    const mixed: [Capture, Capture] = [ff[0], { ...other[1], startedAt: ff[0].startedAt }];
    seed(f, mixed[1]);
    f.sql.log.length = 0;
    f.kv.log.length = 0;
    const refused = await combineMeetings(f.tcw, mixed[0].ref, mixed[1].ref, { now: NOW });
    expect(refused.ok && refused.data.status).toBe("refused");
    expect(f.sql.log.filter((c) => /^(INSERT|UPDATE|DELETE)/i.test(c.sql))).toEqual([]);
    expect(f.kv.log.filter((c) => c.method === "put")).toEqual([]);

    const forced = await combineOk(mixed[0], mixed[1], true);
    expect(forced.passed).toBe(false);
    expect(JSON.parse(mergedRows()[0]!.metadata).merge.detection.passed).toBe(false);
  });
});

// ── 4. idempotent ───────────────────────────────────────────────────────
describe("idempotent", () => {
  test("same pair twice (either order): one row, same source_id, byte-identical body", async () => {
    const first = await combineOk(ff[0], ff[1]);
    const body1 = f.kv.entries.get(mergedKey(first.sourceId));
    const second = await combineOk(ff[1], ff[0]);
    expect(mergedRows()).toHaveLength(1);
    expect(second.sourceId).toBe(first.sourceId);
    expect(second.id).toBe(first.id);
    expect(second.created).toBe(false);
    expect(f.kv.entries.get(mergedKey(first.sourceId))).toBe(body1!);
  });

  test("a racing writer with a LOWER id lands between select and insert: MIN(id) is kept, ours is removed", async () => {
    let raced = false;
    f.sql.beforeStatement = (sql) => {
      if (raced || !/^INSERT INTO connector_meeting/i.test(sql.trim())) return;
      raced = true;
      const sourceId = mergedRows()[0]?.source_id ?? [...f.kv.entries.keys()].find((k) => k.includes("/exo-merged/transcript/"))!.split("/").pop()!;
      f.sql.meetings.set("0000-rival", { ...f.sql.meetings.get("row-p-a")!, id: "0000-rival", source: EXO_MERGED_SOURCE, source_id: sourceId, metadata: "{}" });
    };
    const w = await combineOk(ff[0], ff[1]);
    expect(raced).toBe(true);
    expect(mergedRows().map((r) => r.id)).toEqual(["0000-rival"]);
    expect(w.id).toBe("0000-rival");
    // The keeper was brought up to date in place.
    expect(JSON.parse(mergedRows()[0]!.metadata).merge.members).toHaveLength(2);
  });

  test("a racing writer with a HIGHER id: ours is the keeper and the rival is removed", async () => {
    let raced = false;
    f.sql.beforeStatement = (sql) => {
      if (raced || !/^INSERT INTO connector_meeting/i.test(sql.trim())) return;
      raced = true;
      const sourceId = [...f.kv.entries.keys()].find((k) => k.includes("/exo-merged/transcript/"))!.split("/").pop()!;
      f.sql.meetings.set("ffff-rival", { ...f.sql.meetings.get("row-p-a")!, id: "ffff-rival", source: EXO_MERGED_SOURCE, source_id: sourceId, metadata: "{}" });
    };
    const w = await combineOk(ff[0], ff[1]);
    expect(mergedRows().map((r) => r.id)).toEqual([w.id]);
    expect(w.id).not.toBe("ffff-rival");
  });

  test("an insert that loses the primary-key race is not an error", async () => {
    f.sql.beforeStatement = (sql) => {
      if (!/^INSERT INTO connector_meeting/i.test(sql.trim())) return;
      f.sql.beforeStatement = null;
      const sourceId = [...f.kv.entries.keys()].find((k) => k.includes("/exo-merged/transcript/"))!.split("/").pop()!;
      f.sql.meetings.set("rival", { ...f.sql.meetings.get("row-p-a")!, id: "rival", source: EXO_MERGED_SOURCE, source_id: sourceId, metadata: "{}" });
      f.sql.nextMeetingWriteError = { code: "SQL_CONSTRAINT", message: "UNIQUE constraint failed: connector_meeting.id" };
    };
    const w = await combineOk(ff[0], ff[1]);
    expect(mergedRows().map((r) => r.id)).toEqual(["rival"]);
    expect(w.id).toBe("rival");
  });

  test("a changed source is reported stale; re-combining keeps the id and replaces the row in place", async () => {
    const w = await combineOk(ff[0], ff[1]);
    expect((await staleMembers(f.tcw, w.id))).toEqual({ ok: true, data: [] });

    const edited = JSON.parse(ff[1].body);
    edited.push({ index: 99, speaker_name: "speaker_0", text: sentence("p", 40), start_time: 360, end_time: 371 });
    f.kv.entries.set(transcriptKvKey("tinycloud-transcriber", "p-b"), JSON.stringify(edited));
    const stale = await staleMembers(f.tcw, w.id);
    expect(stale).toEqual({ ok: true, data: [{ source: "tinycloud-transcriber", sourceId: "p-b", state: "changed" }] });

    const createdAt = mergedRows()[0]!.created_at;
    const again = await combineMeetings(f.tcw, ff[0].ref, ff[1].ref, { now: () => new Date("2026-10-21T09:00:00.000Z") });
    expect(again.ok && again.data.status === "written" && again.data.id).toBe(w.id);
    expect(mergedRows()).toHaveLength(1);
    expect(mergedRows()[0]!.created_at).toBe(createdAt);
    expect(JSON.parse(mergedRows()[0]!.metadata).merge.decided_at).toBe("2026-10-21T09:00:00.000Z");
    expect((await staleMembers(f.tcw, w.id))).toEqual({ ok: true, data: [] });
  });
});

// ── members: voice notes read the committed body, never the legacy mirror ───
describe("voice-note members", () => {
  test("body comes from the committed transcript-rev key", async () => {
    const [a, b] = pair("v", "exo-voice-note", "fireflies");
    seed(f, a);
    seed(f, b);
    const revKey = `${CONNECTORS_KV_PREFIX}/exo-voice-note/transcript-rev/${a.ref.sourceId}/hash`;
    f.kv.entries.set(revKey, a.body);
    f.kv.entries.set(transcriptKvKey("exo-voice-note", a.ref.sourceId), "[]"); // legacy mirror: empty
    f.sql.voiceNoteCommits.set(a.ref.sourceId, revKey);
    const w = await combineOk(a, b);
    const members = JSON.parse(mergedRows().find((r) => r.source_id === w.sourceId)!.metadata).merge.members;
    expect(members.find((m: { source: string }) => m.source === "exo-voice-note").body_sha256).toBe(sha(a.body));
    expect(f.kv.log.some((c) => c.method === "get" && c.key === revKey)).toBe(true);
  });
});

// ── 5. cascade ──────────────────────────────────────────────────────────
describe("purgeConnector cascade", () => {
  let gm: [Capture, Capture];
  beforeEach(() => {
    gm = pair("g", "google-meet", "tinycloud-transcriber");
    gm.forEach((c) => seed(f, c));
  });

  test("purging fireflies removes combined meetings that list a Fireflies member and keeps the rest", async () => {
    const c1 = await combineOk(ff[0], ff[1]);
    const c2 = await combineOk(gm[0], gm[1]);
    const res = await purgeConnector(f.tcw, "fireflies");
    expect(res.ok).toBe(true);
    expect(mergedRows().map((r) => r.source_id)).toEqual([c2.sourceId]);
    expect(f.kv.entries.has(mergedKey(c1.sourceId))).toBe(false);
    expect(f.kv.entries.has(mergedKey(c2.sourceId))).toBe(true);
    // Originals of other sources are still there.
    expect(f.sql.meetings.has("row-p-b")).toBe(true);
    expect(f.sql.meetings.has("row-g-a")).toBe(true);
    expect(f.sql.meetings.has("row-p-a")).toBe(false);
  });

  test("a failing cascade fails the purge before any original is touched", async () => {
    const c1 = await combineOk(ff[0], ff[1]);
    f.kv.deleteErrors.set(mergedKey(c1.sourceId), { code: "KV_ERROR", message: "boom" });
    const before = originals() + originalKv();
    const res = await purgeConnector(f.tcw, "fireflies");
    expect(res.ok).toBe(false);
    expect(originals() + originalKv()).toBe(before);
    expect(mergedRows()).toHaveLength(1);

    // Retry after the fault clears completes the purge.
    f.kv.deleteErrors.clear();
    expect((await purgeConnector(f.tcw, "fireflies")).ok).toBe(true);
    expect(mergedRows()).toHaveLength(0);
  });

  test("an exo-merged row with unreadable metadata is derived data of unknown provenance and is removed", async () => {
    const c1 = await combineOk(ff[0], ff[1]);
    mergedRows()[0]!.metadata = "not json";
    const res = await deleteCombinedReferencing(f.tcw, "fireflies");
    expect(res).toEqual({ ok: true, data: { deletedIds: [c1.id] } });
    expect(mergedRows()).toHaveLength(0);
  });
});

// ── 6. sweep ────────────────────────────────────────────────────────────
describe("read-time sweep", () => {
  test("a member that is absent deletes the combined meeting (row and body)", async () => {
    const w = await combineOk(ff[0], ff[1]);
    f.kv.entries.delete(transcriptKvKey("tinycloud-transcriber", "p-b"));
    const res = await sweepCombinedMeeting(f.tcw, w.id);
    expect(res).toEqual({ ok: true, data: { status: "deleted" } });
    expect(mergedRows()).toHaveLength(0);
    expect(f.kv.entries.has(mergedKey(w.sourceId))).toBe(false);
    expect(f.sql.meetings.has("row-p-a")).toBe(true);
  });

  test("a member read that failed deletes nothing", async () => {
    const w = await combineOk(ff[0], ff[1]);
    f.kv.getErrors.set(transcriptKvKey("tinycloud-transcriber", "p-b"), { code: "KV_TRANSPORT", message: "timeout" });
    f.sql.log.length = 0;
    f.kv.log.length = 0;
    const res = await sweepCombinedMeeting(f.tcw, w.id);
    expect(res).toEqual({ ok: true, data: { status: "unverified" } });
    expect(mergedRows()).toHaveLength(1);
    expect(f.kv.entries.has(mergedKey(w.sourceId))).toBe(true);
    expect(f.sql.log.filter((c) => /^DELETE/i.test(c.sql))).toEqual([]);
    expect(f.kv.log.filter((c) => c.method === "delete")).toEqual([]);
  });

  test("a body that landed but is not JSON is ambiguous, not absent: nothing is deleted", async () => {
    const w = await combineOk(ff[0], ff[1]);
    f.kv.entries.set(transcriptKvKey("fireflies", "p-a"), "<html>gateway error</html>");
    expect(await sweepCombinedMeeting(f.tcw, w.id)).toEqual({ ok: true, data: { status: "unverified" } });
    expect(mergedRows()).toHaveLength(1);
  });

  test("sweepOnMemberRead: absent cascades, failed and ok do not", async () => {
    const w = await combineOk(ff[0], ff[1]);
    expect(await sweepOnMemberRead(f.tcw, ff[0].ref, { status: "failed" })).toEqual({ ok: true, data: { status: "unverified" } });
    expect(await sweepOnMemberRead(f.tcw, ff[0].ref, { status: "ok" })).toEqual({ ok: true, data: { status: "kept" } });
    expect(mergedRows()).toHaveLength(1);
    expect(await sweepOnMemberRead(f.tcw, { source: "fireflies", sourceId: "unrelated" }, { status: "absent" })).toEqual({ ok: true, data: { status: "kept" } });
    expect(mergedRows()).toHaveLength(1);
    expect(await sweepOnMemberRead(f.tcw, ff[0].ref, { status: "absent" })).toEqual({ ok: true, data: { status: "deleted" } });
    expect(mergedRows()).toHaveLength(0);
    expect(f.kv.entries.has(mergedKey(w.sourceId))).toBe(false);
  });
});
