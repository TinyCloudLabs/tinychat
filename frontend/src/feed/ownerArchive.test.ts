import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type { FeedDatabase, FeedSource } from "@tinycloud/sdk-services/feed";
import { prepareSitrepImport, type PrepareSitrepImportInput } from "@tinyboilerplate/core/feed/sitrep";
import { archivePreparedOwnerBundle, OwnerArchiveCache, OWNER_IMPORT_SCHEMA, ownerCardKey } from "./sitrepArchiveStore";
import { SITREP_NOW, syntheticRecord } from "./sitrep.fixtures";

const source: FeedSource = { sourceId: "archive", agentDid: "did:key:isolated-archive", label: "Archive test", output: { spaceId: "isolated-owner", database: "xyz.tinycloud.tinychat/feed/feed_output_archive" }, responses: { spaceId: "isolated-owner", database: "xyz.tinycloud.tinychat/feed/feed_responses_archive" } };
const identity = { cardId: "archived-task", revision: 1, issuanceId: "archived-task-issuance" };
const cardKey = "xyz.tinycloud.rocinante/board/task/task-synthetic.json";
const stateKey = "xyz.tinycloud.rocinante/sam/state/task/task-synthetic.json";
function row(sourceKey: string, value: unknown) { const bytes = Buffer.from(JSON.stringify(value)); return { sourceKey, sourceArea: "kv" as const, encoding: "base64" as const, rawBase64: bytes.toString("base64"), sha256: createHash("sha256").update(bytes).digest("hex") }; }
function input(): PrepareSitrepImportInput { return {
  source: { spaceId: "isolated-legacy-space", namespace: "xyz.tinycloud.rocinante/", snapshotId: "root-snapshot", completePrefixSnapshot: false }, frozenAt: SITREP_NOW,
  rows: [row(cardKey, syntheticRecord("task")), row(stateKey, { kind: "task", id: "task-synthetic", steps: { verify: SITREP_NOW }, updatedAt: SITREP_NOW })],
  publishers: [{ publisherId: "legacy", agentId: source.sourceId, agentDid: source.agentDid, outputResource: source.output.database, responseResource: source.responses.database }],
  publisherBindings: [{ sourceKey: cardKey, publisherId: "legacy", identity }], recipients: [],
}; }
function handle(database: Database): FeedDatabase {
  const execute: FeedDatabase["execute"] = async (sql, params = []) => { const result = database.query(sql).run(...params); return { ok: true, data: { changes: result.changes, lastInsertRowId: Number(result.lastInsertRowid) } }; };
  return { execute, query: async <T>(sql: string, params: (string | number | null | Uint8Array)[] = []) => { const query = database.query(sql); const rows = query.values(...params) as T[][]; return { ok: true, data: { columns: query.columnNames, rows, rowCount: rows.length } }; }, async batch(statements) { database.exec("BEGIN"); try { const results = []; for (const statement of statements) { const result = await execute(statement.sql, statement.params); if (!result.ok) throw new Error("SQLite batch failed"); results.push(result.data); } database.exec("COMMIT"); return { ok: true, data: { results } }; } catch (error) { database.exec("ROLLBACK"); throw error; } } };
}

test("owner SQLite applies only the causal head and never resurrects explicitly deleted state from retained archives", async () => {
  const sqlite = new Database(":memory:");
  try {
    sqlite.exec(OWNER_IMPORT_SCHEMA); const database = handle(sqlite); const cache = new OwnerArchiveCache(database);
    const initial = input(); const first = await prepareSitrepImport(initial);
    await archivePreparedOwnerBundle(database, first);
    expect((await cache.load([source])).owners.get(ownerCardKey(source.sourceId, identity))?.states[0]?.steps.verify).toBe(SITREP_NOW);
    const second = await prepareSitrepImport({ ...initial, source: { ...initial.source, snapshotId: "child-snapshot" }, rows: [], previous: first, deletions: [{ sourceKey: stateKey, classification: "owner-state", deletedAt: SITREP_NOW }] });
    await archivePreparedOwnerBundle(database, second);
    expect((await cache.load([source])).owners.get(ownerCardKey(source.sourceId, identity))?.states).toEqual([]);
    expect(sqlite.query("SELECT bundle_json FROM feed_owner_imports WHERE snapshot_id=?").get("root-snapshot")).toEqual({ bundle_json: JSON.stringify(first) });
    await archivePreparedOwnerBundle(database, second);
    await expect(archivePreparedOwnerBundle(database, { ...second, frozenAt: "2026-10-30T12:00:00.000Z" })).rejects.toThrow("different bytes");
  } finally { sqlite.close(); }
});

test("missing causal predecessors and ambiguous source forks are explicit errors, never timestamp-selected latest state", async () => {
  const sqlite = new Database(":memory:");
  try {
    sqlite.exec(OWNER_IMPORT_SCHEMA); const database = handle(sqlite);
    const initial = input(); const first = await prepareSitrepImport(initial);
    const second = await prepareSitrepImport({ ...initial, source: { ...initial.source, snapshotId: "branch-a" }, rows: [], previous: first });
    await expect(archivePreparedOwnerBundle(database, second)).rejects.toThrow("predecessor");
    await archivePreparedOwnerBundle(database, first); await archivePreparedOwnerBundle(database, second);
    const fork = await prepareSitrepImport({ ...initial, source: { ...initial.source, snapshotId: "branch-b" }, rows: [], previous: first });
    await archivePreparedOwnerBundle(database, fork);
    await expect(new OwnerArchiveCache(database).load([source])).rejects.toThrow("causal head");
  } finally { sqlite.close(); }
});

test("a mutable state reset keeps historical outbound notes and commands separate from current private state", async () => {
  const sqlite = new Database(":memory:");
  try {
    sqlite.exec(OWNER_IMPORT_SCHEMA); const database = handle(sqlite); const cache = new OwnerArchiveCache(database);
    const initial = input();
    initial.rows = [row(cardKey, syntheticRecord("task")), row(stateKey, { kind: "task", id: "task-synthetic", steps: { verify: SITREP_NOW }, doneAt: SITREP_NOW, notes: [{ id: "legacynote0001", at: SITREP_NOW, text: "The explicit historical note to the task owner." }], updatedAt: SITREP_NOW })];
    const first = await prepareSitrepImport(initial);
    const command = first.ownerResponses.find((event) => event.ownerEventKind === "state");
    const note = first.ownerResponses.find((event) => event.ownerEventKind === "note");
    if (!command || !note) throw new Error("Synthetic explicit command and note were not prepared");
    await archivePreparedOwnerBundle(database, first);
    const next = await prepareSitrepImport({ ...initial, source: { ...initial.source, snapshotId: "state-reset" }, rows: [row(stateKey, { kind: "task", id: "task-synthetic", steps: { verify: null }, updatedAt: SITREP_NOW })], previous: first });
    await archivePreparedOwnerBundle(database, next);
    const projected = await cache.load([source]);
    const key = ownerCardKey(source.sourceId, identity);
    expect(projected.owners.get(key)?.states[0]).toMatchObject({ steps: { verify: null } });
    expect(projected.owners.get(key)?.states[0]?.doneAt).toBeUndefined();
    expect(projected.owners.get(key)?.states[0]?.notes).toBeUndefined();
    expect(projected.owners.get(key)?.outboundNotes).toContainEqual(expect.objectContaining({ responseId: note.response.responseId, type: "note", text: "The explicit historical note to the task owner.", unresolvedRecipients: ["SyntheticOwner"] }));
    expect(projected.historicalCommands.get(key)).toContainEqual(expect.objectContaining({ responseId: command.response.responseId, state: expect.objectContaining({ doneAt: SITREP_NOW }) }));
    expect(projected.owners.get(key)?.commands).toBeUndefined();
    expect(projected.routes.get(key)?.unresolved).toEqual(["SyntheticOwner"]);
    expect(next.ownerResponses).toEqual([]);
  } finally { sqlite.close(); }
});
