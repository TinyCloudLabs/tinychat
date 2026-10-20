// TC-1152 S1: stitch two partial transcripts of one meeting into a single combined meeting.
//
// `stitchMeetings(a, b)` is pure and deterministic: no clock, no randomness, no I/O, and it never
// mutates its inputs. Same two snapshots in (either order) give the same bytes out.
//
// The file has five sections. Sections 2, 4 and 5 handle transcript content (reading, merging and
// provenance); they are the parts that need a data-handling review.
//   1. Types and small helpers
//   2. READING   - normalise a member snapshot (SQL row + body, or KV-only record + body)
//   3. DETECTION - same-meeting verdict, offset, drift (text anchors; numbers only, never text)
//   4. MERGING   - regions, one source per span, seams at sentence boundaries, speaker naming
//   5. PROVENANCE- `sources` on every segment, member records, output ids
//
// Conventions
//   offset_s: with members sorted by ref, `time(members[0]) = time(members[1]) + offset_s`.
//   Segment times are seconds from the capture's own start; output times are seconds from the
//   earlier capture's start (the combined meeting starts when the first member does).
//   Error messages carry indexes and counts only, never transcript text, titles or names.

// ═══ 1. Types and small helpers ══════════════════════════════════════════════════════════════

export const STITCH_ALGORITHM = "exo.meeting_stitch.v1";
export const MERGED_SOURCE = "exo-merged";

/** One body segment, the shape every catalog stores: seconds from that capture's own start. */
export interface StitchSegment {
  index: number;
  speaker_name: string | null;
  text: string;
  start_time: number;
  end_time: number;
}

/** A `connector_meeting` row as read from SQL (JSON columns may still be strings). */
export interface SqlMeetingRow {
  title?: string | null;
  started_at?: string | null;
  duration_secs?: number | null;
  participants?: unknown;
  metadata?: unknown;
}

/** The KV-only meeting record (`connectors/<source>/meeting/<id>`, ReconciledMeetingKvRecordV1). */
export interface KvMeetingRecord {
  title?: string | null;
  startedAt?: string | null;
  [key: string]: unknown;
}

/**
 * One member as the caller read it. Exactly one of `row` / `kv_record`. `body` is the transcript
 * body: the stored string (preferred, so `body_sha256` is the hash of the stored bytes) or the
 * parsed array / `{sentences}` / `{segments}`.
 */
export interface MeetingSnapshot {
  source: string;
  source_id: string;
  row?: SqlMeetingRow;
  kv_record?: KvMeetingRecord;
  body: unknown;
}

export type StitchRelation = "same-span" | "contained" | "partial" | "none";

export interface SourceRef {
  source: string;
  source_id: string;
  index: number;
  speaker_label: string | null;
  chosen: boolean;
}

export interface StitchedSegment extends StitchSegment {
  sources: SourceRef[];
  /** Overlap only: the text of the source that was not shown (verbatim sentences, space-joined). */
  alternate?: { source: string; source_id: string; text: string };
  /** Set on the first segment after a forced end-to-end join. */
  seam?: "forced";
}

export interface StitchEvidence {
  time_window: "overlap" | "no-overlap" | "untrusted";
  shared_phrases: number;
  matching_phrases: number;
  anchors_per_min: number;
  span_s: number;
  shorter_capture_s: number;
  passed: boolean;
}

export interface StitchMemberResult {
  source: string;
  source_id: string;
  relation: StitchRelation;
  offset_s: number;
  coverage: [number, number][];
  body_sha256: string;
}

export interface StitchSpeakerMapEntry {
  source: string;
  source_id: string;
  label: string;
  name: string | null;
  share: number;
  seconds: number;
}

export interface StitchSeam {
  time_s: number;
  from_source: string;
  to_source: string;
  /** Timeline distance between the two cut points: >0 a hole, <0 text shown twice. */
  gap_s: number;
}

export interface StitchedMeeting {
  row: {
    id: string;
    source: typeof MERGED_SOURCE;
    source_id: string;
    title: string | null;
    started_at: string | null;
    duration_secs: number;
    organizer_email: null;
    participants: { name: string; email: string | null }[];
    summary_overview: null;
    summary_action_items: null;
    keywords: null;
    meeting_type: null;
    metadata: {
      merge: {
        v: 1;
        algorithm: typeof STITCH_ALGORITHM;
        decided_by: "user";
        forced?: true;
        members: StitchMemberResult[];
        detection: { anchors_per_min: number; span_s: number; passed: boolean };
      };
    };
  };
  body: StitchedSegment[];
}

export interface StitchResult {
  verdict: "same-meeting" | "not-same-meeting";
  /** Why a pair was refused. Null when same-meeting. */
  reason: "no-time-overlap" | "anchor-rule" | null;
  forced: boolean;
  offset_s: number | null;
  relation: StitchRelation;
  evidence: StitchEvidence;
  members: StitchMemberResult[];
  speaker_map: StitchSpeakerMapEntry[];
  seams: StitchSeam[];
  /** Null for a refused pair unless `force` was passed. */
  combined: StitchedMeeting | null;
}

export interface StitchOptions {
  /** Lay a refused pair end to end at clock times with a marked seam. */
  force?: boolean;
}

export class StitchInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StitchInputError";
  }
}

const PAD_S = 15 * 60;
const ANCHOR_TOL_S = 8;
const MIN_ANCHORS_PER_MIN = 1.25;
const SPAN_CAP_S = 120;
const SPAN_FRACTION = 0.3;

/** The detection rule's numbers, for a UI that explains a verdict (one source of truth). */
export const STITCH_TIME_PAD_S = PAD_S;
export const STITCH_MIN_ANCHORS_PER_MIN = MIN_ANCHORS_PER_MIN;
export const STITCH_SPAN_CAP_S = SPAN_CAP_S;
export const STITCH_SPAN_FRACTION = SPAN_FRACTION;
const DRIFT_WINDOW_S = 120;
const DRIFT_STEP_S = 60;
const DRIFT_MIN_ANCHORS = 3;
const RUN_SPAN_S = 30;
const RUN_SPAN_MIN_TAIL_S = 15;
const SWITCH_SHARE = 0.5;
const EPS = 1e-6;
const MIN_CAPTURE_S = 120;
/** A seam is "tight" when the two sources' nearest sentence starts are this close. */
const SEAM_TIGHT_S = 2;
const MIN_ANCHOR_SEGMENTS = 3;
export const STITCH_MIN_CAPTURE_S = MIN_CAPTURE_S;
/** ISO-8601 with an explicit zone; anything else would be read in local time. */
const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i;

/** min/max by loop: `Math.min(...arr)` throws RangeError on very large arrays. Callers pass non-empty arrays. */
const minOf = (v: number[]): number => v.reduce((a, b) => (b < a ? b : a), Infinity);
const maxOf = (v: number[]): number => v.reduce((a, b) => (b > a ? b : a), -Infinity);

const round3 = (x: number): number => Math.round(x * 1000) / 1000;

function median(values: number[]): number {
  const v = [...values].sort((x, y) => x - y);
  const mid = v.length >> 1;
  return v.length % 2 === 1 ? v[mid]! : (v[mid - 1]! + v[mid]!) / 2;
}

/** Synchronous SHA-256 (hex) so the stitcher stays pure and runs in browsers and Bun alike. */
function sha256Hex(text: string): string {
  const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);
  const data = new TextEncoder().encode(text);
  const padded = new Uint8Array((((data.length + 9 + 63) >> 6) << 6));
  padded.set(data);
  padded[data.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor((data.length * 8) / 0x100000000));
  view.setUint32(padded.length - 4, (data.length * 8) >>> 0);
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15]!, 7) ^ rotr(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3);
      const s1 = rotr(w[i - 2]!, 17) ^ rotr(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = [h[0]!, h[1]!, h[2]!, h[3]!, h[4]!, h[5]!, h[6]!, h[7]!];
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K[i]! + w[i]!) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0]! + a) >>> 0; h[1] = (h[1]! + b) >>> 0; h[2] = (h[2]! + c) >>> 0; h[3] = (h[3]! + d) >>> 0;
    h[4] = (h[4]! + e) >>> 0; h[5] = (h[5]! + f) >>> 0; h[6] = (h[6]! + g) >>> 0; h[7] = (h[7]! + hh) >>> 0;
  }
  return Array.from(h, (x) => x.toString(16).padStart(8, "0")).join("");
}

/** SHA-256 of the string, truncated to 128 bits with UUIDv8 version/variant bits. */
function uuidV8(text: string): string {
  const hex = sha256Hex(text).slice(0, 32).split("");
  hex[12] = "8";
  hex[16] = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  const s = hex.join("");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

/** Output id: UUIDv8(sha256("exo.meeting_stitch.v1\0" + sorted member refs joined by \0)). */
export function stitchedSourceId(refs: string[]): string {
  return uuidV8(`${STITCH_ALGORITHM}\0${[...refs].sort().join("\0")}`);
}

/** Same id derivation as `connectorMeetingId` (connector-meeting.ts), synchronous. */
function connectorRowId(source: string, sourceId: string): string {
  return uuidV8(`tinychat.connector_meeting.v1\0${source}\0${sourceId}`);
}

export function memberRef(source: string, sourceId: string): string {
  return `${source}:${sourceId}`;
}

// ═══ 2. READING ══════════════════════════════════════════════════════════════════════════════
// DATA-HANDLING: turns caller snapshots into an internal view. Reads, never writes or mutates.

interface Seg {
  index: number;
  speaker: string | null;
  text: string;
  start: number;
  end: number;
}

interface Member {
  ref: string;
  source: string;
  sourceId: string;
  label: string;
  title: string | null;
  startMs: number | null;
  trustedStart: boolean;
  durationS: number;
  participants: { name: string; email: string | null }[];
  platform: string | null;
  meetingUrl: string | null;
  calendarTitle: string | null;
  calendarSource: string | null;
  segs: Seg[];
  bodySha: string;
  firstS: number;
  lastS: number;
  hasNames: boolean;
  rank: number;
  titleRank: number;
}

const SPEAKER_N = /^speaker[ _-]?(\d+)$/i;
const NOT_A_NAME = /^(unknown|me|them|unidentified|guest[ _-]?\d+|)$/i;

function isRealName(label: string | null): boolean {
  if (label === null) return false;
  const t = label.trim();
  return !SPEAKER_N.test(t) && !NOT_A_NAME.test(t);
}

function sourceLabel(source: string): string {
  switch (source) {
    case "fireflies": return "Fireflies";
    case "google-meet": return "Google Meet";
    case "tinycloud-transcriber": return "Notetaker";
    case "exo-voice-note": return "Voice note";
    case "exo-upload": return "Upload";
    case "exo-local": return "Desktop";
    default: return source;
  }
}

function jsonField(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function readParticipants(value: unknown): { name: string; email: string | null }[] {
  const raw = jsonField(value);
  if (!Array.isArray(raw)) return [];
  const out: { name: string; email: string | null }[] = [];
  for (const p of raw) {
    if (typeof p === "string" && p.trim()) out.push({ name: p, email: null });
    else {
      const r = asRecord(p);
      const name = str(r.name);
      if (name) out.push({ name, email: str(r.email) });
    }
  }
  return out;
}

/** A finite number, or a non-empty numeric string; `Number("")`, `Number([])` and `Number(true)` must not become 0/1. */
function strictTime(v: unknown): number {
  if (typeof v === "number") return v;
  return typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
}

function readBody(body: unknown, which: string): { segs: Seg[]; sha: string } {
  const sha = sha256Hex(typeof body === "string" ? body : JSON.stringify(body ?? null));
  let parsed: unknown = body;
  if (typeof body === "string") {
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new StitchInputError(`member ${which}: body is not JSON`);
    }
  }
  const rec = asRecord(parsed);
  const list = Array.isArray(parsed) ? parsed : Array.isArray(rec.sentences) ? rec.sentences : Array.isArray(rec.segments) ? rec.segments : null;
  if (list === null) throw new StitchInputError(`member ${which}: body is not a segment array`);
  const segs: Seg[] = [];
  list.forEach((item, position) => {
    const r = asRecord(item);
    const text = typeof r.text === "string" ? r.text : null;
    const start = strictTime(r.start_time ?? r.start);
    const end = strictTime(r.end_time ?? r.end);
    if (text === null || !Number.isFinite(start) || !Number.isFinite(end)) {
      throw new StitchInputError(`member ${which}: segment ${position} is malformed`);
    }
    if (text.trim() === "") return;
    const index = Number.isInteger(r.index) ? (r.index as number) : position;
    segs.push({ index, speaker: typeof r.speaker_name === "string" ? r.speaker_name : null, text, start, end: Math.max(start, end) });
  });
  segs.sort((x, y) => x.start - y.start || x.index - y.index);
  return { segs, sha };
}

function rankOf(source: string, platform: string | null, meetingUrl: string | null, hasNames: boolean): number {
  const meet = /meet/i.test(platform ?? "") || /meet\.google\./i.test(meetingUrl ?? "");
  if (source === "tinycloud-transcriber") return hasNames && meet ? 0 : 3;
  if (source === "google-meet") return 1;
  if (source === "fireflies") return 2;
  return 4; // voice notes, uploads, desktop and unknown sources
}

function readMember(snap: MeetingSnapshot, which: string): Member {
  if (typeof snap.source !== "string" || typeof snap.source_id !== "string" || snap.source === "" || snap.source_id === "") {
    throw new StitchInputError(`member ${which}: source and source_id are required`);
  }
  if ((snap.row === undefined) === (snap.kv_record === undefined)) {
    throw new StitchInputError(`member ${which}: pass exactly one of row or kv_record`);
  }
  if (snap.source === MERGED_SOURCE) throw new StitchInputError(`member ${which}: a combined meeting cannot be combined again`);
  // A standalone Gemini "notes" row (gmeetNotes.ts) is a summary document, not a transcript.
  const noteMeta = asRecord(jsonField(snap.row?.metadata));
  if (snap.source === "google-meet" && noteMeta.notes_kind === "gemini" && noteMeta.notes_association === "standalone") {
    throw new StitchInputError(`member ${which}: Gemini notes are not a transcript`);
  }
  const { segs, sha } = readBody(snap.body, which);
  if (segs.length === 0) throw new StitchInputError(`member ${which}: body has no text`);
  const row = snap.row;
  const kv = snap.kv_record;
  const title = str(row?.title ?? kv?.title);
  const startedAt = str(row?.started_at ?? kv?.startedAt);
  const parsedStart = startedAt !== null && ISO_WITH_ZONE.test(startedAt) ? Date.parse(startedAt) : NaN; // no zone: local time, so untrusted
  const meta = asRecord(jsonField(row?.metadata));
  const firstS = minOf(segs.map((s) => s.start));
  const lastS = maxOf(segs.map((s) => s.end));
  const rowDur = Number(row?.duration_secs);
  const hasNames = segs.some((s) => isRealName(s.speaker));
  const platform = str(meta.platform);
  const meetingUrl = str(meta.meeting_url);
  const calendarSource = str(meta.source);
  const calendarTitle = str(meta.calendar_title);
  const calendarBacked = calendarSource === "google-calendar-autojoin" && calendarTitle !== null;
  return {
    ref: memberRef(snap.source, snap.source_id),
    source: snap.source,
    sourceId: snap.source_id,
    label: sourceLabel(snap.source),
    title,
    startMs: Number.isFinite(parsedStart) ? parsedStart : null,
    trustedStart: Number.isFinite(parsedStart) && snap.source !== "exo-upload",
    durationS: Number.isFinite(rowDur) && rowDur > 0 ? rowDur : lastS,
    participants: readParticipants(row?.participants),
    platform,
    meetingUrl,
    calendarTitle,
    calendarSource,
    segs,
    bodySha: sha,
    firstS,
    lastS,
    hasNames,
    rank: rankOf(snap.source, platform, meetingUrl, hasNames),
    titleRank: calendarBacked ? 0 : snap.source === "fireflies" ? 1 : snap.source === "google-meet" ? 2 : snap.source === "tinycloud-transcriber" ? 3 : 4,
  };
}

// ═══ 3. DETECTION ════════════════════════════════════════════════════════════════════════════
// Numbers only: nothing in this section returns or logs transcript text.

const FILLERS = new Set(["um", "uh", "hmm", "mm", "mm-hmm", "uh-huh", "mhm", "er", "ah", "oh", "erm", "huh"]);

/** Same normalisation as the #104 detector: lowercase, hyphens to spaces, strip punctuation. */
function normTokens(word: string): string[] {
  const t = word.toLowerCase().replace(/-/g, " ").replace(/[^a-z0-9' ]+/g, " ");
  const out: string[] = [];
  for (const piece of t.split(" ")) {
    const p = piece.replace(/^'+|'+$/g, "");
    if (p !== "") out.push(p);
  }
  return out;
}

interface Tok {
  w: string;
  t: number;
  s: number; // segment index
}

/** Word tokens with times interpolated by character position inside the segment. */
function memberTokens(m: Member): Tok[] {
  const out: Tok[] = [];
  m.segs.forEach((s, seg) => {
    const len = Math.max(1, s.text.length);
    for (const match of s.text.matchAll(/\S+/g)) {
      const t = s.start + ((s.end - s.start) * match.index!) / len;
      for (const w of normTokens(match[0])) if (!FILLERS.has(w)) out.push({ w, t, s: seg });
    }
  });
  return out;
}

/** 4-word runs that occur exactly once in the transcript -> time and segment of the run. */
function uniqueGrams(toks: Tok[]): Map<string, { t: number; s: number }> {
  const count = new Map<string, number>();
  const at = new Map<string, { t: number; s: number }>();
  for (let i = 0; i + 4 <= toks.length; i++) {
    const g = `${toks[i]!.w} ${toks[i + 1]!.w} ${toks[i + 2]!.w} ${toks[i + 3]!.w}`;
    count.set(g, (count.get(g) ?? 0) + 1);
    if (!at.has(g)) at.set(g, { t: toks[i]!.t, s: toks[i]!.s });
  }
  for (const [g, n] of count) if (n !== 1) at.delete(g);
  return at;
}

interface Anchor {
  ta: number; // time on members[0]'s clock
  tb: number; // time on members[1]'s clock
  o: number; // ta - tb
  sa: number; // segment of the run in members[0]
  sb: number; // segment of the run in members[1]
}

interface Alignment {
  shared: number;
  anchors: Anchor[]; // consistent anchors, in ta order
  offset: number | null;
  perMin: number;
  spanS: number;
  shorterS: number;
  passed: boolean;
  timeWindow: StitchEvidence["time_window"];
  map: (tb: number) => number;
}

function timeWindow(a: Member, b: Member): StitchEvidence["time_window"] {
  if (!a.trustedStart || !b.trustedStart) return "untrusted";
  const aS = a.startMs! / 1000;
  const bS = b.startMs! / 1000;
  const gap = Math.max(bS - (aS + a.durationS), aS - (bS + b.durationS));
  return gap <= PAD_S ? "overlap" : "no-overlap";
}

/** Detect whether a (members[0]) and b (members[1]) are one meeting and align b onto a's clock. */
function align(a: Member, b: Member): Alignment {
  const ga = uniqueGrams(memberTokens(a));
  const gb = uniqueGrams(memberTokens(b));
  const window = timeWindow(a, b);
  const expected = a.trustedStart && b.trustedStart ? (b.startMs! - a.startMs!) / 1000 : null;
  const pairs: Anchor[] = [];
  for (const [g, ia] of ga) {
    const ib = gb.get(g);
    if (ib === undefined) continue;
    const o = ia.t - ib.t;
    if (expected !== null && Math.abs(o - expected) > PAD_S) continue; // started_at gap is only a search prior
    pairs.push({ ta: ia.t, tb: ib.t, o, sa: ia.s, sb: ib.s });
  }
  const shorterS = Math.min(a.lastS - a.firstS, b.lastS - b.firstS);
  const none: Alignment = {
    shared: pairs.length, anchors: [], offset: null, perMin: 0, spanS: 0, shorterS, passed: false, timeWindow: window, map: (t) => t,
  };
  if (pairs.length === 0) return none;

  // Densest ±8 s offset window, then the median of it, then every anchor within ±8 s of that median.
  const byO = [...pairs].sort((x, y) => x.o - y.o || x.ta - y.ta);
  let best = 0;
  let bestAt = 0;
  for (let i = 0, j = 0; i < byO.length; i++) {
    if (j < i) j = i;
    while (j + 1 < byO.length && byO[j + 1]!.o - byO[i]!.o <= 2 * ANCHOR_TOL_S) j++;
    if (j - i + 1 > best) {
      best = j - i + 1;
      bestAt = i;
    }
  }
  const dense = byO.slice(bestAt, bestAt + best);
  const center = median(dense.map((p) => p.o));
  const anchors = pairs.filter((p) => Math.abs(p.o - center) <= ANCHOR_TOL_S).sort((x, y) => x.ta - y.ta || x.tb - y.tb);
  const offset = median(anchors.map((p) => p.o));
  const spanS = anchors[anchors.length - 1]!.ta - anchors[0]!.ta;
  const perMin = anchors.length / (Math.max(30, shorterS) / 60);
  // A short clip can share a few boilerplate sentences with a long meeting, and one n-word sentence
  // gives n-3 anchors. Require a real capture length and anchors from 3+ distinct segments per side.
  const distinctA = new Set(anchors.map((p) => p.sa)).size;
  const distinctB = new Set(anchors.map((p) => p.sb)).size;
  const passed = perMin >= MIN_ANCHORS_PER_MIN && spanS >= Math.min(SPAN_CAP_S, SPAN_FRACTION * shorterS)
    && shorterS >= MIN_CAPTURE_S && distinctA >= MIN_ANCHOR_SEGMENTS && distinctB >= MIN_ANCHOR_SEGMENTS;
  return { shared: pairs.length, anchors, offset, perMin, spanS, shorterS, passed, timeWindow: window, map: driftMap(anchors, offset) };
}

/** Piecewise-linear b->a map: one knot per sliding 2-minute window of anchors, constant beyond the ends. */
function driftMap(anchors: Anchor[], offset: number): (tb: number) => number {
  const knots: { x: number; y: number }[] = [];
  const lo = anchors[0]!.ta;
  const hi = anchors[anchors.length - 1]!.ta;
  for (let c = lo; c <= hi + EPS; c += DRIFT_STEP_S) {
    const inside = anchors.filter((p) => Math.abs(p.ta - c) <= DRIFT_WINDOW_S / 2);
    if (inside.length < DRIFT_MIN_ANCHORS) continue;
    const x = median(inside.map((p) => p.tb));
    if (knots.length > 0 && x <= knots[knots.length - 1]!.x) continue;
    knots.push({ x, y: median(inside.map((p) => p.o)) });
  }
  if (knots.length === 0) return (tb) => tb + offset;
  return (tb) => {
    if (tb <= knots[0]!.x) return tb + knots[0]!.y;
    const last = knots[knots.length - 1]!;
    if (tb >= last.x) return tb + last.y;
    let i = 1;
    while (knots[i]!.x < tb) i++;
    const k0 = knots[i - 1]!;
    const k1 = knots[i]!;
    return tb + k0.y + ((k1.y - k0.y) * (tb - k0.x)) / (k1.x - k0.x);
  };
}

// ═══ 4. MERGING ══════════════════════════════════════════════════════════════════════════════
// DATA-HANDLING: builds the combined body. Every output text is a verbatim substring of exactly
// one source segment (the whole segment, or a sentence-boundary slice of it at a seam). Texts are
// never edited, joined across sources, or blended; `alternate` is the other source's own sentences.

interface Track {
  m: Member;
  map: (t: number) => number; // member clock -> timeline
}

interface Sent {
  track: 0 | 1;
  seg: number; // index into member.segs
  k: number; // sentence number inside the segment
  kn: number; // sentences in the segment
  c0: number;
  c1: number;
  t0: number;
  t1: number;
  words: number;
}

function segTimes(track: Track, s: Seg): [number, number] {
  const t0 = track.map(s.start);
  return [t0, Math.max(t0, track.map(s.end))];
}

function buildSentences(track: Track, which: 0 | 1): Sent[] {
  const out: Sent[] = [];
  track.m.segs.forEach((s, seg) => {
    const [ts, te] = segTimes(track, s);
    const len = Math.max(1, s.text.length);
    const ranges: [number, number][] = [];
    let from = 0;
    const push = (a: number, b: number) => {
      while (a < b && /\s/.test(s.text[a]!)) a++;
      while (b > a && /\s/.test(s.text[b - 1]!)) b--;
      if (a < b) ranges.push([a, b]);
    };
    for (const e of s.text.matchAll(/[.!?]+["'’)\]]*(?=\s|$)/g)) {
      push(from, e.index! + e[0].length);
      from = e.index! + e[0].length;
    }
    push(from, s.text.length);
    ranges.forEach(([c0, c1], k) => {
      out.push({
        track: which, seg, k, kn: ranges.length, c0, c1,
        t0: ts + ((te - ts) * c0) / len, t1: ts + ((te - ts) * c1) / len,
        words: (s.text.slice(c0, c1).match(/\S+/g) ?? []).length,
      });
    });
  });
  return out.sort((x, y) => x.t0 - y.t0 || x.seg - y.seg || x.k - y.k);
}

function wordsIn(sents: Sent[], a: number, b: number): number {
  let n = 0;
  for (const s of sents) {
    const ov = Math.min(s.t1, b) - Math.max(s.t0, a);
    if (ov <= 0) continue;
    n += s.t1 - s.t0 <= EPS ? s.words : (s.words * ov) / (s.t1 - s.t0);
  }
  return n;
}

interface Run {
  src: 0 | 1;
  t0: number;
  t1: number;
}

interface Cut {
  x: number; // earlier run's source keeps sentences that start before x
  y: number; // later run's source keeps sentences that start at or after y
}

/**
 * Seam between two runs of different sources, as start-time thresholds (overlapping speakers make
 * sentence ends non-monotonic, starts are what the sorted order follows). A cut falls just before a
 * sentence of the earlier source, so no sentence is ever split. Pass 1: such a sentence start within
 * the window and within 20 s of an anchor, whose nearest sentence start in the later source is
 * within SEAM_TIGHT_S (so little is dropped or repeated). Pass 2: the same without the anchor condition.
 * Passes 3-4: as 1-2 but accepting the closest pair however far apart. Last resort: split by sentence
 * midpoint at the nominal time. The distance left at each seam is reported as `seams[].gap_s`.
 */
function pickCut(early: Sent[], late: Sent[], nominal: number, win: [number, number], anchors: number[], floor: number): Cut {
  const starts = late.map((s) => s.t0);
  const nearest = (t: number): number => {
    let best = starts[0]!;
    for (const b of starts) if (Math.abs(b - t) < Math.abs(best - t)) best = b;
    return best;
  };
  const cands = early.map((s) => s.t0).filter((t) => t >= Math.max(win[0], floor) - EPS && t <= win[1] + EPS);
  // Tight passes first: a cut whose two sides start within SEAM_TIGHT_S of each other drops or repeats
  // almost nothing. Only when no such cut exists do the loose passes take the least-bad one.
  for (const [needAnchor, tightOnly] of [[true, true], [false, true], [true, false], [false, false]] as const) {
    let best: (Cut & { score: number }) | null = null;
    for (const x of cands) {
      if (needAnchor && !anchors.some((a) => Math.abs(a - x) <= 20)) continue;
      const y = nearest(x);
      if (tightOnly && Math.abs(x - y) > SEAM_TIGHT_S) continue;
      const score = Math.abs(x - y) + 0.01 * Math.abs(x - nominal);
      if (best === null || score < best.score - EPS) best = { x, y, score };
    }
    if (best !== null) return { x: best.x, y: best.y };
  }
  const after = early.filter((s) => (s.t0 + s.t1) / 2 >= nominal && s.t0 >= floor - EPS);
  const lateAfter = late.filter((s) => (s.t0 + s.t1) / 2 >= nominal);
  return {
    x: after.length > 0 ? minOf(after.map((s) => s.t0)) : Math.max(floor, nominal),
    y: lateAfter.length > 0 ? minOf(lateAfter.map((s) => s.t0)) : nominal,
  };
}

interface Picked {
  run: number;
  sent: Sent;
}

interface Composed {
  picked: Picked[];
  runs: Run[];
  cuts: Cut[];
  forcedSeamRun: number | null;
}

function cutRuns(sents: [Sent[], Sent[]], input: Run[], anchorTimes: number[], hi: number, headEnd: boolean): { picked: Picked[]; cuts: Cut[]; runs: Run[] } {
  let runs = input.map((r) => ({ ...r }));
  for (;;) {
    const cuts: Cut[] = [];
    let floor = -Infinity;
    for (let i = 0; i + 1 < runs.length; i++) {
      const nominal = runs[i]!.t1;
      const isHead = headEnd && i === 0;
      const isTail = i + 2 === runs.length && nominal >= hi - EPS;
      // Windows stay inside the two runs they join, so a short fallback run is not jumped over.
      const win: [number, number] = isHead
        ? [nominal, Math.min(nominal + 60, runs[i + 1]!.t1)]
        : isTail
          ? [Math.max(nominal - 60, runs[i]!.t0), nominal]
          : [nominal - 10, nominal + 10];
      const cut = pickCut(sents[runs[i]!.src], sents[runs[i + 1]!.src], nominal, win, anchorTimes, floor);
      cuts.push(cut);
      floor = Math.max(floor, cut.x);
    }
    // A middle run whose two cuts cross holds nothing: drop it and let its neighbours join.
    const empty = runs.findIndex((_, r) => r > 0 && r < runs.length - 1 && cuts[r]!.x <= cuts[r - 1]!.y + EPS);
    if (empty < 0) {
      const picked: Picked[] = [];
      runs.forEach((run, r) => {
        const from = r === 0 ? -Infinity : cuts[r - 1]!.y;
        const to = r === runs.length - 1 ? Infinity : cuts[r]!.x;
        for (const s of sents[run.src]) if (s.t0 >= from - EPS && s.t0 < to - EPS) picked.push({ run: r, sent: s });
      });
      return { picked, cuts, runs };
    }
    const next: Run[] = [];
    runs.forEach((run, r) => {
      if (r === empty) return;
      const last = next[next.length - 1];
      if (last !== undefined && last.src === run.src) last.t1 = run.t1;
      else next.push(run);
    });
    runs = next;
  }
}

function composeAligned(tracks: [Track, Track], al: Alignment): Composed {
  const sents: [Sent[], Sent[]] = [buildSentences(tracks[0], 0), buildSentences(tracks[1], 1)];
  const cover = tracks.map((t) => {
    const times = t.m.segs.map((s) => segTimes(t, s));
    return [minOf(times.map((x) => x[0])), maxOf(times.map((x) => x[1]))] as [number, number];
  });
  const lo = Math.max(cover[0]![0], cover[1]![0]);
  const hi = Math.min(cover[0]![1], cover[1]![1]);
  const first: 0 | 1 = cover[1]![0] < cover[0]![0] ? 1 : 0;
  const secondEndsLater = cover[1]![1] > cover[0]![1] ? 1 : 0;
  const lastSrc: 0 | 1 = (secondEndsLater === 1 ? 1 : 0);
  const start = Math.min(cover[0]![0], cover[1]![0]);
  const end = Math.max(cover[0]![1], cover[1]![1]);
  const raw: Run[] = [];
  if (lo > start + EPS) raw.push({ src: first, t0: start, t1: lo });
  if (hi > lo + EPS) {
    const p: 0 | 1 = tracks[1].m.rank < tracks[0].m.rank ? 1 : 0;
    const q: 0 | 1 = p === 0 ? 1 : 0;
    let t = lo;
    while (t < hi - EPS) {
      let e = Math.min(t + RUN_SPAN_S, hi);
      if (hi - e < RUN_SPAN_MIN_TAIL_S) e = hi;
      const cp = wordsIn(sents[p], t, e);
      const cq = wordsIn(sents[q], t, e);
      raw.push({ src: cp === 0 && cq > 0 ? q : cp < SWITCH_SHARE * cq ? q : p, t0: t, t1: e });
      t = e;
    }
  }
  if (end > Math.max(hi, lo) + EPS) raw.push({ src: lastSrc, t0: Math.max(hi, lo), t1: end });
  const runs: Run[] = [];
  for (const r of raw) {
    const last = runs[runs.length - 1];
    if (last !== undefined && last.src === r.src) last.t1 = r.t1;
    else runs.push({ ...r });
  }
  const anchorTimes = al.anchors.map((a) => a.ta);
  const cut = cutRuns(sents, runs, anchorTimes, hi, lo > start + EPS);
  return { picked: cut.picked, runs: cut.runs, cuts: cut.cuts, forcedSeamRun: null };
}

function composeForced(tracks: [Track, Track]): Composed {
  const sents: [Sent[], Sent[]] = [buildSentences(tracks[0], 0), buildSentences(tracks[1], 1)];
  const runs: Run[] = [
    { src: 0, t0: sents[0][0]!.t0, t1: maxOf(sents[0].map((s) => s.t1)) },
    { src: 1, t0: minOf(sents[1].map((s) => s.t0)), t1: maxOf(sents[1].map((s) => s.t1)) },
  ];
  const picked: Picked[] = [];
  runs.forEach((_, r) => { for (const s of sents[r]) picked.push({ run: r, sent: s }); });
  return { picked, runs, cuts: [{ x: runs[0]!.t1, y: runs[1]!.t0 }], forcedSeamRun: 1 };
}

// ── Speaker naming ───────────────────────────────────────────────────────────────────────────

interface Naming {
  /** Per member, per generic label: the accepted name (or null). */
  labelMap: Map<string, string | null>[];
  /** Per member, per segment index: the name taken from the overlapping named turn. */
  segName: Map<number, string>[];
  entries: StitchSpeakerMapEntry[];
}

function nameSpeakers(tracks: [Track, Track]): Naming {
  const labelMap: Map<string, string | null>[] = [new Map(), new Map()];
  const segName: Map<number, string>[] = [new Map(), new Map()];
  const entries: StitchSpeakerMapEntry[] = [];
  for (const u of [0, 1] as const) {
    const o = u === 0 ? 1 : 0;
    const named = tracks[o].m.segs
      .map((s) => ({ name: s.speaker, t: segTimes(tracks[o], s) }))
      .filter((s): s is { name: string; t: [number, number] } => isRealName(s.name));
    if (named.length === 0) continue;
    const perLabel = new Map<string, Map<string, number>>();
    tracks[u].m.segs.forEach((s) => {
      if (s.speaker === null || !SPEAKER_N.test(s.speaker.trim())) return;
      const [ts, te] = segTimes(tracks[u], s);
      const secs = new Map<string, number>();
      for (const n of named) {
        const ov = Math.min(te, n.t[1]) - Math.max(ts, n.t[0]);
        if (ov > 0) secs.set(n.name, (secs.get(n.name) ?? 0) + ov);
      }
      const label = s.speaker.trim();
      const acc = perLabel.get(label) ?? new Map<string, number>();
      perLabel.set(label, acc);
      for (const [name, v] of secs) acc.set(name, (acc.get(name) ?? 0) + v);
      const total = [...secs.values()].reduce((p, q) => p + q, 0);
      if (total > 0 && total >= Math.max(0.5, 0.25 * (te - ts))) {
        const win = [...secs].sort((p, q) => q[1] - p[1] || (p[0] < q[0] ? -1 : 1))[0]!;
        segName[u]!.set(s.index, win[0]);
      }
    });
    for (const label of [...perLabel.keys()].sort()) {
      const secs = perLabel.get(label)!;
      const total = [...secs.values()].reduce((p, q) => p + q, 0);
      const win = total > 0 ? [...secs].sort((p, q) => q[1] - p[1] || (p[0] < q[0] ? -1 : 1))[0]! : null;
      const share = win === null ? 0 : win[1] / total;
      const accepted = win !== null && share >= 0.5 ? win[0] : null;
      labelMap[u]!.set(label, accepted);
      entries.push({ source: tracks[u].m.source, source_id: tracks[u].m.sourceId, label, name: accepted, share: round3(share), seconds: round3(total) });
    }
  }
  return { labelMap, segName, entries };
}

function speakerFor(track: Track, which: 0 | 1, s: Seg, naming: Naming): string | null {
  if (s.speaker === null) return null;
  const label = s.speaker.trim();
  const generic = SPEAKER_N.exec(label);
  if (generic === null) return s.speaker;
  return naming.segName[which]!.get(s.index) ?? naming.labelMap[which]!.get(label) ?? `Speaker ${generic[1]} (${track.m.label})`;
}

// ═══ 5. PROVENANCE ═══════════════════════════════════════════════════════════════════════════
// DATA-HANDLING: records, for every output segment, which source segment it came from (and which
// segments of the other source cover the same time), keeps the original speaker label, and builds
// the member records with the sha256 of each input body.

function relationOf(cover: [number, number][]): StitchRelation {
  const [a, b] = cover as [[number, number], [number, number]];
  const tol = Math.max(30, 0.05 * Math.max(a[1] - a[0], b[1] - b[0]));
  const sameStart = Math.abs(a[0] - b[0]) <= tol;
  const sameEnd = Math.abs(a[1] - b[1]) <= tol;
  if (sameStart && sameEnd) return "same-span";
  const aInB = a[0] >= b[0] - tol && a[1] <= b[1] + tol;
  const bInA = b[0] >= a[0] - tol && b[1] <= a[1] + tol;
  return aInB || bInA ? "contained" : "partial";
}

function emit(tracks: [Track, Track], composed: Composed, naming: Naming, shift: number): StitchedSegment[] {
  const sents: [Sent[], Sent[]] = [buildSentences(tracks[0], 0), buildSentences(tracks[1], 1)];
  const out: StitchedSegment[] = [];
  // One output segment per source segment per run, even when other speakers' sentences interleave.
  const groups: { run: number; sents: Sent[] }[] = [];
  const byKey = new Map<string, { run: number; sents: Sent[] }>();
  for (const p of composed.picked) {
    const key = `${p.run}:${p.sent.track}:${p.sent.seg}`;
    const g = byKey.get(key);
    if (g !== undefined) g.sents.push(p.sent);
    else {
      const created = { run: p.run, sents: [p.sent] };
      byKey.set(key, created);
      groups.push(created);
    }
  }
  for (const g of groups) {
    const first = g.sents[0]!;
    const last = g.sents[g.sents.length - 1]!;
    const which = first.track;
    const track = tracks[which];
    const seg = track.m.segs[first.seg]!;
    const whole = first.k === 0 && last.k === last.kn - 1;
    const [ts, te] = segTimes(track, seg);
    const start = whole ? ts : first.t0;
    const end = whole ? te : last.t1;
    const text = whole ? seg.text : seg.text.slice(first.c0, last.c1);
    const sources: SourceRef[] = [{ source: track.m.source, source_id: track.m.sourceId, index: seg.index, speaker_label: seg.speaker, chosen: true }];
    const row: StitchedSegment = {
      index: 0,
      speaker_name: speakerFor(track, which, seg, naming),
      text,
      start_time: round3(start - shift),
      end_time: round3(end - shift),
      sources,
    };
    if (composed.forcedSeamRun === g.run && g === groups.find((x) => x.run === g.run)) row.seam = "forced";
    // The other source's sentences in the same stretch: kept as the alternate, never merged in.
    const other = which === 0 ? 1 : 0;
    if (composed.forcedSeamRun === null) {
      const lo = first.t0 - EPS;
      const hi = last.t1 + EPS;
      const alt = sents[other].filter((s) => (s.t0 + s.t1) / 2 >= lo && (s.t0 + s.t1) / 2 <= hi);
      if (alt.length > 0) {
        const om = tracks[other].m;
        const texts: string[] = [];
        const seen = new Set<number>();
        for (const s of alt) {
          const oseg = om.segs[s.seg]!;
          texts.push(oseg.text.slice(s.c0, s.c1));
          if (!seen.has(s.seg)) {
            seen.add(s.seg);
            sources.push({ source: om.source, source_id: om.sourceId, index: oseg.index, speaker_label: oseg.speaker, chosen: false });
          }
        }
        row.alternate = { source: om.source, source_id: om.sourceId, text: texts.join(" ") };
      }
    }
    out.push(row);
  }
  out.forEach((s, i) => { s.index = i; });
  return out;
}

function coverageOf(body: StitchedSegment[], source: string, sourceId: string): [number, number][] {
  const out: [number, number][] = [];
  for (const s of body) {
    if (!s.sources.some((r) => r.chosen && r.source === source && r.source_id === sourceId)) continue;
    const last = out[out.length - 1];
    if (last !== undefined && s.start_time - last[1] <= 2) last[1] = Math.max(last[1], s.end_time);
    else out.push([s.start_time, s.end_time]);
  }
  return out;
}

function evidenceOf(al: Alignment): StitchEvidence {
  return {
    time_window: al.timeWindow,
    shared_phrases: al.shared,
    matching_phrases: al.anchors.length,
    anchors_per_min: round3(al.perMin),
    span_s: round3(al.spanS),
    shorter_capture_s: round3(al.shorterS),
    passed: al.passed,
  };
}

// ═══ Entry point ═════════════════════════════════════════════════════════════════════════════

export function stitchMeetings(snapA: MeetingSnapshot, snapB: MeetingSnapshot, options: StitchOptions = {}): StitchResult {
  const read = [readMember(snapA, "a"), readMember(snapB, "b")];
  if (read[0]!.ref === read[1]!.ref) throw new StitchInputError("members a and b are the same capture");
  const [m0, m1] = read.sort((x, y) => (x.ref < y.ref ? -1 : 1)) as [Member, Member];

  const al = align(m0, m1);
  const timeOk = al.timeWindow !== "no-overlap";
  const same = timeOk && al.anchors.length > 0 && al.passed;
  const evidence = evidenceOf(al);
  const refusal = { verdict: "not-same-meeting" as const, reason: timeOk ? ("anchor-rule" as const) : ("no-time-overlap" as const) };

  if (!same && options.force !== true) {
    return { ...refusal, forced: false, offset_s: null, relation: "none", evidence, members: [], speaker_map: [], seams: [], combined: null };
  }

  let tracks: [Track, Track];
  let offsetS: number | null;
  let relation: StitchRelation;
  let shift: number;
  if (same) {
    offsetS = round3(al.offset!);
    tracks = [{ m: m0, map: (t) => t }, { m: m1, map: al.map }];
    shift = Math.min(0, al.map(0));
    const cover = tracks.map((t) => {
      const times = t.m.segs.map((s) => segTimes(t, s));
      return [minOf(times.map((x) => x[0])), maxOf(times.map((x) => x[1]))] as [number, number];
    });
    relation = relationOf(cover);
  } else {
    // Forced: earlier clock start first; the later capture is laid after it at its clock time.
    const earlier = m0.trustedStart && m1.trustedStart && m1.startMs! < m0.startMs! ? m1 : m0;
    const later = earlier === m0 ? m1 : m0;
    const firstEnd = earlier.lastS;
    const clock = earlier.trustedStart && later.trustedStart ? (later.startMs! - earlier.startMs!) / 1000 : 0;
    const placed = Math.max(clock, firstEnd - later.firstS);
    tracks = [{ m: earlier, map: (t) => t }, { m: later, map: (t) => t + placed }];
    shift = 0;
    offsetS = null;
    relation = "none";
  }

  const composed = same ? composeAligned(tracks, al) : composeForced(tracks);
  const naming = same ? nameSpeakers(tracks) : { labelMap: [new Map(), new Map()], segName: [new Map(), new Map()], entries: [] } as Naming;
  const body = emit(tracks, composed, naming, shift);

  const members: StitchMemberResult[] = [m0, m1].map((m) => {
    const t = tracks[0].m === m ? tracks[0] : tracks[1];
    const delta = round3(t.map(0) - shift);
    return {
      source: m.source,
      source_id: m.sourceId,
      relation,
      offset_s: delta,
      coverage: coverageOf(body, m.source, m.sourceId),
      body_sha256: m.bodySha,
    };
  });

  const sourceId = stitchedSourceId([m0.ref, m1.ref]);
  const seams: StitchSeam[] = composed.cuts.map((c, i) => ({
    time_s: round3(c.x - shift),
    from_source: tracks[composed.runs[i]!.src].m.source,
    to_source: tracks[composed.runs[i + 1]!.src].m.source,
    gap_s: round3(c.y - c.x),
  }));

  const firstMember = tracks[0].map(0) - 0 <= tracks[1].map(0) ? tracks[0].m : tracks[1].m;
  // The earlier member's clock; when it is untrusted or missing, the other member's trusted clock.
  const otherMember = firstMember === tracks[0].m ? tracks[1].m : tracks[0].m;
  const otherPosS = (tracks[0].m === otherMember ? tracks[0] : tracks[1]).map(0) - shift;
  const startedAtMs = firstMember.trustedStart ? firstMember.startMs : otherMember.trustedStart ? otherMember.startMs! - otherPosS * 1000 : firstMember.startMs;
  const bestTitle = [m0, m1].sort((x, y) => x.titleRank - y.titleRank || (x.ref < y.ref ? -1 : 1)).find((m) => m.title !== null)?.title ?? null;
  const names: { name: string; email: string | null }[] = [];
  const seen = new Set<string>();
  const addName = (name: string, email: string | null) => {
    const key = name.trim().toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    names.push({ name, email });
  };
  for (const m of [m0, m1]) for (const p of m.participants) addName(p.name, p.email);
  for (const s of body) if (isRealName(s.speaker_name)) addName(s.speaker_name!, null);
  const endS = body.length > 0 ? maxOf(body.map((s) => s.end_time)) : 0;

  const combined: StitchedMeeting = {
    row: {
      id: connectorRowId(MERGED_SOURCE, sourceId),
      source: MERGED_SOURCE,
      source_id: sourceId,
      title: bestTitle,
      started_at: startedAtMs === null ? null : new Date(startedAtMs).toISOString(),
      duration_secs: Math.round(endS),
      organizer_email: null,
      participants: names,
      summary_overview: null,
      summary_action_items: null,
      keywords: null,
      meeting_type: null,
      metadata: {
        merge: {
          v: 1,
          algorithm: STITCH_ALGORITHM,
          decided_by: "user",
          ...(same ? {} : { forced: true as const }),
          members,
          detection: { anchors_per_min: evidence.anchors_per_min, span_s: evidence.span_s, passed: evidence.passed && timeOk },
        },
      },
    },
    body,
  };

  return {
    verdict: same ? "same-meeting" : "not-same-meeting",
    reason: same ? null : refusal.reason,
    forced: !same,
    offset_s: offsetS,
    relation,
    evidence,
    members,
    speaker_map: naming.entries,
    seams,
    combined,
  };
}
