import { test, expect } from "bun:test";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { TinyCloudNode } from "@tinycloud/node-sdk";
import { CONNECTORS_SQL_DB_NAME, ensureSchema } from "../../frontend/src/lib/connectors/connectorStore";
import { SQL_MEETING_METADATA_QUERY } from "../../frontend/src/lib/meetingChat/corpus";
import { ensureVoiceNoteIdentity, TRANSCRIPT_TABLE_DDL, VOICE_NOTE_INDEX_DDL,
  commitVoiceNoteTranscript, reconcileDuplicates, transcriptHash } from "../../frontend/src/lib/voiceNotes/voiceNoteRows";
import { readTranscriptCommit } from "../../frontend/src/lib/voiceNotes/voiceNoteCommits";

const host = process.env.TINYCLOUD_HOST;
const manifest = JSON.parse(readFileSync(new URL("../../manifest.json", import.meta.url), "utf8"));
const key = `0x${randomBytes(32).toString("hex")}`;
const prefix = `exo-t18-${randomBytes(5).toString("hex")}`;

async function signedIn(grant: typeof manifest) {
  const node = new TinyCloudNode({ privateKey: key, host, prefix, manifest: grant,
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
else test("voice-note identity, commit CAS, legacy discovery, and missing schema grant", async () => {
  const node = await signedIn(manifest);
  const schema = await ensureSchema(node as never);
  expect(schema.ok).toBe(true);
  await seed(node, "legacy-b", "dup");
  await seed(node, "legacy-a", "dup", JSON.stringify({ transcription_outcome: "transcribed",
    transcript_text: "Hello", transcribed_at: "2026-01-01T00:00:00.000Z" }));
  await seed(node, "race-c", "race");
  await seed(node, "race-a", "race");
  await seed(node, "race-b", "race");
  await Promise.all([reconcileDuplicates(node as never), reconcileDuplicates(node as never)]);
  const identity = await ensureVoiceNoteIdentity(node as never);
  expect(identity).toEqual({ status: "established" });
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
  expect(await select(node, "SELECT id FROM connector_meeting WHERE source = 'exo-voice-note' AND source_id = 'race'")).toHaveLength(1);
  expect(await select(node, "SELECT id FROM connector_meeting WHERE source = 'exo-voice-note-dup' AND source_id = 'race'")).toHaveLength(2);
  const late = await sql(node).execute(`INSERT INTO connector_meeting
    (id, source, source_id, created_at, updated_at) VALUES ('late', 'exo-voice-note', 'dup', ?, ?)`, [new Date().toISOString(), new Date().toISOString()]);
  expect(late.ok).toBe(false);
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
  await reconcileDuplicates(node as never);
  const oldManifest = structuredClone(manifest);
  oldManifest.permissions = oldManifest.permissions.map((permission: { service: string; path: string; actions: string[] }) =>
    permission.service === "tinycloud.sql" && permission.path === "connectors"
      ? { ...permission, actions: permission.actions.filter((action) => action !== "schema") } : permission);
  const oldSession = await signedIn(oldManifest);
  expect((await ensureVoiceNoteIdentity(oldSession as never)).status).toBe("needs_authorization");
});
