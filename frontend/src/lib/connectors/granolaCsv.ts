// Granola CSV export → normalized meetings. Pure: no storage, no network.
//
// Granola's help page for the export (docs.granola.ai/help-center/sharing/
// exporting-notes) says the file holds "the title, note summary, transcript,
// and other basic details for each note". It documents no column names, no
// column order and no note id, so columns are matched by tolerant header
// aliases (case, spacing and punctuation ignored) and every column but a
// recognised one is dropped. A file with a stable id column dedupes on it;
// otherwise on title + start time + attendees, and never on the title alone.

import { connectorMeetingId, type TranscriptSentence } from "@tinyboilerplate/core";

import type { NormalizedMeeting } from "./connectorStore";

export const GRANOLA_CSV_SOURCE = "granola" as const;
/** Mirrors the backend's meeting id rule (`MEETING_ID_PATTERN`), which the purge check enforces. */
const MEETING_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export type GranolaCsvErrorCode =
  | "empty"
  | "unterminated-quote"
  | "stray-quote"
  | "no-known-columns"
  | "ragged-row";

export interface GranolaCsvError {
  code: GranolaCsvErrorCode;
  /** 1-based data row, when the problem belongs to one. */
  row?: number;
}

type Field = "id" | "title" | "summary" | "transcript" | "attendees" | "created";

const HEADER_ALIASES: Record<Field, readonly string[]> = {
  id: ["id", "note id", "noteid", "note uuid", "document id", "meeting id", "uuid"],
  title: ["title", "note title", "meeting title", "name"],
  summary: ["summary", "note summary", "summary markdown", "summary text", "enhanced notes", "ai notes", "notes"],
  transcript: ["transcript", "full transcript", "transcription"],
  attendees: ["attendees", "participants", "invitees", "people"],
  created: [
    "created", "created at", "createdat", "created date", "date", "meeting date",
    "start", "start time", "start date", "started at", "scheduled start", "scheduled start time",
  ],
};

const FIELD_BY_HEADER = new Map<string, Field>();
for (const field of Object.keys(HEADER_ALIASES) as Field[]) {
  for (const alias of HEADER_ALIASES[field]) FIELD_BY_HEADER.set(alias, field);
}

function headerKey(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

// ── Tokenizer ───────────────────────────────────────────────────────────

/**
 * RFC 4180 records. LF, CRLF and a lone CR end a record outside quotes; a quoted
 * cell keeps its line breaks. A quote inside an unquoted cell is literal. A cell
 * that opens with a quote and never closes, or has text after its closing quote,
 * is malformed.
 */
export function tokenizeCsv(input: string): { ok: true; records: string[][] } | { ok: false; error: GranolaCsvError } {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const records: string[][] = [];
  let record: string[] = [];
  let cell = "";
  let i = 0;
  const n = text.length;
  const endRecord = () => {
    record.push(cell);
    cell = "";
    if (!(record.length === 1 && record[0]!.trim() === "")) records.push(record);
    record = [];
  };
  while (i < n) {
    const ch = text[i]!;
    if (ch === '"' && cell === "") {
      i++;
      let closed = false;
      while (i < n) {
        if (text[i] === '"') {
          if (text[i + 1] === '"') { cell += '"'; i += 2; continue; }
          i++;
          closed = true;
          break;
        }
        cell += text[i]!;
        i++;
      }
      if (!closed) return { ok: false, error: { code: "unterminated-quote", row: records.length } };
      const next = text[i];
      if (next !== undefined && next !== "," && next !== "\n" && next !== "\r") {
        return { ok: false, error: { code: "stray-quote", row: records.length } };
      }
      continue;
    }
    if (ch === ",") { record.push(cell); cell = ""; i++; continue; }
    if (ch === "\n" || ch === "\r") {
      endRecord();
      i += ch === "\r" && text[i + 1] === "\n" ? 2 : 1;
      continue;
    }
    cell += ch;
    i++;
  }
  if (cell !== "" || record.length > 0) endRecord();
  return { ok: true, records };
}

// ── Rows ────────────────────────────────────────────────────────────────

export interface GranolaCsvRow {
  id: string | null;
  title: string | null;
  summary: string | null;
  transcript: string | null;
  attendees: { name: string; email: string | null }[];
  /** The cell as exported, for metadata. */
  createdRaw: string | null;
  startedAt: string | null;
}

export interface GranolaCsvParse {
  rows: GranolaCsvRow[];
  /** Records with no title, summary or transcript. */
  blank: number;
}

function clean(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

function parseAttendeeEntry(entry: string): { name: string; email: string | null } | null {
  const text = entry.trim();
  if (text.length === 0) return null;
  const angled = /^(.*?)<([^<>\s]+@[^<>\s]+)>$/.exec(text);
  if (angled) {
    const email = angled[2]!;
    return { name: angled[1]!.trim().replace(/^["']|["']$/g, "") || email, email };
  }
  if (/^[^\s@]+@[^\s@]+$/.test(text)) return { name: text, email: text };
  return { name: text, email: null };
}

export function parseGranolaAttendees(raw: string | null): { name: string; email: string | null }[] {
  if (raw === null) return [];
  const out: { name: string; email: string | null }[] = [];
  const seen = new Set<string>();
  const push = (entry: { name: string; email: string | null } | null) => {
    if (!entry) return;
    const key = (entry.email ?? entry.name).toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(entry);
  };
  if (raw.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (typeof item === "string") push(parseAttendeeEntry(item));
          else if (item && typeof item === "object") {
            const rec = item as Record<string, unknown>;
            const email = typeof rec.email === "string" && rec.email.trim() ? rec.email.trim() : null;
            const name = typeof rec.name === "string" && rec.name.trim() ? rec.name.trim() : email;
            if (name) push({ name, email });
          }
        }
        return out;
      }
    } catch {
      // Not JSON after all; fall through to the delimited reading.
    }
  }
  // Semicolons and line breaks separate people; commas do only when neither is present
  // ("Smith, Ada <ada@x.com>; Bo" keeps its comma).
  const parts = /[;\n\r]/.test(raw) ? raw.split(/[;\n\r]+/) : raw.split(",");
  for (const part of parts) push(parseAttendeeEntry(part));
  return out;
}

function parseStart(raw: string | null): string | null {
  if (raw === null) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

export function parseGranolaCsv(input: string): { ok: true; data: GranolaCsvParse } | { ok: false; error: GranolaCsvError } {
  const tokens = tokenizeCsv(input);
  if (!tokens.ok) return tokens;
  const [header, ...body] = tokens.records;
  if (!header) return { ok: false, error: { code: "empty" } };

  // First column wins when a field is spelled twice ("Notes" and "Summary").
  const columns = new Map<Field, number[]>();
  header.forEach((raw, index) => {
    const field = FIELD_BY_HEADER.get(headerKey(raw));
    if (field) columns.set(field, [...(columns.get(field) ?? []), index]);
  });
  if (!columns.has("title") && !columns.has("summary") && !columns.has("transcript")) {
    return { ok: false, error: { code: "no-known-columns" } };
  }
  const pick = (cells: string[], field: Field): string | null => {
    for (const index of columns.get(field) ?? []) {
      const value = clean(cells[index]);
      if (value !== null) return value;
    }
    return null;
  };

  const rows: GranolaCsvRow[] = [];
  let blank = 0;
  for (let r = 0; r < body.length; r++) {
    const cells = body[r]!;
    if (cells.length > header.length && cells.slice(header.length).some((c) => c.trim() !== "")) {
      return { ok: false, error: { code: "ragged-row", row: r + 1 } };
    }
    const title = pick(cells, "title");
    const summary = pick(cells, "summary");
    const transcript = pick(cells, "transcript");
    if (title === null && summary === null && transcript === null) { blank++; continue; }
    const createdRaw = pick(cells, "created");
    rows.push({
      id: pick(cells, "id"),
      title,
      summary,
      transcript,
      attendees: parseGranolaAttendees(pick(cells, "attendees")),
      createdRaw,
      startedAt: parseStart(createdRaw),
    });
  }
  return { ok: true, data: { rows, blank } };
}

// ── Identity ────────────────────────────────────────────────────────────

async function sha256Hex(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

function squash(text: string | null): string {
  return (text ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * The key a row dedupes on. A Granola id when the file has one; otherwise
 * title + start time + attendees. When a row has neither a start time nor
 * attendees the title alone would merge different meetings, so its text joins
 * the key.
 */
export async function granolaCsvDedupeKey(row: GranolaCsvRow): Promise<string> {
  if (row.id !== null) return `id:${row.id.toLowerCase()}`;
  const people = row.attendees.map((a) => (a.email ?? a.name).toLowerCase()).sort().join(";");
  const when = row.startedAt ?? squash(row.createdRaw);
  const parts = ["v1", squash(row.title), when, people];
  if (when === "" && people === "") {
    parts.push(await sha256Hex(`${squash(row.summary)}\u0000${squash(row.transcript)}`));
  }
  return `fields:${parts.join("\u0000")}`;
}

/** The id stored as `source_id`: the export's own id when it is a valid meeting id, else a hash of the dedupe key. */
export async function granolaCsvSourceId(row: GranolaCsvRow): Promise<string> {
  if (row.id !== null && MEETING_ID_PATTERN.test(row.id)) return row.id;
  return `csv-${(await sha256Hex(await granolaCsvDedupeKey(row))).slice(0, 32)}`;
}

// ── Normalize ───────────────────────────────────────────────────────────

const SPEAKER_LINE = /^(?:\[?\(?\d{1,2}:\d{2}(?::\d{2})?\)?\]?\s+)?([\p{L}][\p{L}'.\- ]{0,38}):\s+(\S.*)$/u;

/** One sentence per non-empty line; `Name: text` lines carry the speaker. */
export function granolaCsvSentences(transcript: string | null): TranscriptSentence[] {
  if (transcript === null) return [];
  const sentences: TranscriptSentence[] = [];
  for (const line of transcript.split(/\r\n|\r|\n/)) {
    const text = line.trim();
    if (text === "") continue;
    const match = SPEAKER_LINE.exec(text);
    const index = sentences.length;
    sentences.push({
      index,
      speaker_name: match ? match[1]!.trim() : null,
      text: match ? match[2]!.trim() : text,
      start_time: index,
      end_time: index,
    });
  }
  return sentences;
}

export async function normalizeGranolaCsvRow(
  row: GranolaCsvRow,
): Promise<{ meeting: NormalizedMeeting; sentences: TranscriptSentence[] }> {
  const sourceId = await granolaCsvSourceId(row);
  const sentences = granolaCsvSentences(row.transcript);
  const meeting: NormalizedMeeting = {
    id: await connectorMeetingId(GRANOLA_CSV_SOURCE, sourceId),
    source: GRANOLA_CSV_SOURCE,
    sourceId,
    title: row.title,
    startedAt: row.startedAt,
    durationSecs: null,
    organizerEmail: null,
    participants: row.attendees,
    summaryOverview: row.summary,
    summaryActionItems: null,
    keywords: null,
    meetingType: null,
    metadata: {
      imported_from: "granola_csv",
      granola_created_at: row.createdRaw,
      transcript_state: sentences.length > 0 ? "stored" : "absent",
    },
  };
  return { meeting, sentences };
}
