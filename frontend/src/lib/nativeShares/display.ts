// TC-3195: what a recording share link shows before sign-in (the links record's `display`). The owner writes
// it; a recipient reads it from a link anyone could have made, so every field is checked before it is shown.

export type SharedPart = "transcript" | "audio";
export type SharedSource = "meeting" | "voice-note" | "upload";

export interface RecordingShareDisplay {
  /** Not written yet: recipients see the sharing account's short address instead (product decision pending). */
  senderName?: string;
  title: string;
  /** ISO timestamp. */
  recordedAt: string;
  durationSeconds: number | null;
  includes: SharedPart[];
  source: SharedSource;
}

const MAX_TEXT = 200;

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= MAX_TEXT ? trimmed : undefined;
}

/** The display of an opened link, or `null` when any field is missing or not what the app writes. */
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
  const senderOk = record.senderName === undefined || text(record.senderName) !== undefined;
  if (!title || !recordedAt || !durationOk || !partsOk || !source || !senderOk) return null;
  return {
    ...(record.senderName === undefined ? {} : { senderName: text(record.senderName) }),
    title,
    recordedAt,
    durationSeconds: typeof duration === "number" ? Math.round(duration) : null,
    includes: (["transcript", "audio"] as const).filter((part) => parts.includes(part)),
    source,
  };
}

/** `0xd559…f412`: the sharing account when the display has no name. */
export function shortAddress(address: string): string {
  return address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}

/** Who shared it: their name, or their account's short address. */
export function senderLabel(display: RecordingShareDisplay, ownerAddress: string): string {
  return display.senderName ?? shortAddress(ownerAddress);
}

/** The first name in sentences like "Alex can stop sharing at any time." */
export function senderFirstName(display: RecordingShareDisplay, ownerAddress: string): string {
  return display.senderName?.split(/\s+/)[0] ?? shortAddress(ownerAddress);
}

/** "Transcript and audio", "Transcript" or "Audio". */
export function includesLabel(parts: readonly SharedPart[]): string {
  if (parts.includes("transcript") && parts.includes("audio")) return "Transcript and audio";
  return parts.includes("audio") ? "Audio" : "Transcript";
}

export function sourceLabel(source: SharedSource): string {
  return source === "meeting" ? "Meeting" : source === "upload" ? "Upload" : "Voice note";
}
