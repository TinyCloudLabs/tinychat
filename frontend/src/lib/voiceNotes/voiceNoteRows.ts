import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import type { FirefliesSentence } from "../connectors/firefliesClient";
import { CONNECTORS_KV_PREFIX, CONNECTORS_SQL_DB_NAME, ensureSchema, transcriptKvKey } from "../connectors/connectorStore";
import { runOnSpaceLane } from "../spaceWriteLane";
import type { VoiceNoteRecording } from "./nativeVoiceNotes";
import { LEGACY_TRANSCRIPT_KEYS, legacyTranscriptWinner, readTranscriptCommit, type TranscriptCommit } from "./voiceNoteCommits";

export const TRANSCRIPT_TABLE_DDL = `CREATE TABLE IF NOT EXISTS voice_note_transcript (
  source_id TEXT PRIMARY KEY, rev INTEGER NOT NULL, hash TEXT NOT NULL, body_key TEXT NOT NULL,
  outcome TEXT NOT NULL, preview TEXT, engine TEXT, provider TEXT, model TEXT, language TEXT,
  speaker_labels INTEGER, participants TEXT, transcribed_at TEXT, committed_at TEXT NOT NULL)`;
export const VOICE_NOTE_INDEX_DDL = "CREATE UNIQUE INDEX IF NOT EXISTS uq_connector_meeting_voice_note ON connector_meeting(source_id) WHERE source = 'exo-voice-note'";
export type VoiceNoteIdentity = "established" | "needs_authorization" | "blocked" | "retry" | "storage_full";
export interface IdentityResult { status: VoiceNoteIdentity; reason?: string }

function db(tcw: TinyCloudWeb) { return tcw.sql.db(CONNECTORS_SQL_DB_NAME); }
function errorOf(result: { ok: boolean; error?: { code?: string; message?: string; meta?: unknown; requiredAction?: unknown } }): Error {
  const e = result.error;
  return Object.assign(new Error(e?.message ?? "TinyCloud storage failed"), {
    code: e?.code ?? "STORE_ERROR", meta: e?.meta, requiredAction: e?.requiredAction,
  });
}
async function query(tcw: TinyCloudWeb, sql: string, params: unknown[] = [], checkpoint: () => void = () => undefined): Promise<unknown[][]> {
  const result = await runOnSpaceLane(() => { checkpoint(); return db(tcw).query(sql, params as never[]); });
  if (!result.ok) throw errorOf(result);
  return result.data.rows as unknown[][];
}
async function execute(tcw: TinyCloudWeb, sql: string, params: unknown[] = [], checkpoint: () => void = () => undefined): Promise<number> {
  const result = await runOnSpaceLane(() => { checkpoint(); return db(tcw).execute(sql, params as never[]); });
  if (!result.ok) throw errorOf(result);
  return Number((result.data as { changes?: number }).changes ?? 0);
}
function normalizedStoredDDL(ddl: string): string {
  return ddl.replace(/\bIF NOT EXISTS\s+/i, "").replace(/\s+/g, " ").trim();
}
function isAuthorization(e: unknown): boolean {
  const x = e as { code?: string; message?: string; requiredAction?: unknown;
    meta?: { status?: number; requiredAction?: unknown; required_action?: unknown } };
  return x.meta?.status === 401 || x.meta?.status === 403 || x.meta?.requiredAction !== undefined
    || x.meta?.required_action !== undefined || x.requiredAction !== undefined
    || /AUTH|CAPABILITY|UNAUTHORIZED|FORBIDDEN/i.test(x.code ?? "");
}
function isConstraint(e: unknown): boolean {
  const x = e as { code?: string; message?: string };
  return /UNIQUE|CONSTRAINT/i.test(`${x.code ?? ""} ${x.message ?? ""}`);
}
function identityFailure(e: unknown): IdentityResult {
  if (isAuthorization(e)) return { status: "needs_authorization", reason: String(e) };
  const detail = `${(e as { code?: string }).code ?? ""} ${(e as { message?: string }).message ?? ""}`;
  if (/QUOTA|STORAGE.*(FULL|GROW)|SPACE.*FULL/i.test(detail))
    return { status: "storage_full", reason: "Your TinyCloud storage is full; this note remains on your phone" };
  return { status: "retry", reason: String(e) };
}
const identityInFlight = new WeakMap<TinyCloudWeb, { key: string; promise: Promise<IdentityResult>;
  checkpoints: Set<() => void> }>();
const identityReady = new WeakMap<TinyCloudWeb, string>();
function identityKey(tcw: TinyCloudWeb): string { return JSON.stringify([tcw.did, tcw.spaceId]); }

/** DDL requires the manifest's schema grant; an older delegation is a sign-in state. */
export function ensureVoiceNoteIdentity(tcw: TinyCloudWeb, checkpoint: () => void = () => undefined): Promise<IdentityResult> {
  checkpoint();
  const key = identityKey(tcw);
  if (identityReady.get(tcw) === key) return Promise.resolve({ status: "established" });
  const existing = identityInFlight.get(tcw);
  if (existing?.key === key) {
    existing.checkpoints.add(checkpoint);
    return existing.promise.then((result) => { checkpoint(); return result; });
  }
  const checkpoints = new Set([checkpoint]);
  const checkCallers = () => {
    let cancelled: unknown;
    for (const check of checkpoints) {
      try { check(); return; }
      catch (error) { cancelled = error; checkpoints.delete(check); }
    }
    throw cancelled ?? new Error("Voice-note identity has no active caller");
  };
  const pending = establish(tcw, key, checkCallers).finally(() => {
    if (identityInFlight.get(tcw)?.promise === pending) identityInFlight.delete(tcw);
  });
  identityInFlight.set(tcw, { key, promise: pending, checkpoints });
  return pending.then((result) => { checkpoint(); return result; });
}
async function establish(tcw: TinyCloudWeb, key: string, checkpoint: () => void): Promise<IdentityResult> {
  let schema: Awaited<ReturnType<typeof ensureSchema>>;
  try { schema = await ensureSchema(tcw, checkpoint); checkpoint(); }
  catch (e) { return identityFailure(e); }
  if (!schema.ok) return identityFailure(schema.error);
  for (let round = 0; round < 3; round++) {
    try {
      await execute(tcw, TRANSCRIPT_TABLE_DDL, [], checkpoint);
      await execute(tcw, VOICE_NOTE_INDEX_DDL, [], checkpoint);
      const definitions = await query(tcw,
        "SELECT type, name, sql FROM sqlite_schema WHERE name IN ('voice_note_transcript', 'uq_connector_meeting_voice_note')", [], checkpoint);
      const wanted = new Map([["voice_note_transcript", ["table", TRANSCRIPT_TABLE_DDL]],
        ["uq_connector_meeting_voice_note", ["index", VOICE_NOTE_INDEX_DDL]]]);
      if (definitions.length !== 2 || definitions.some(([type, name, sql]) => {
        const expected = wanted.get(String(name));
        return !expected || type !== expected[0] || normalizedStoredDDL(String(sql)) !== normalizedStoredDDL(expected[1]);
      })) return { status: "blocked", reason: "Unexpected voice-note schema definition" };
      await sweepArchived(tcw, checkpoint);
      if (identityKey(tcw) !== key) return { status: "retry", reason: "Voice-note space changed during identity check" };
      identityReady.set(tcw, key);
      return { status: "established" };
    } catch (e) {
      if (!isConstraint(e)) return identityFailure(e);
      try { await reconcileDuplicates(tcw, checkpoint); }
      catch (reconcileError) { return identityFailure(reconcileError); }
      if (round === 2) return { status: "blocked", reason: "Voice-note duplicates persisted after three archive rounds" };
    }
  }
  return { status: "blocked" };
}

/** Archive only a row whose observed keeper is still live. */
export async function reconcileDuplicates(tcw: TinyCloudWeb, checkpoint: () => void = () => undefined, sweep = true): Promise<void> {
  const groups = await query(tcw, `SELECT source_id, MIN(id) AS keeper FROM connector_meeting
    WHERE source = 'exo-voice-note' GROUP BY source_id HAVING COUNT(*) > 1`, [], checkpoint);
  for (const [sourceId, keeper] of groups) {
    const rows = await query(tcw, "SELECT id FROM connector_meeting WHERE source = 'exo-voice-note' AND source_id = ? ORDER BY id", [sourceId], checkpoint);
    for (const [id] of rows) {
      if (id === keeper) continue;
      const changes = await execute(tcw, `UPDATE connector_meeting
        SET source = 'exo-voice-note-dup', metadata = json_set(COALESCE(metadata,'{}'), '$.dup_of', ?, '$.archived_at', ?)
        WHERE id = ? AND source = 'exo-voice-note'
          AND EXISTS (SELECT 1 FROM connector_meeting k WHERE k.id = ? AND k.source = 'exo-voice-note')`,
      [keeper, new Date().toISOString(), id, keeper], checkpoint);
      if (changes) console.info("[VoiceNotes] archived duplicate", { sourceId, id });
    }
  }
  if (sweep) await sweepArchived(tcw, checkpoint);
}

type GroupRow = { id: string; source: string; metadata: Record<string, unknown>; updatedAt: string; title: string | null;
  startedAt: string | null; durationSecs: number | null; participants: string | null };
function parseMetadata(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "string") return raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  try { return JSON.parse(raw) as Record<string, unknown>; } catch { return {}; }
}
async function group(tcw: TinyCloudWeb, sourceId: string, checkpoint: () => void = () => undefined): Promise<GroupRow[]> {
  const rows = await query(tcw, `SELECT id, source, metadata, updated_at, title, started_at, duration_secs, participants
    FROM connector_meeting WHERE source_id = ? AND source IN ('exo-voice-note', 'exo-voice-note-dup')`, [sourceId], checkpoint);
  return rows.map((r) => ({ id: String(r[0]), source: String(r[1]), metadata: parseMetadata(r[2]), updatedAt: String(r[3]),
    title: r[4] as string | null, startedAt: r[5] as string | null, durationSecs: r[6] as number | null,
    participants: r[7] as string | null }));
}
function legacyGroup(m: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(LEGACY_TRANSCRIPT_KEYS.map((key) => [key, m[key] ?? null]));
}
function sameLegacy(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  return LEGACY_TRANSCRIPT_KEYS.every((key) => JSON.stringify(a[key] ?? null) === JSON.stringify(b[key] ?? null));
}

/** Space-wide: repairs late writes even when this device has no sidecar. */
export async function sweepArchived(tcw: TinyCloudWeb, checkpoint: () => void = () => undefined): Promise<void> {
  checkpoint();
  const groups = await query(tcw, "SELECT DISTINCT source_id FROM connector_meeting WHERE source = 'exo-voice-note-dup'", [], checkpoint);
  for (const [sourceId] of groups) {
    checkpoint();
    const rows = await group(tcw, String(sourceId), checkpoint);
    if (rows.filter((r) => r.source === "exo-voice-note").length > 1) { await reconcileDuplicates(tcw, checkpoint, false); continue; }
    const keeper = rows.find((r) => r.source === "exo-voice-note");
    if (!keeper) continue;
    const archived = rows.filter((r) => r.source === "exo-voice-note-dup");
    const dirty = archived.filter((r) => r.metadata.merged_at !== r.updatedAt);
    for (const row of dirty) {
      checkpoint();
      const removed = ["dup_of", "archived_at", "merged_at", ...LEGACY_TRANSCRIPT_KEYS]
        .map((key) => `'$.${key}'`).join(", ");
      await execute(tcw, `UPDATE connector_meeting SET
        metadata = json_patch(json_remove(COALESCE((SELECT metadata FROM connector_meeting WHERE id = ?),'{}'), ${removed}), COALESCE(metadata,'{}')),
        title = COALESCE(title, (SELECT title FROM connector_meeting WHERE id = ?)),
        started_at = COALESCE(started_at, (SELECT started_at FROM connector_meeting WHERE id = ?)),
        duration_secs = COALESCE(duration_secs, (SELECT duration_secs FROM connector_meeting WHERE id = ?)),
        participants = CASE WHEN COALESCE(participants,'[]') = '[]' THEN (SELECT participants FROM connector_meeting WHERE id = ?) ELSE participants END
        WHERE id = ? AND source = 'exo-voice-note'`, [row.id, row.id, row.id, row.id, row.id, keeper.id], checkpoint);
    }
    const commit = await runOnSpaceLane(() => { checkpoint(); return readTranscriptCommit(tcw, String(sourceId), checkpoint); });
    const currentRows = await group(tcw, String(sourceId), checkpoint);
    const winner = legacyTranscriptWinner(currentRows);
    const current = currentRows.find((r) => r.source === "exo-voice-note");
    if (!current) continue;
    if (!commit && winner && !sameLegacy(current.metadata, winner.metadata)) {
      checkpoint();
      await execute(tcw, `UPDATE connector_meeting SET metadata = json_patch(COALESCE(metadata,'{}'), ?), updated_at = ?
        WHERE id = ? AND source = 'exo-voice-note' AND updated_at = ?`,
      [JSON.stringify(legacyGroup(winner.metadata)), new Date().toISOString(), keeper.id, current.updatedAt], checkpoint);
    }
    const afterRows = await group(tcw, String(sourceId), checkpoint);
    const after = afterRows.find((r) => r.source === "exo-voice-note");
    const afterWinner = legacyTranscriptWinner(afterRows);
    if (!after || (!commit && afterWinner && !sameLegacy(after.metadata, afterWinner.metadata))) continue;
    for (const row of dirty) {
      checkpoint();
      await execute(tcw, `UPDATE connector_meeting SET metadata = json_set(metadata, '$.merged_at', updated_at)
        WHERE id = ? AND source = 'exo-voice-note-dup' AND updated_at = ?`, [row.id, row.updatedAt], checkpoint);
    }
  }
}

export interface VoiceNoteRow { id: string; sourceId: string; metadata: Record<string, unknown>; createdAt: string }
export async function resolveVoiceNoteRow(tcw: TinyCloudWeb, sourceId: string, checkpoint: () => void = () => undefined): Promise<VoiceNoteRow | null> {
  const rows = await query(tcw, "SELECT id, source_id, metadata, created_at FROM connector_meeting WHERE source = 'exo-voice-note' AND source_id = ? LIMIT 1", [sourceId], checkpoint);
  const r = rows[0];
  return r ? { id: String(r[0]), sourceId: String(r[1]), metadata: parseMetadata(r[2]), createdAt: String(r[3]) } : null;
}
export async function createVoiceNoteRow(tcw: TinyCloudWeb, recording: VoiceNoteRecording, title: string,
  checkpoint: () => void = () => undefined): Promise<VoiceNoteRow & { inserted: boolean }> {
  const identity = await ensureVoiceNoteIdentity(tcw, checkpoint);
  if (identity.status !== "established") throw Object.assign(new Error(identity.reason ?? identity.status), { code: identity.status });
  const now = new Date().toISOString();
  const changes = await execute(tcw, `INSERT INTO connector_meeting
    (id, source, source_id, title, started_at, duration_secs, organizer_email, participants, summary_overview,
     summary_action_items, keywords, meeting_type, metadata, created_at, updated_at)
    VALUES (?, 'exo-voice-note', ?, ?, ?, ?, NULL, '[]', NULL, NULL, NULL, NULL, '{}', ?, ?)
    ON CONFLICT DO NOTHING`, [`vn-${recording.id}`, recording.id, title, new Date(recording.startedAt).toISOString(),
    Math.round(recording.durationMs / 1000), now, now], checkpoint);
  const row = await resolveVoiceNoteRow(tcw, recording.id, checkpoint);
  if (!row) throw new Error("The voice-note identity index was established but its row is missing");
  return { ...row, inserted: changes > 0 };
}
export async function patchVoiceNoteAudio(tcw: TinyCloudWeb, recording: VoiceNoteRecording, platform: string,
  audio: { base: string; mimeType: string; size: number; parts: number }, checkpoint: () => void = () => undefined): Promise<VoiceNoteRow> {
  const row = await resolveVoiceNoteRow(tcw, recording.id, checkpoint);
  if (!row) throw new Error("Voice note row is missing");
  checkpoint();
  await execute(tcw, `UPDATE connector_meeting SET metadata = json_patch(COALESCE(metadata,'{}'), ?), updated_at = ?
    WHERE id = ? AND source = 'exo-voice-note'`, [JSON.stringify({ audio_kv_key: audio.base, audio_format: "parts-v1",
    audio_mime_type: audio.mimeType, audio_bytes: audio.size, audio_parts: audio.parts, audio: { stored: true, base: audio.base },
    capture: { platform, duration_ms: recording.durationMs, silenced_ms: recording.silencedMs,
      silenced_events: recording.silencedEvents, no_signal_ms: recording.noSignalMs,
      ...(recording.version === 2 ? { version: 2, wall_ms: recording.wallMs, paused_ms: recording.pausedMs,
        spans: recording.spans ?? [], source: recording.source, options: recording.options, input: recording.input } : {}) },
  }), new Date().toISOString(), row.id], checkpoint);
  return row;
}

/** The notes lane changes only its metadata keys, leaving T18 audio and transcript commits intact. */
export async function patchVoiceNoteMarkdown(tcw: TinyCloudWeb, sourceId: string, key: string, editedAt: string,
  checkpoint: () => void = () => undefined): Promise<void> {
  const row = await resolveVoiceNoteRow(tcw, sourceId, checkpoint);
  if (!row) throw new Error("Voice note row is missing");
  checkpoint();
  await execute(tcw, `UPDATE connector_meeting SET metadata = json_patch(COALESCE(metadata,'{}'), ?), updated_at = ?
    WHERE id = ? AND source = 'exo-voice-note'`,
  [JSON.stringify({ note_kv_key: key, note_edited_at: editedAt }), new Date().toISOString(), row.id], checkpoint);
}

export function transcriptRevKvKey(source: string, id: string, hash: string): string {
  return `${CONNECTORS_KV_PREFIX}/${source}/transcript-rev/${id}/${hash}`;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value);
}
export async function transcriptHash(sentences: FirefliesSentence[]): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical(sentences)));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}
export interface TranscriptToCommit { rev: number; sentences: FirefliesSentence[]; outcome: "transcribed" | "no_speech";
  text: string | null; engine?: string | null; provider?: string | null; model?: string | null; language?: string | null;
  speakerLabels?: boolean | null; participants?: string[]; transcribedAt?: string | null; metadata?: Record<string, unknown> }
export async function commitVoiceNoteTranscript(tcw: TinyCloudWeb, sourceId: string, input: TranscriptToCommit): Promise<TranscriptCommit> {
  const identity = await ensureVoiceNoteIdentity(tcw);
  if (identity.status !== "established") throw Object.assign(new Error(identity.reason ?? identity.status), { code: identity.status });
  const row = await resolveVoiceNoteRow(tcw, sourceId);
  if (!row) throw new Error("Voice note row is missing");
  const hash = await transcriptHash(input.sentences);
  const bodyKey = transcriptRevKvKey("exo-voice-note", sourceId, hash);
  const body = canonical(input.sentences);
  const put = await runOnSpaceLane(() => tcw.kv.put(bodyKey, body, { ifNoneMatch: "*", contentType: "application/json" }));
  if (!put.ok && !/PRECONDITION|412/i.test(`${put.error.code} ${put.error.message}`)) throw errorOf(put);
  const preview = input.outcome === "transcribed" ? (input.text ?? "").slice(0, 280) : null;
  await execute(tcw, `INSERT INTO voice_note_transcript
    (source_id, rev, hash, body_key, outcome, preview, engine, provider, model, language, speaker_labels,
     participants, transcribed_at, committed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source_id) DO UPDATE SET rev = excluded.rev, hash = excluded.hash, body_key = excluded.body_key,
      outcome = excluded.outcome, preview = excluded.preview, engine = excluded.engine, provider = excluded.provider,
      model = excluded.model, language = excluded.language, speaker_labels = excluded.speaker_labels,
      participants = excluded.participants, transcribed_at = excluded.transcribed_at, committed_at = excluded.committed_at
    WHERE excluded.rev > voice_note_transcript.rev
       OR (excluded.rev = voice_note_transcript.rev AND excluded.hash > voice_note_transcript.hash)`,
  [sourceId, input.rev, hash, bodyKey, input.outcome, preview, input.engine ?? null, input.provider ?? null,
    input.model ?? null, input.language ?? null, input.speakerLabels == null ? null : Number(input.speakerLabels),
    JSON.stringify((input.participants ?? []).map((name) => ({ name, email: null }))),
    input.transcribedAt ?? new Date().toISOString(), new Date().toISOString()]);
  const committed = await verifyVoiceNoteTranscript(tcw, sourceId, input.rev, hash);
  const mirror = { ...legacyGroup(input.metadata ?? {}), transcript_text: input.outcome === "transcribed" ? input.text : null,
    transcription_outcome: input.outcome, speaker_labels: input.metadata?.speaker_labels ?? input.speakerLabels ?? null,
    transcribed_at: input.transcribedAt ?? new Date().toISOString(), transcription_engine: input.engine ?? null,
    transcript_provider: input.provider ?? null, model: input.model ?? null, language: input.language ?? null };
  if (committed.rev === input.rev && committed.hash === hash) {
    const live = await resolveVoiceNoteRow(tcw, sourceId);
    if (live) await execute(tcw, "UPDATE connector_meeting SET metadata = json_patch(COALESCE(metadata,'{}'), ?), participants = ?, updated_at = ? WHERE id = ? AND source = 'exo-voice-note'",
      [JSON.stringify(mirror), JSON.stringify((input.participants ?? []).map((name) => ({ name, email: null }))),
        new Date().toISOString(), live.id]);
    const fixed = await runOnSpaceLane(() => tcw.kv.put(transcriptKvKey("exo-voice-note", sourceId), body,
      { contentType: "application/json" }));
    if (!fixed.ok) throw errorOf(fixed);
  }
  return committed;
}
export async function verifyVoiceNoteTranscript(tcw: TinyCloudWeb, sourceId: string, rev: number, hash: string): Promise<TranscriptCommit> {
  const committed = await runOnSpaceLane(() => readTranscriptCommit(tcw, sourceId));
  if (!committed || committed.rev < rev || (committed.rev === rev && committed.hash < hash))
    throw new Error("Transcript commit was not durable");
  const body = await runOnSpaceLane(() => tcw.kv.get(committed.bodyKey));
  if (!body.ok) throw errorOf(body);
  return committed;
}
