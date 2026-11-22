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

const SOURCE_ID_MAX_LENGTH = 512;
const ISO_MAX_LENGTH = 64;

function isBidiOrDeleteChar(code: number): boolean {
  return (
    code === 0x7f ||
    code === 0x200e ||
    code === 0x200f ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  );
}

function hasDisallowedControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || isBidiOrDeleteChar(code)) return true;
  }
  return false;
}

function stripDisallowedChars(value: string, allowNewlinesAndTabs: boolean): string {
  let out = "";
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (isBidiOrDeleteChar(code)) {
      if (!allowNewlinesAndTabs) out += " ";
      continue;
    }
    if (code <= 0x1f) {
      if (allowNewlinesAndTabs && (code === 0x09 || code === 0x0a || code === 0x0d)) {
        out += value[i]!;
      } else if (!allowNewlinesAndTabs) {
        out += " ";
      }
      continue;
    }
    out += value[i]!;
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
  return (
    value.length > 0 &&
    value.length <= SOURCE_ID_MAX_LENGTH &&
    !value.includes("/") &&
    !value.includes("\\") &&
    !value.includes("..") &&
    !hasDisallowedControlChar(value)
  );
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
