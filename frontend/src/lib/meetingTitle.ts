/** Title for a transcribed voice note: `<Mon D> · <Name1, Name2>`. Pure: no network, no clock. */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MAX_TITLE_LENGTH = 120;
const MAX_NAMES = 3;
const MAX_NAME_LENGTH = 40;
/** Generic speaker and placeholder labels from recorded notes and diarization; they are not names. */
const GENERIC_NAMES = new Set(["me", "them", "unknown", "unknown speaker", "speaker", "guest", "host"]);
// "Them 2" is one person of the other side of a recorded call, as unnamed as "Speaker 2".
const SPEAKER_LABEL = /^(speaker(\s*\d+|\s*[a-z])?|them\s*\d+)$/i;
const PARTICIPANT_LABEL = /^participant\s*\d*$/i;

/**
 * Whether a participant or speaker value can be a person's name. Not names: an empty value, a generic label
 * ("Speaker 2", "Them"), and contact details (an email address, or a phone number: 7+ digits and no letters).
 */
export function isPersonName(name: string): boolean {
  if (!name || GENERIC_NAMES.has(name.toLowerCase()) || SPEAKER_LABEL.test(name) || PARTICIPANT_LABEL.test(name)) return false;
  const digits = name.replace(/\D/g, "").length;
  return !name.includes("@") && !(digits >= 7 && !/\p{L}/u.test(name));
}

export interface AutoMeetingTitleInput {
  startedAt: unknown;
  participantNames: unknown;
}

/** Null when there is no usable start date or no real participant name; the caller then keeps the title it already has. */
export function autoMeetingTitle(input: AutoMeetingTitleInput): string | null {
  const date = monthDay(input.startedAt);
  const names = participantSummary(input.participantNames);
  if (!date || !names) return null;
  return truncate(`${date} · ${names}`, MAX_TITLE_LENGTH);
}

function monthDay(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const when = new Date(value);
  if (Number.isNaN(when.getTime())) return null;
  return `${MONTHS[when.getMonth()]} ${when.getDate()}`;
}

function cleanText(value: unknown): string {
  if (typeof value !== "string") return "";
  const printable = [...value].map((ch) => {
    const code = ch.codePointAt(0) ?? 0;
    return code <= 0x1f || (code >= 0x7f && code <= 0x9f) || ch === "<" || ch === ">" ? " " : ch;
  }).join("");
  return printable.replace(/\s+/g, " ").trim();
}

function participantSummary(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const seen = new Set<string>();
  const names: string[] = [];
  for (const raw of value) {
    const name = cleanText(raw);
    const key = name.toLowerCase();
    if (seen.has(key) || !isPersonName(name)) continue;
    seen.add(key);
    names.push(truncate(name, MAX_NAME_LENGTH));
  }
  if (names.length === 0) return null;
  const shown = names.slice(0, MAX_NAMES).join(", ");
  const hidden = names.length - MAX_NAMES;
  return hidden > 0 ? `${shown} +${hidden}` : shown;
}

function truncate(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join("")}…`;
}
