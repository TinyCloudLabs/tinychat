// TC-3195: what a recording share link shows before sign-in (the links record's `display`). The owner writes it but
// does not sign it: a recipient reads it from a link anyone could have made, so every field is checked before it is
// shown, shown as coming with the link (`quotedTitle`, `LINK_DETAILS_CAPTION`), and who shared it never comes from
// here (see `shortAddress`).
import { getAddress } from "viem";

export type SharedPart = "transcript" | "audio";
export type SharedSource = "meeting" | "voice-note" | "upload";

export interface RecordingShareDisplay {
  title: string;
  /** ISO timestamp. */
  recordedAt: string;
  durationSeconds: number | null;
  includes: SharedPart[];
  source: SharedSource;
}

const MAX_TEXT = 200;
// Control characters (C0, DEL, C1) and the bidi controls that can make a title read differently than it is written.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001F\u007F-\u009F]/g;
const BIDI = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.replace(CONTROL, " ").replace(BIDI, "").replace(/\s+/g, " ").trim();
  return cleaned && cleaned.length <= MAX_TEXT ? cleaned : undefined;
}

/** The display of an opened link, or `null` when any field is missing or not what the app writes. Unknown keys are ignored. */
export function parseRecordingDisplay(value: unknown): RecordingShareDisplay | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const title = text(record.title);
  const recordedAt = typeof record.recordedAt === "string" && Number.isFinite(Date.parse(record.recordedAt)) ? new Date(record.recordedAt).toISOString() : undefined;
  const duration = record.durationSeconds;
  const durationOk = duration === null || duration === undefined || (typeof duration === "number" && Number.isFinite(duration) && duration >= 0);
  const includes = record.includes;
  const parts = Array.isArray(includes) ? includes.filter((part): part is SharedPart => part === "transcript" || part === "audio") : [];
  const partsOk = Array.isArray(includes) && parts.length === includes.length && parts.length > 0 && new Set(parts).size === parts.length;
  const source = record.source === "meeting" || record.source === "voice-note" || record.source === "upload" ? record.source : undefined;
  if (!title || !recordedAt || !durationOk || !partsOk || !source) return null;
  return {
    title,
    recordedAt,
    durationSeconds: typeof duration === "number" ? Math.round(duration) : null,
    includes: (["transcript", "audio"] as const).filter((part) => parts.includes(part)),
    source,
  };
}

/**
 * `0xd559…f412`: who shared it, always the owner's address that `inspectShareToken` checked against the owner's
 * signature, cased as `fullAddress` shows it. A name from the display is unsigned, so anyone could write one; a
 * display name needs owner signing first.
 */
export function shortAddress(address: string): string {
  const full = fullAddress(address);
  return full.length > 12 ? `${full.slice(0, 6)}…${full.slice(-4)}` : full;
}

/** The owner's whole address, EIP-55 checksummed, to compare with one the sender gave you. */
export function fullAddress(address: string): string {
  try {
    return getAddress(address);
  } catch {
    return address;
  }
}

/** A title from a link, in curly quotes: the link's maker wrote it, unchecked. */
export function quotedTitle(title: string): string {
  return `“${title}”`;
}

/** Under the title and details a link carries. */
export const LINK_DETAILS_CAPTION = "Title and details come with the link and aren’t checked.";

/** "Transcript and audio", "Transcript" or "Audio". */
export function includesLabel(parts: readonly SharedPart[]): string {
  if (parts.includes("transcript") && parts.includes("audio")) return "Transcript and audio";
  return parts.includes("audio") ? "Audio" : "Transcript";
}

export function sourceLabel(source: SharedSource): string {
  return source === "meeting" ? "Meeting" : source === "upload" ? "Upload" : "Voice note";
}
