import { Database, type SQLQueryBindings } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { normalizeGranolaCsvRow, parseGranolaCsv } from "./granolaCsv";
import { importGranolaCsv } from "./granolaCsvImport";
import * as store from "./connectorStore";
import { sweepCombinedMeeting } from "./combinedMeetingStore";

const csv = "ID,Title,Created,Summary,Transcript\nfirst-id,First meeting,2026-11-10T14:00:00Z,First summary,QA: first\nother-id,Other meeting,2026-11-11T14:00:00Z,Other summary,QA: other";
const ok = <T,>(data: T) => ({ ok: true as const, data });
const storageError = { code: "STORAGE_UNAVAILABLE", message: "private meeting text must not escape" };
const closers: (() => void)[] = [];
afterEach(() => { for (const close of closers.splice(0)) close(); });

function fixture() {
  const db = new Database(":memory:");
  closers.push(() => db.close());
  const bodies = new Map<string, unknown>();
  const faults = {
    sql: null as { pattern: RegExp; throws?: boolean } | null,
    kvDelete: false,
    tombstoneRows: undefined as unknown,
    afterMeetingDelete: null as (() => void) | null,
    beforeMeetingInsert: null as (() => Promise<void>) | null,
    beforeTranscriptPut: null as (() => Promise<void>) | null,
    combinedReadFailure: null as "result" | "rejection" | "missing-space" | null,
  };
  const sqlError = (sql: string) => {
    if (!faults.sql?.pattern.test(sql)) return null;
    const fault = faults.sql;
    faults.sql = null;
    if (fault.throws) throw new Error(storageError.message);
    return { ok: false as const, error: storageError };
  };
  const run = (sql: string, params: SQLQueryBindings[] = []) => {
    const result = db.query(sql).run(...params);
    if (/DELETE FROM connector_meeting WHERE source = \? AND source_id = \?/i.test(sql)) {
      faults.afterMeetingDelete?.();
    }
    return { changes: result.changes, lastInsertRowId: Number(result.lastInsertRowid) };
  };
  const tcw = {
    did: `did:fixture:${crypto.randomUUID()}`,
    sql: { db: () => ({
      query: async (sql: string, params: SQLQueryBindings[] = []) => sqlError(sql) ?? ok({
        rows: /FROM granola_deleted_meeting/i.test(sql) && faults.tombstoneRows !== undefined
          ? faults.tombstoneRows
          : db.query(sql).values(...params),
      }),
      execute: async (sql: string, params: SQLQueryBindings[] = []) => {
        if (/INSERT INTO connector_meeting/i.test(sql)) await faults.beforeMeetingInsert?.();
        return sqlError(sql) ?? ok(run(sql, params));
      },
      batch: async (statements: { sql: string; params?: SQLQueryBindings[] }[]) => ok(db.transaction(() => statements.map(statement => run(statement.sql, statement.params)))()),
    }) },
    kv: {
      get: async (key: string) => {
        if (faults.combinedReadFailure && key.includes("/exo-merged/transcript/")) {
          if (faults.combinedReadFailure === "rejection") throw new Error(storageError.message);
          return { ok: false, error: faults.combinedReadFailure === "missing-space" ? { code: "KV_NOT_FOUND", message: "Space not found" } : storageError };
        }
        return bodies.has(key) ? ok({ data: bodies.get(key), headers: {} }) : { ok: false, error: { code: "KV_NOT_FOUND", message: "not found" } };
      },
      put: async (key: string, value: unknown) => {
        await faults.beforeTranscriptPut?.();
        bodies.set(key, value);
        return ok({ data: undefined, headers: {} });
      },
      delete: async (key: string) => {
        if (faults.kvDelete) { faults.kvDelete = false; return { ok: false, error: storageError }; }
        if (!bodies.delete(key)) return { ok: false, error: { code: "KV_NOT_FOUND", message: "not found" } };
        return ok({ data: undefined, headers: {} });
      },
    },
  } as unknown as TinyCloudWeb;
  const imported = () => importGranolaCsv({ tcw, store, text: csv, checkPurge: async () => false });
  const rows = () => db.query("SELECT source, source_id FROM connector_meeting ORDER BY source, source_id").values();
  const combined = (id: string, memberId: string | null) => {
    const metadata = memberId === null ? {} : { merge: { members: [{ source: "granola", source_id: memberId }] } };
    db.query("INSERT INTO connector_meeting (id, source, source_id, metadata, created_at, updated_at) VALUES (?, 'exo-merged', ?, ?, '2026-11-10T14:00:00Z', '2026-11-10T14:00:00Z')").run(id, id, JSON.stringify(metadata));
    bodies.set(store.transcriptKvKey("exo-merged", id), memberId === null ? "unreadable" : JSON.stringify([{ text: "combined text", sources: [{ source: "granola", source_id: memberId }] }]));
  };
  return { db, bodies, tcw, faults, imported, rows, combined };
}

async function firstMeeting() {
  const parsed = parseGranolaCsv(csv);
  if (!parsed.ok) throw new Error("invalid fixture CSV");
  return normalizeGranolaCsvRow(parsed.data.rows[0]!);
}

test("deletion removes only the selected CSV meeting and its combined copies, and blocks CSV/API reimport until cleared", async () => {
  const f = fixture();
  expect((await f.imported()).ok).toBe(true);
  const original = f.db.query("SELECT id, created_at FROM connector_meeting WHERE source_id = 'first-id'").values()[0]!;
  f.combined("selected-combined", "first-id");
  f.combined("other-combined", "other-id");
  const normalized = await firstMeeting();
  expect((await store.upsertMeeting(f.tcw, { ...normalized.meeting, id: "other-provider", source: "fireflies" }, normalized.sentences)).ok).toBe(true);

  expect(await store.deleteGranolaCsvMeeting(f.tcw, "first-id")).toEqual(ok({ unverifiedCombinedIds: [] }));
  expect(f.rows()).toEqual([["exo-merged", "other-combined"], ["fireflies", "first-id"], ["granola", "other-id"]]);
  expect(f.bodies.has(store.transcriptKvKey("granola", "first-id"))).toBe(false);
  expect(f.bodies.has(store.transcriptKvKey("exo-merged", "selected-combined"))).toBe(false);
  expect(f.bodies.has(store.transcriptKvKey("granola", "other-id"))).toBe(true);
  expect(f.bodies.has(store.transcriptKvKey("fireflies", "first-id"))).toBe(true);
  expect(f.db.query("SELECT * FROM granola_deleted_meeting").values()).toEqual([["first-id", ...original]]);

  const repeated = await f.imported();
  expect(repeated.ok && repeated.data).toMatchObject({ added: 0, alreadyImported: 1, skippedDeleted: 1 });
  const apiWrite = await store.upsertMeeting(f.tcw, { ...normalized.meeting, id: "discard-incoming-id", metadata: { granola_updated_at: "2026-11-19T00:00:00Z" } }, normalized.sentences);
  expect(apiWrite).toEqual(ok({ id: original[0], createdAt: original[1], inserted: false, skippedDeleted: true }));
  expect(f.bodies.has(store.transcriptKvKey("granola", "first-id"))).toBe(false);
  expect(await store.deleteGranolaCsvMeeting(f.tcw, "first-id")).toEqual(ok({ unverifiedCombinedIds: [] }));

  const otherOwner = fixture();
  expect((await otherOwner.imported()).ok).toBe(true);
  expect(otherOwner.rows()).toEqual([["granola", "first-id"], ["granola", "other-id"]]);
  expect(await store.clearGranolaDeletedMeetings(f.tcw)).toEqual(ok(undefined));
  const restored = await f.imported();
  expect(restored.ok && restored.data).toMatchObject({ added: 1, skippedDeleted: 0 });
  expect(f.bodies.has(store.transcriptKvKey("granola", "first-id"))).toBe(true);
});

test("deletion rechecks persisted CSV provenance and refuses unsafe IDs without touching content", async () => {
  const f = fixture();
  await f.imported();
  f.db.query("UPDATE connector_meeting SET metadata = '{}' WHERE source_id = 'first-id'").run();
  expect((await store.deleteGranolaCsvMeeting(f.tcw, "first-id")).ok).toBe(false);
  for (const id of ["", "../other-id", "first-id/other-id", "a".repeat(65)]) {
    expect((await store.deleteGranolaCsvMeeting(f.tcw, id)).ok).toBe(false);
  }
  expect(await store.deleteGranolaCsvMeeting(f.tcw, "missing-id")).toEqual(ok({ unverifiedCombinedIds: [] }));
  expect(f.rows()).toEqual([["granola", "first-id"], ["granola", "other-id"]]);
  expect(f.bodies.has(store.transcriptKvKey("granola", "first-id"))).toBe(true);
  expect(f.db.query("SELECT * FROM granola_deleted_meeting").values()).toEqual([]);
});

test("a failed tombstone write leaves every original and combined byte intact", async () => {
  const f = fixture();
  await f.imported();
  f.combined("combined", "first-id");
  const before = [...f.bodies];
  f.faults.sql = { pattern: /INSERT.*granola_deleted_meeting/i };
  const deleted = await store.deleteGranolaCsvMeeting(f.tcw, "first-id");
  expect(deleted.ok).toBe(false);
  expect(JSON.stringify(deleted)).not.toContain(storageError.message);
  expect(f.rows()).toEqual([["exo-merged", "combined"], ["granola", "first-id"], ["granola", "other-id"]]);
  expect([...f.bodies]).toEqual(before);
});

test("a failed transcript delete preserves the SQL row and tombstone, blocks reimport, and can be retried", async () => {
  const f = fixture();
  await f.imported();
  f.faults.kvDelete = true;
  const deleted = await store.deleteGranolaCsvMeeting(f.tcw, "first-id");
  expect(deleted.ok).toBe(false);
  expect(JSON.stringify(deleted)).not.toContain(storageError.message);
  expect(f.rows()).toEqual([["granola", "first-id"], ["granola", "other-id"]]);
  const repeated = await f.imported();
  expect(repeated.ok && repeated.data.skippedDeleted).toBe(1);
  // A missing body is an idempotent delete, not a reason to leave the SQL row behind.
  f.bodies.delete(store.transcriptKvKey("granola", "first-id"));
  expect(await store.deleteGranolaCsvMeeting(f.tcw, "first-id")).toEqual(ok({ unverifiedCombinedIds: [] }));
  expect(f.rows()).toEqual([["granola", "other-id"]]);
});

test("unreadable unrelated combined rows remain reported without blocking deletion of the original", async () => {
  const f = fixture();
  await f.imported();
  f.combined("unknown-members", null);
  f.combined("proven-reference", "first-id");
  const unknownBody = f.bodies.get(store.transcriptKvKey("exo-merged", "unknown-members"));
  f.faults.afterMeetingDelete = () => {
    f.faults.afterMeetingDelete = null;
    f.combined("late-unknown", null);
  };
  const deleted = await store.deleteGranolaCsvMeeting(f.tcw, "first-id");
  expect(deleted).toEqual(ok({ unverifiedCombinedIds: ["unknown-members", "late-unknown"] }));
  expect(f.rows()).toEqual([["exo-merged", "late-unknown"], ["exo-merged", "unknown-members"], ["granola", "other-id"]]);
  expect(f.bodies.get(store.transcriptKvKey("exo-merged", "unknown-members"))).toBe(unknownBody);
  expect(f.bodies.has(store.transcriptKvKey("exo-merged", "proven-reference"))).toBe(false);
  expect(f.bodies.has(store.transcriptKvKey("granola", "first-id"))).toBe(false);
  const repeated = await f.imported();
  expect(repeated.ok && repeated.data.skippedDeleted).toBe(1);
  expect(f.rows()).toEqual([["exo-merged", "late-unknown"], ["exo-merged", "unknown-members"], ["granola", "other-id"]]);
});

test("tombstone read errors, rejections, and corrupt timestamps never allow a Granola write", async () => {
  const f = fixture();
  await f.imported();
  await store.deleteGranolaCsvMeeting(f.tcw, "first-id");
  const normalized = await firstMeeting();
  for (const throws of [false, true]) {
    f.faults.sql = { pattern: /SELECT.*FROM granola_deleted_meeting/i, throws };
    const write = await store.upsertMeeting(f.tcw, normalized.meeting, normalized.sentences);
    expect(write.ok).toBe(false);
    expect(JSON.stringify(write)).not.toContain(storageError.message);
  }
  for (const rows of [{}, [null], [{}]]) {
    f.faults.tombstoneRows = rows;
    expect((await store.upsertMeeting(f.tcw, normalized.meeting, normalized.sentences)).ok).toBe(false);
  }
  f.faults.tombstoneRows = undefined;
  f.db.query("UPDATE granola_deleted_meeting SET created_at = 'corrupt'").run();
  expect((await store.upsertMeeting(f.tcw, normalized.meeting, normalized.sentences)).ok).toBe(false);
  expect(f.rows()).toEqual([["granola", "other-id"]]);
  expect(f.bodies.has(store.transcriptKvKey("granola", "first-id"))).toBe(false);
});

test("a late combined-copy failure is retryable even after the original SQL row is gone", async () => {
  const f = fixture();
  await f.imported();
  f.faults.afterMeetingDelete = () => {
    f.faults.afterMeetingDelete = null;
    f.combined("late-combined", "first-id");
    f.faults.sql = { pattern: /SELECT id, source_id, metadata FROM connector_meeting WHERE source = 'exo-merged'/i };
  };
  expect((await store.deleteGranolaCsvMeeting(f.tcw, "first-id")).ok).toBe(false);
  expect(f.rows()).toEqual([["exo-merged", "late-combined"], ["granola", "other-id"]]);
  expect(await store.deleteGranolaCsvMeeting(f.tcw, "first-id")).toEqual(ok({ unverifiedCombinedIds: [] }));
  expect(f.rows()).toEqual([["granola", "other-id"]]);
  expect(f.bodies.has(store.transcriptKvKey("exo-merged", "late-combined"))).toBe(false);
});

test("a failed allow-back clear keeps deleted IDs blocked", async () => {
  const f = fixture();
  await f.imported();
  await store.deleteGranolaCsvMeeting(f.tcw, "first-id");
  f.faults.sql = { pattern: /DELETE FROM granola_deleted_meeting/i };
  expect((await store.clearGranolaDeletedMeetings(f.tcw)).ok).toBe(false);
  const repeated = await f.imported();
  expect(repeated.ok && repeated.data.skippedDeleted).toBe(1);
  expect(f.rows()).toEqual([["granola", "other-id"]]);
});

test("a body write landing after another device deletes an updated Granola meeting is cleaned before success", async () => {
  const f = fixture();
  await f.imported();
  const original = f.db.query("SELECT id, created_at FROM connector_meeting WHERE source_id = 'first-id'").values()[0]!;
  const normalized = await firstMeeting();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  f.faults.beforeTranscriptPut = async () => {
    f.faults.beforeTranscriptPut = null;
    entered.resolve();
    await release.promise;
  };
  const pending = store.upsertMeeting(f.tcw, { ...normalized.meeting, title: "New API title", metadata: { granola_updated_at: "2026-11-19T23:00:00Z" } }, normalized.sentences);
  await entered.promise;
  try {
    expect(await store.deleteGranolaCsvMeeting(f.tcw, "first-id")).toEqual(ok({ unverifiedCombinedIds: [] }));
  } finally {
    release.resolve();
  }
  expect(await pending).toEqual(ok({ id: original[0], createdAt: original[1], inserted: false, skippedDeleted: true }));
  expect(f.rows()).toEqual([["granola", "other-id"]]);
  expect(f.bodies.has(store.transcriptKvKey("granola", "first-id"))).toBe(false);
});

test("an insertion whose initial lookup predates a concurrent import and delete cannot recreate that meeting", async () => {
  const f = fixture();
  const normalized = await firstMeeting();
  let original: SQLQueryBindings[] = [];
  f.faults.beforeMeetingInsert = async () => {
    f.faults.beforeMeetingInsert = null;
    await f.imported();
    original = f.db.query("SELECT id, created_at FROM connector_meeting WHERE source_id = 'first-id'").values()[0]!;
    expect(await store.deleteGranolaCsvMeeting(f.tcw, "first-id")).toEqual(ok({ unverifiedCombinedIds: [] }));
  };
  const write = await store.upsertMeeting(f.tcw, { ...normalized.meeting, id: "late-insert-id" }, normalized.sentences);
  expect(write).toEqual(ok({ id: original[0], createdAt: original[1], inserted: false, skippedDeleted: true }));
  expect(f.rows()).toEqual([["granola", "other-id"]]);
  expect(f.bodies.has(store.transcriptKvKey("granola", "first-id"))).toBe(false);
});

test("post-write cleanup errors remain failures and a marked initial upsert retries cleanup", async () => {
  const f = fixture();
  await f.imported();
  const normalized = await firstMeeting();
  f.faults.beforeTranscriptPut = async () => {
    f.faults.beforeTranscriptPut = null;
    await store.deleteGranolaCsvMeeting(f.tcw, "first-id");
    f.faults.kvDelete = true;
  };
  const failed = await store.upsertMeeting(f.tcw, normalized.meeting, normalized.sentences);
  expect(failed.ok).toBe(false);
  expect(JSON.stringify(failed)).not.toContain(storageError.message);
  expect(f.bodies.has(store.transcriptKvKey("granola", "first-id"))).toBe(true);
  const retry = await store.upsertMeeting(f.tcw, normalized.meeting, normalized.sentences);
  expect(retry.ok && retry.data.skippedDeleted).toBe(true);
  expect(f.rows()).toEqual([["granola", "other-id"]]);
  expect(f.bodies.has(store.transcriptKvKey("granola", "first-id"))).toBe(false);
});

test("freshness lookup retries marked row cleanup instead of returning an unchanged API timestamp", async () => {
  const f = fixture();
  await f.imported();
  const timestamp = "2026-11-19T23:00:00Z";
  f.db.query("UPDATE connector_meeting SET metadata = ? WHERE source_id = 'first-id'").run(JSON.stringify({ imported_from: "granola_csv", granola_updated_at: timestamp }));
  f.faults.kvDelete = true;
  expect((await store.deleteGranolaCsvMeeting(f.tcw, "first-id")).ok).toBe(false);
  f.faults.kvDelete = true;
  const failed = await store.listMeetingMetadataValues(f.tcw, "granola", "granola_updated_at");
  expect(failed.ok).toBe(false);
  expect(f.rows()).toEqual([["granola", "first-id"], ["granola", "other-id"]]);
  const retried = await store.listMeetingMetadataValues(f.tcw, "granola", "granola_updated_at");
  expect(retried).toEqual(ok({ "other-id": null }));
  expect(f.rows()).toEqual([["granola", "other-id"]]);
  expect(f.bodies.has(store.transcriptKvKey("granola", "first-id"))).toBe(false);
});

test("combined-member transport errors preserve the original instead of becoming unknown-member warnings", async () => {
  for (const kind of ["result", "rejection", "missing-space"] as const) {
    const f = fixture();
    await f.imported();
    f.combined("unknown-members", null);
    f.faults.combinedReadFailure = kind;
    const failed = await store.deleteGranolaCsvMeeting(f.tcw, "first-id");
    expect(failed.ok).toBe(false);
    expect(JSON.stringify(failed)).not.toContain(storageError.message);
    expect(f.rows()).toEqual([["exo-merged", "unknown-members"], ["granola", "first-id"], ["granola", "other-id"]]);
    expect(f.bodies.has(store.transcriptKvKey("granola", "first-id"))).toBe(true);
  }
});

test("sweeping cannot delete a combined meeting when its body sources could not be read", async () => {
  const f = fixture();
  await f.imported();
  f.combined("combined", "missing-member");
  f.faults.combinedReadFailure = "rejection";
  expect(await sweepCombinedMeeting(f.tcw, "combined")).toEqual(ok({ status: "unverified" }));
  expect(f.rows()).toEqual([["exo-merged", "combined"], ["granola", "first-id"], ["granola", "other-id"]]);
  expect(f.bodies.has(store.transcriptKvKey("exo-merged", "combined"))).toBe(true);
});
