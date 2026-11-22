import { CONNECTORS_KV_PREFIX, connectorMeetingId } from "./connector-meeting.js";

export const FIREFLIES_MEETING_SOURCE = "fireflies" as const;
export const FIREFLIES_SERVER_IMPORT_TAG = "server-import" as const;
export const FIREFLIES_MEETING_KV_PREFIX = `${CONNECTORS_KV_PREFIX}/${FIREFLIES_MEETING_SOURCE}/meeting/`;
export const FIREFLIES_TRANSCRIPT_KV_PREFIX = `${CONNECTORS_KV_PREFIX}/${FIREFLIES_MEETING_SOURCE}/transcript/`;

/** Max UTF-8 bytes accepted for one untrusted KV meeting metadata record. */
export const FIREFLIES_KV_RECORD_MAX_BYTES = 128 * 1024;
/** Max KV meeting records promoted per list scan. */
export const FIREFLIES_KV_LIST_MAX_RECORDS = 500;
/** Max KV list pages scanned for a single discovery pass. */
export const FIREFLIES_KV_LIST_MAX_PAGES = 20;

export const FIREFLIES_KV_TITLE_MAX_LENGTH = 512;
export const FIREFLIES_KV_SUMMARY_MAX_LENGTH = 4_096;
export const FIREFLIES_KV_ORGANIZER_MAX_LENGTH = 254;
export const FIREFLIES_KV_PARTICIPANTS_MAX_COUNT = 100;
export const FIREFLIES_KV_PARTICIPANT_NAME_MAX_LENGTH = 160;
export const FIREFLIES_KV_PARTICIPANT_EMAIL_MAX_LENGTH = 254;
export const FIREFLIES_KV_MAX_DURATION_SECS = 7 * 86_400;

const SAFE_FIREFLIES_SOURCE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const ISO_MAX_LENGTH = 64;

function isDisallowedCodePoint(cp: number, allowNewlinesAndTabs: boolean): boolean {
  // Lone UTF-16 surrogates.
  if (cp >= 0xd800 && cp <= 0xdfff) return true;
  // C0 controls (optionally keep HT, LF, CR for multiline summaries).
  if (cp <= 0x1f) {
    return !(allowNewlinesAndTabs && (cp === 0x09 || cp === 0x0a || cp === 0x0d));
  }
  // DEL + C1 controls (0x7f-0x9f).
  if (cp >= 0x7f && cp <= 0x9f) return true;
  // Zero-width chars, word joiner, BOM, bidi marks/overrides, line/paragraph separators.
  if (
    (cp >= 0x200b && cp <= 0x200f) ||
    cp === 0x2028 ||
    cp === 0x2029 ||
    (cp >= 0x202a && cp <= 0x202e) ||
    cp === 0x2060 ||
    (cp >= 0x2066 && cp <= 0x2069) ||
    cp === 0xfeff
  ) {
    return true;
  }
  // Unicode Tag characters (U+E0000-U+E007F).
  if (cp >= 0xe0000 && cp <= 0xe007f) return true;
  return false;
}

function stripDisallowedChars(value: string, allowNewlinesAndTabs: boolean): string {
  let out = "";
  for (let i = 0; i < value.length; i += 1) {
    const unit = value.charCodeAt(i);
    let cp = unit;
    let step = 1;
    // Decode valid surrogate pairs so astral Tag chars (U+E0000-U+E007F) are caught and lone surrogates stay 0xd800-0xdfff.
    if (unit >= 0xd800 && unit <= 0xdbff && i + 1 < value.length) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        cp = ((unit - 0xd800) << 10) + (next - 0xdc00) + 0x10000;
        step = 2;
      }
    }
    if (isDisallowedCodePoint(cp, allowNewlinesAndTabs)) {
      if (!allowNewlinesAndTabs) out += " ";
    } else {
      out += step === 2 ? value.slice(i, i + 2) : value[i]!;
    }
    if (step === 2) i += 1;
  }
  return out;
}

export interface FirefliesKvDiscoveryStats {
  listed: number;
  promoted: number;
  shadowedBySql: number;
  purged: number;
  garbled: number;
  oversize: number;
  missing: number;
  truncated: boolean;
}

export function emptyFirefliesKvDiscoveryStats(): FirefliesKvDiscoveryStats {
  return {
    listed: 0,
    promoted: 0,
    shadowedBySql: 0,
    purged: 0,
    garbled: 0,
    oversize: 0,
    missing: 0,
    truncated: false,
  };
}

export interface PromotedFirefliesKvRecord {
  id: string;
  source: typeof FIREFLIES_MEETING_SOURCE;
  importSource: typeof FIREFLIES_SERVER_IMPORT_TAG;
  sourceId: string;
  title: string | null;
  startedAt: string | null;
  durationSecs: number | null;
  organizerEmail: string | null;
  participantNames: string[];
  participantEmails: string[];
  participantsLimited: boolean;
  summaryOverview: string | null;
  summaryActionItems: string | null;
  importedAt: string | null;
  hasTranscript: boolean;
  hasSummary: boolean;
  /** Safe closed-allowlist provenance metadata only (never opaque untrusted fields). */
  metadata: Record<string, unknown>;
}

export type ParseFirefliesKvRecordResult =
  | { ok: true; record: PromotedFirefliesKvRecord }
  | { ok: false; reason: "oversize" | "garbled" };

export function firefliesMeetingKvKey(sourceId: string): string {
  return `${FIREFLIES_MEETING_KV_PREFIX}${sourceId}`;
}

export function isSafeFirefliesSourceId(value: string): boolean {
  return SAFE_FIREFLIES_SOURCE_ID_RE.test(value);
}

/** Extract and validate the meeting sourceId from a Fireflies KV meeting key, or null. */
export function extractFirefliesMeetingSourceId(key: string): string | null {
  if (!key.startsWith(FIREFLIES_MEETING_KV_PREFIX)) return null;
  const sourceId = key.slice(FIREFLIES_MEETING_KV_PREFIX.length);
  return isSafeFirefliesSourceId(sourceId) ? sourceId : null;
}

function sanitizeSingleLine(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const cleaned = stripDisallowedChars(value, false).replace(/\s+/g, " ").trim().slice(0, maxLength).trim();
  return cleaned.length > 0 ? cleaned : null;
}

function sanitizeMultiline(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const cleaned = stripDisallowedChars(value, true).trim().slice(0, maxLength).trim();
  return cleaned.length > 0 ? cleaned : null;
}

function sanitizeIsoTimestamp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > ISO_MAX_LENGTH) return null;
  return Number.isFinite(Date.parse(trimmed)) ? trimmed : null;
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

/**
 * Strictly validate and sanitize one untrusted Fireflies KV meeting record.
 *
 * Security invariants:
 * - Enforces byte cap (`maxBytes`) before trusting any fields.
 * - Rejects identity spoofing: `source` must be `"fireflies"`, `sourceId` must match the KV key
 *   segment, and `id` (if present) must equal the deterministic `connectorMeetingId("fireflies", sourceId)`.
 * - Strips control and bidi-override characters and bounds every string and array field.
 * - Drops arbitrary opaque `metadata` keys and tags the promoted record with `importSource: "server-import"`.
 */
export async function parseFirefliesKvMeetingRecord(
  raw: unknown,
  expectedSourceId: string,
  options?: { maxBytes?: number },
): Promise<ParseFirefliesKvRecordResult> {
  if (!isSafeFirefliesSourceId(expectedSourceId)) return { ok: false, reason: "garbled" };
  const maxBytes = options?.maxBytes ?? FIREFLIES_KV_RECORD_MAX_BYTES;

  let parsed: unknown;
  if (typeof raw === "string") {
    if (utf8ByteLength(raw) > maxBytes) return { ok: false, reason: "oversize" };
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { ok: false, reason: "garbled" };
    }
  } else if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    let serialized: string;
    try {
      serialized = JSON.stringify(raw);
    } catch {
      return { ok: false, reason: "garbled" };
    }
    if (utf8ByteLength(serialized) > maxBytes) return { ok: false, reason: "oversize" };
    parsed = raw;
  } else {
    return { ok: false, reason: "garbled" };
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "garbled" };
  }
  const obj = parsed as Record<string, unknown>;

  if (obj.source !== undefined && obj.source !== FIREFLIES_MEETING_SOURCE) {
    return { ok: false, reason: "garbled" };
  }
  if (typeof obj.sourceId !== "string" || obj.sourceId !== expectedSourceId) {
    return { ok: false, reason: "garbled" };
  }

  const expectedId = await connectorMeetingId(FIREFLIES_MEETING_SOURCE, expectedSourceId);
  if (obj.id !== undefined && (typeof obj.id !== "string" || obj.id !== expectedId)) {
    return { ok: false, reason: "garbled" };
  }

  const durationSecs =
    typeof obj.durationSecs === "number" &&
    Number.isFinite(obj.durationSecs) &&
    obj.durationSecs >= 0 &&
    obj.durationSecs <= FIREFLIES_KV_MAX_DURATION_SECS
      ? obj.durationSecs
      : null;

  const participantNames: string[] = [];
  const participantEmails: string[] = [];
  const seenNames = new Set<string>();
  const seenEmails = new Set<string>();
  let participantsLimited = false;
  if (Array.isArray(obj.participants)) {
    participantsLimited = obj.participants.length > FIREFLIES_KV_PARTICIPANTS_MAX_COUNT;
    for (const entry of obj.participants.slice(0, FIREFLIES_KV_PARTICIPANTS_MAX_COUNT)) {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
      const p = entry as { name?: unknown; displayName?: unknown; email?: unknown };
      const name = sanitizeSingleLine(
        typeof p.name === "string" ? p.name : p.displayName,
        FIREFLIES_KV_PARTICIPANT_NAME_MAX_LENGTH,
      );
      if (name && !seenNames.has(name)) {
        seenNames.add(name);
        participantNames.push(name);
      }
      const email = sanitizeSingleLine(p.email, FIREFLIES_KV_PARTICIPANT_EMAIL_MAX_LENGTH);
      if (email && !seenEmails.has(email)) {
        seenEmails.add(email);
        participantEmails.push(email);
      }
    }
  }

  const title = sanitizeSingleLine(obj.title, FIREFLIES_KV_TITLE_MAX_LENGTH);
  const startedAt = sanitizeIsoTimestamp(obj.startedAt);
  const organizerEmail = sanitizeSingleLine(obj.organizerEmail, FIREFLIES_KV_ORGANIZER_MAX_LENGTH);
  const summaryOverview = sanitizeMultiline(obj.summaryOverview, FIREFLIES_KV_SUMMARY_MAX_LENGTH);
  const summaryActionItems = sanitizeMultiline(obj.summaryActionItems, FIREFLIES_KV_SUMMARY_MAX_LENGTH);
  const importedAt = sanitizeIsoTimestamp(obj.importedAt);
  const hasTranscript = obj.hasTranscript === true;
  const hasSummary = obj.hasSummary === true || summaryOverview !== null || summaryActionItems !== null;

  const metadata: Record<string, unknown> = {
    import_source: FIREFLIES_SERVER_IMPORT_TAG,
    origin: "fireflies-delegation-import",
    ...(importedAt !== null ? { imported_at: importedAt } : {}),
    has_transcript: hasTranscript,
    has_summary: hasSummary,
  };

  return {
    ok: true,
    record: {
      id: expectedId,
      source: FIREFLIES_MEETING_SOURCE,
      importSource: FIREFLIES_SERVER_IMPORT_TAG,
      sourceId: expectedSourceId,
      title,
      startedAt,
      durationSecs,
      organizerEmail,
      participantNames,
      participantEmails,
      participantsLimited,
      summaryOverview,
      summaryActionItems,
      importedAt,
      hasTranscript,
      hasSummary,
      metadata,
    },
  };
}
