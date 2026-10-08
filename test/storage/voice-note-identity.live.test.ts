import { test, expect } from "bun:test";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { TinyCloudNode } from "@tinycloud/node-sdk";
import { CONNECTORS_SQL_DB_NAME, ensureSchema } from "../../frontend/src/lib/connectors/connectorStore";
import { SQL_MEETING_METADATA_QUERY } from "../../frontend/src/lib/meetingChat/corpus";
import { ensureVoiceNoteIdentity, TRANSCRIPT_TABLE_DDL, VOICE_NOTE_INDEX_DDL,
  commitVoiceNoteTranscript, createVoiceNoteRow, patchVoiceNoteAudio, reconcileDuplicates, transcriptHash } from "../../frontend/src/lib/voiceNotes/voiceNoteRows";
import { readTranscriptCommit } from "../../frontend/src/lib/voiceNotes/voiceNoteCommits";

const host = process.env.TINYCLOUD_HOST;
const manifest = JSON.parse(readFileSync(new URL("../../manifest.json", import.meta.url), "utf8"));
const key = `0x${randomBytes(32).toString("hex")}`;
const prefix = `exo-t18-${randomBytes(5).toString("hex")}`;

async function signedIn(grant: typeof manifest, credentials: { privateKey: string; prefix: string } = { privateKey: key, prefix }) {
  const node = new TinyCloudNode({ ...credentials, host, manifest: grant,
    autoCreateSpace: true, autoDiscoverLocalNode: false, autoBootstrapAccount: false });
  await node.signIn();
  return node;
}

const sql = (node: TinyCloudNode) => node.sql.db(CONNECTORS_SQL_DB_NAME);
async function run(node: TinyCloudNode, statement: string, params: unknown[] = []) {
  const result = await sql(node).execute(statement, params as never[]);
  if (!result.ok) throw new Error(`${statement}: ${result.error.message}`);
  return result;
}
async function select(node: TinyCloudNode, statement: string, params: unknown[] = []) {
  const result = await sql(node).query(statement, params as never[]);
  if (!result.ok) throw new Error(`${statement}: ${result.error.message}`);
  return result.data.rows as unknown[][];
}
async function seed(node: TinyCloudNode, id: string, sourceId: string, metadata = "{}") {
  const at = new Date().toISOString();
  await run(node, `INSERT INTO connector_meeting (id, source, source_id, title, started_at,
    duration_secs, participants, metadata, created_at, updated_at)
    VALUES (?, 'exo-voice-note', ?, ?, ?, 2, '[]', ?, ?, ?)`, [id, sourceId, id, at, metadata, at, at]);
}

if (!host) test.skip("V-NODE requires TINYCLOUD_HOST", () => {});
else test("voice-note identity gate repairs a failed unique index, then create, audio, commit and discovery work", async () => {
  const node = await signedIn(manifest);
  const schema = await ensureSchema(node as never);
  expect(schema.ok).toBe(true);
  await seed(node, "legacy-b", "dup", JSON.stringify({ source_note: "b-preserved" }));
  await seed(node, "legacy-a", "dup", JSON.stringify({ transcription_outcome: "transcribed",
    transcript_text: "Hello", transcribed_at: "2026-01-01T00:00:00.000Z", owner_note: "preserved" }));
  await seed(node, "legacy-positive", "legacy-positive", JSON.stringify({ transcription_outcome: "transcribed",
    transcript_text: "Legacy transcript", transcribed_at: "2026-02-01T00:00:00.000Z" }));
  await seed(node, "commit-positive", "commit-positive");
  const originalDb = node.sql.db.bind(node.sql);
  let indexFailures = 0;
  node.sql.db = ((name: string) => {
    const database = originalDb(name);
    return { query: database.query.bind(database), execute: async (statement: string, params: unknown[] = []) => {
      const result = await database.execute(statement, params as never[]);
      if (statement === VOICE_NOTE_INDEX_DDL && !result.ok) {
        expect(result.error.message).toMatch(/UNIQUE constraint failed/i);
        indexFailures++;
      }
      return result;
    } };
  }) as typeof node.sql.db;
  const identity = await ensureVoiceNoteIdentity(node as never);
  expect(identity).toEqual({ status: "established" });
  expect(indexFailures).toBeGreaterThanOrEqual(1);
  const ddl = await select(node, "SELECT name, sql FROM sqlite_schema WHERE name IN ('voice_note_transcript', 'uq_connector_meeting_voice_note')");
  expect(ddl).toHaveLength(2);
  const normalized = (s: string) => s.replace(/\bIF NOT EXISTS\s+/i, "").replace(/\s+/g, " ").trim();
  expect(new Map(ddl.map(([name, definition]) => [name, normalized(String(definition))]))).toEqual(new Map([
    ["voice_note_transcript", normalized(TRANSCRIPT_TABLE_DDL)],
    ["uq_connector_meeting_voice_note", normalized(VOICE_NOTE_INDEX_DDL)],
  ]));
  const pragma = await sql(node).query("PRAGMA index_list('connector_meeting')", []);
  expect(pragma.ok).toBe(false);
  expect(await select(node, "SELECT id FROM connector_meeting WHERE source = 'exo-voice-note' AND source_id = 'dup'")).toHaveLength(1);
  expect(await select(node, "SELECT id FROM connector_meeting WHERE source = 'exo-voice-note-dup' AND source_id = 'dup'")).toHaveLength(1);
  const archived = await select(node, "SELECT metadata, updated_at FROM connector_meeting WHERE id = 'legacy-b'");
  const archivedMetadata = JSON.parse(String(archived[0]?.[0])) as Record<string, unknown>;
  expect(archivedMetadata.dup_of).toBe("legacy-a");
  expect(archivedMetadata.merged_at).toBe(archived[0]?.[1]);
  expect(archivedMetadata.source_note).toBe("b-preserved");
  expect(archivedMetadata.transcription_outcome).toBeUndefined();
  const liveMetadata = JSON.parse(String((await select(node, "SELECT metadata FROM connector_meeting WHERE id = 'legacy-a'"))[0]?.[0]));
  expect(liveMetadata.owner_note).toBe("preserved");
  expect(liveMetadata.source_note).toBe("b-preserved");
  const late = await sql(node).execute(`INSERT INTO connector_meeting
    (id, source, source_id, created_at, updated_at) VALUES ('late', 'exo-voice-note', 'dup', ?, ?)`, [new Date().toISOString(), new Date().toISOString()]);
  expect(late.ok).toBe(false);
  if (!late.ok) expect(late.error.message).toMatch(/UNIQUE constraint failed/i);
  const recording = { id: "created", startedAt: Date.now(), durationMs: 2500, mimeType: "audio/mp4",
    sizeBytes: 4, silencedMs: 0, silencedEvents: 0, noSignalMs: 0 };
  expect(await createVoiceNoteRow(node as never, recording, "Created note")).toMatchObject({ id: "vn-created", inserted: true });
  expect(await createVoiceNoteRow(node as never, recording, "Created note")).toMatchObject({ id: "vn-created", inserted: false });
  await seed(node, "random-old-id", "old-id");
  expect(await createVoiceNoteRow(node as never, { ...recording, id: "old-id" }, "Old note"))
    .toMatchObject({ id: "random-old-id", inserted: false });
  await patchVoiceNoteAudio(node as never, recording, "android", { base: "audio-parts", mimeType: "audio/mp4", size: 4, parts: 1 });
  const createdMetadata = JSON.parse(String((await select(node, "SELECT metadata FROM connector_meeting WHERE id = 'vn-created'"))[0]?.[0]));
  expect(createdMetadata).toMatchObject({ audio_kv_key: "audio-parts", audio_parts: 1,
    capture: { platform: "android", duration_ms: 2500 } });
  await commitVoiceNoteTranscript(node as never, "commit-positive", { rev: 1, outcome: "transcribed",
    sentences: [{ index: 0, speaker_name: "You", text: "Committed words", start_time: 0, end_time: 1 }], text: "Committed words" });
  const admitted = await select(node, SQL_MEETING_METADATA_QUERY);
  expect(admitted.some((row) => row[2] === "legacy-positive")).toBe(true);
  expect(admitted.some((row) => row[2] === "commit-positive")).toBe(true);
  expect(admitted.some((row) => row[2] === "dup")).toBe(true);
  expect(admitted.some((row) => row[0] === "legacy-b")).toBe(false);
  const saved = await commitVoiceNoteTranscript(node as never, "dup", { rev: 2, outcome: "transcribed",
    sentences: [{ index: 0, speaker_name: "You", text: "New body", start_time: 0, end_time: 1 }], text: "New body" });
  let contender: { index: number; speaker_name: string; text: string; start_time: number; end_time: number }[] = [];
  for (let n = 0; n < 100; n++) {
    const candidate = [{ index: 0, speaker_name: "You", text: `Equal revision ${n}`, start_time: 0, end_time: 1 }];
    if (await transcriptHash(candidate) > saved.hash) { contender = candidate; break; }
  }
  expect(contender).not.toHaveLength(0);
  const equalWinner = await commitVoiceNoteTranscript(node as never, "dup", { rev: 2, outcome: "transcribed",
    sentences: contender, text: contender[0].text });
  expect(equalWinner.hash).toBe(await transcriptHash(contender));
  await commitVoiceNoteTranscript(node as never, "dup", { rev: 1, outcome: "no_speech", sentences: [], text: null });
  expect((await readTranscriptCommit(node as never, "dup"))?.hash).toBe(equalWinner.hash);
  const newer = await commitVoiceNoteTranscript(node as never, "dup", { rev: 3, outcome: "no_speech", sentences: [], text: null });
  expect((await readTranscriptCommit(node as never, "dup"))?.rev).toBe(3);
  expect(newer.preview).toBeNull();
  expect((await select(node, SQL_MEETING_METADATA_QUERY)).some((r) => r[2] === "dup")).toBe(false);
  const oldManifest = structuredClone(manifest);
  oldManifest.permissions = oldManifest.permissions.map((permission: { service: string; path: string; actions: string[] }) =>
    permission.service === "tinycloud.sql" && permission.path === "connectors"
      ? { ...permission, actions: permission.actions.filter((action) => action !== "schema") } : permission);
  const oldSession = await signedIn(oldManifest);
  expect((await ensureVoiceNoteIdentity(oldSession as never)).status).toBe("needs_authorization");
}, 120_000);

if (host) test("two SDK sessions see different keepers and a stale keeper cannot archive a live row", async () => {
  const credentials = { privateKey: `0x${randomBytes(32).toString("hex")}`,
    prefix: `exo-t18-race-${randomBytes(5).toString("hex")}` };
  const first = await signedIn(manifest, credentials);
  const second = await signedIn(manifest, credentials);
  expect((await ensureSchema(first as never)).ok).toBe(true);
  await seed(first, "race-b", "race", JSON.stringify({ note: "b" }));
  await seed(first, "race-c", "race", JSON.stringify({ note: "c" }));
  const secondDb = second.sql.db.bind(second.sql);
  let observedSecond: unknown[][] = [];
  second.sql.db = ((name: string) => {
    const database = secondDb(name);
    return { execute: database.execute.bind(database), query: async (statement: string, params: unknown[] = []) => {
      const result = await database.query(statement, params as never[]);
      if (statement.includes("GROUP BY source_id HAVING COUNT(*) > 1") && result.ok && observedSecond.length === 0)
        observedSecond = result.data.rows as unknown[][];
      return result;
    } };
  }) as typeof second.sql.db;
  const originalDb = first.sql.db.bind(first.sql);
  let observedFirst: unknown[][] = [];
  let reached!: () => void;
  const observed = new Promise<void>((resolve) => { reached = resolve; });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let guardedSkips = 0;
  first.sql.db = ((name: string) => {
    const database = originalDb(name);
    return { execute: async (statement: string, params: unknown[] = []) => {
      const result = await database.execute(statement, params as never[]);
      if (statement.includes("SET source = 'exo-voice-note-dup'") && params[2] === "race-c"
        && result.ok && result.data.changes === 0) guardedSkips++;
      return result;
    }, query: async (statement: string, params: unknown[] = []) => {
      const result = await database.query(statement, params as never[]);
      if (statement.includes("GROUP BY source_id HAVING COUNT(*) > 1") && result.ok && observedFirst.length === 0)
        observedFirst = result.data.rows as unknown[][];
      if (statement.includes("SELECT id FROM connector_meeting WHERE source = 'exo-voice-note' AND source_id = ?")) {
        reached();
        await gate;
      }
      return result;
    } };
  }) as typeof first.sql.db;
  const a = reconcileDuplicates(first as never, undefined, false);
  await observed;
  await seed(second, "race-a", "race", JSON.stringify({ note: "a" }));
  // This independent session archives the old keeper while the first client still holds its
  // observed (race-b, race-c) group. Its pending attempt on race-c must change zero rows.
  await run(second, `UPDATE connector_meeting SET source = 'exo-voice-note-dup',
    metadata = json_set(COALESCE(metadata,'{}'), '$.dup_of', 'race-a', '$.archived_at', ?)
    WHERE id = 'race-b' AND source = 'exo-voice-note'`, [new Date().toISOString()]);
  release();
  await a;
  expect(guardedSkips).toBe(1);
  expect(await select(second, "SELECT id FROM connector_meeting WHERE id = 'race-c' AND source = 'exo-voice-note'"))
    .toEqual([["race-c"]]);
  await reconcileDuplicates(second as never);
  expect(observedFirst).toEqual([["race", "race-b"]]);
  expect(observedSecond).toEqual([["race", "race-a"]]);
  expect(await select(second, "SELECT id FROM connector_meeting WHERE source = 'exo-voice-note' AND source_id = 'race'"))
    .toHaveLength(1);
  const siblings = await select(second, "SELECT id, metadata FROM connector_meeting WHERE source = 'exo-voice-note-dup' AND source_id = 'race'");
  expect(siblings).toHaveLength(2);
  expect(siblings.map((row) => JSON.parse(String(row[1])).note).sort()).toEqual(["b", "c"]);
  expect((await ensureVoiceNoteIdentity(second as never)).status).toBe("established");
}, 120_000);
