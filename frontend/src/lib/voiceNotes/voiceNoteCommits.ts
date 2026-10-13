import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { CONNECTORS_SQL_DB_NAME, transcriptKvKey } from "../connectors/connectorStore";

export const LEGACY_TRANSCRIPT_KEYS = [
  "transcription_outcome", "transcript_text", "speaker_labels", "transcribed_at",
  "transcription_engine", "transcript_provider", "inference_provider", "model", "language",
] as const;

export interface LegacyTranscriptRow { id: string; metadata: unknown }
export interface TranscriptCommit {
  sourceId: string; rev: number; hash: string; bodyKey: string; outcome: "transcribed" | "no_speech";
  preview: string | null; engine: string | null; provider: string | null; model: string | null;
  language: string | null; speakerLabels: boolean | null; participants: string | null;
  transcribedAt: string | null;
}

function metadata(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try { value = JSON.parse(value) as unknown; } catch { return {}; }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** The same order as LEGACY_WINNER_SQL_ORDER: latest ISO time, then smallest id. */
export function legacyTranscriptWinner<T extends LegacyTranscriptRow>(rows: readonly T[]): T | null {
  return rows.filter((row) => {
    const m = metadata(row.metadata);
    return m.transcription_outcome === "transcribed" || m.transcription_outcome === "no_speech"
      || (m.transcription_outcome == null && typeof m.transcript_text === "string" && m.transcript_text.trim().length > 0);
  }).sort((a, b) => {
    const at = String(metadata(a.metadata).transcribed_at ?? "");
    const bt = String(metadata(b.metadata).transcribed_at ?? "");
    return (at === bt ? 0 : at > bt ? -1 : 1) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  })[0] ?? null;
}

/** Bound parameters per query (SQLite allows 999). */
export const SQL_CHUNK = 400;

export const LEGACY_WINNER_SQL_ORDER = "ORDER BY COALESCE(json_extract(g.metadata, '$.transcribed_at'), '') DESC, g.id ASC LIMIT 1";

const formatKnown = new WeakMap<object, boolean>();
/** Recheck until found: an older space may gain the table during this session. */
export async function hasTranscriptCommitTable(tcw: Pick<TinyCloudWeb, "sql">,
  checkpoint: () => void = () => undefined, signal?: AbortSignal): Promise<boolean> {
  checkpoint();
  if (formatKnown.get(tcw)) return true;
  checkpoint();
  const result = await tcw.sql.db(CONNECTORS_SQL_DB_NAME).query(
    "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'voice_note_transcript'", [],
    { signal },
  );
  if (!result.ok) throw new Error(`Transcript format check: ${result.error.message}`);
  const found = result.data.rows.length > 0;
  if (found) formatKnown.set(tcw, true);
  return found;
}

export async function readTranscriptCommit(tcw: Pick<TinyCloudWeb, "sql">, sourceId: string,
  checkpoint: () => void = () => undefined, signal?: AbortSignal): Promise<TranscriptCommit | null> {
  if (!await hasTranscriptCommitTable(tcw, checkpoint, signal)) return null;
  checkpoint();
  const result = await tcw.sql.db(CONNECTORS_SQL_DB_NAME).query(
    `SELECT source_id, rev, hash, body_key, outcome, preview, engine, provider, model, language,
            speaker_labels, participants, transcribed_at FROM voice_note_transcript WHERE source_id = ?`, [sourceId],
    { signal },
  );
  if (!result.ok) throw new Error(`Read transcript commit: ${result.error.message}`);
  const r = result.data.rows[0] as unknown[] | undefined;
  return r ? {
    sourceId: String(r[0]), rev: Number(r[1]), hash: String(r[2]), bodyKey: String(r[3]),
    outcome: r[4] as TranscriptCommit["outcome"], preview: r[5] as string | null,
    engine: r[6] as string | null, provider: r[7] as string | null, model: r[8] as string | null,
    language: r[9] as string | null, speakerLabels: r[10] === null ? null : Boolean(r[10]),
    participants: r[11] as string | null, transcribedAt: r[12] as string | null,
  } : null;
}

/** The commits of several notes in one query per chunk (`readTranscriptCommit` for a set). A note with no commit is absent. */
export async function readTranscriptCommits(tcw: Pick<TinyCloudWeb, "sql">, sourceIds: readonly string[]): Promise<Map<string, TranscriptCommit>> {
  const commits = new Map<string, TranscriptCommit>();
  if (sourceIds.length === 0 || !await hasTranscriptCommitTable(tcw)) return commits;
  for (let from = 0; from < sourceIds.length; from += SQL_CHUNK) {
    const chunk = sourceIds.slice(from, from + SQL_CHUNK);
    const result = await tcw.sql.db(CONNECTORS_SQL_DB_NAME).query(
      `SELECT source_id, rev, hash, body_key, outcome, preview, engine, provider, model, language,
              speaker_labels, participants, transcribed_at FROM voice_note_transcript WHERE source_id IN (${chunk.map(() => "?").join(",")})`, chunk,
    );
    if (!result.ok) throw new Error(`Read transcript commits: ${result.error.message}`);
    for (const r of result.data.rows as unknown[][]) {
      commits.set(String(r[0]), {
        sourceId: String(r[0]), rev: Number(r[1]), hash: String(r[2]), bodyKey: String(r[3]),
        outcome: r[4] as TranscriptCommit["outcome"], preview: r[5] as string | null,
        engine: r[6] as string | null, provider: r[7] as string | null, model: r[8] as string | null,
        language: r[9] as string | null, speakerLabels: r[10] === null ? null : Boolean(r[10]),
        participants: r[11] as string | null, transcribedAt: r[12] as string | null,
      });
    }
  }
  return commits;
}

/** The committed transcripts' previews by recording id, one read: what a list titles a note by. */
export async function readTranscriptPreviews(tcw: Pick<TinyCloudWeb, "sql">): Promise<Map<string, string>> {
  const previews = new Map<string, string>();
  if (!await hasTranscriptCommitTable(tcw)) return previews;
  const result = await tcw.sql.db(CONNECTORS_SQL_DB_NAME).query(
    "SELECT source_id, preview FROM voice_note_transcript WHERE outcome = 'transcribed' AND preview IS NOT NULL AND preview != ''", [],
  );
  if (!result.ok) throw new Error(`Read transcript previews: ${result.error.message}`);
  for (const row of result.data.rows as unknown[][]) {
    if (typeof row[0] === "string" && typeof row[1] === "string") previews.set(row[0], row[1]);
  }
  return previews;
}

export async function readLegacyTranscriptWinner(tcw: Pick<TinyCloudWeb, "sql">, sourceId: string): Promise<LegacyTranscriptRow | null> {
  const result = await tcw.sql.db(CONNECTORS_SQL_DB_NAME).query(
    `SELECT g.id, g.metadata FROM connector_meeting g
     WHERE g.source_id = ? AND g.source IN ('exo-voice-note', 'exo-voice-note-dup')
       AND json_valid(g.metadata)
       AND (json_extract(g.metadata, '$.transcription_outcome') IN ('transcribed','no_speech')
         OR (json_extract(g.metadata, '$.transcription_outcome') IS NULL
           AND typeof(json_extract(g.metadata, '$.transcript_text')) = 'text'
           AND length(trim(json_extract(g.metadata, '$.transcript_text'))) > 0))
     ${LEGACY_WINNER_SQL_ORDER}`, [sourceId],
  );
  if (!result.ok) throw new Error(`Read legacy transcript: ${result.error.message}`);
  const r = result.data.rows[0];
  return r ? { id: String(r[0]), metadata: metadata(r[1]) } : null;
}

export function legacyTranscriptMetadata(row: LegacyTranscriptRow | null): Record<string, unknown> {
  return row ? metadata(row.metadata) : {};
}

export interface VoiceNoteTranscriptLocator {
  bodyKey: string | null;
  outcome: "transcribed" | "no_speech" | "none";
  expectedText: string | null;
  preview: string | null;
  committed: boolean;
}
export async function voiceNoteTranscriptLocator(tcw: Pick<TinyCloudWeb, "sql">,
  sourceId: string): Promise<VoiceNoteTranscriptLocator> {
  const commit = await readTranscriptCommit(tcw, sourceId);
  if (commit) return { bodyKey: commit.outcome === "transcribed" ? commit.bodyKey : null,
    outcome: commit.outcome, expectedText: null, preview: commit.preview, committed: true };
  const winner = legacyTranscriptMetadata(await readLegacyTranscriptWinner(tcw, sourceId));
  const outcome = winner.transcription_outcome === "transcribed" ? "transcribed"
    : winner.transcription_outcome === "no_speech" ? "no_speech" : "none";
  return { bodyKey: outcome === "transcribed" ? transcriptKvKey("exo-voice-note", sourceId) : null,
    outcome, expectedText: typeof winner.transcript_text === "string" ? winner.transcript_text : null,
    preview: typeof winner.transcript_text === "string" ? winner.transcript_text.slice(0, 280) : null,
    committed: false };
}

export function normalizeTranscriptText(text: string): string { return text.replace(/\s+/g, " ").trim(); }
