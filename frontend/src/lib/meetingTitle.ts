/** Title for a new voice note: `<Mon D> · <model label> · <Name1, Name2>`. Pure: no network, no clock. */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MAX_TITLE_LENGTH = 120;
const MAX_NAMES = 3;
const MAX_NAME_LENGTH = 40;
/** Generic speaker labels from recorded notes and diarization; they are not names. */
const GENERIC_NAMES = new Set(["me", "them", "unknown", "speaker"]);
const SPEAKER_N = /^speaker\s*\d*$/i;

export interface AutoMeetingTitleInput {
  startedAt: unknown;
  modelLabel: unknown;
  participantNames: unknown;
}

/** Null when there is no usable start date; the caller then keeps the title it already has. */
export function autoMeetingTitle(input: AutoMeetingTitleInput): string | null {
  const date = monthDay(input.startedAt);
  if (!date) return null;
  const parts = [date];
  const model = cleanText(input.modelLabel);
  if (model) parts.push(model);
  const names = participantSummary(input.participantNames);
  if (names) parts.push(names);
  return truncate(parts.join(" · "), MAX_TITLE_LENGTH);
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
    return code <= 0x1f || (code >= 0x7f && code <= 0x9f) ? " " : ch;
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
    if (!name || GENERIC_NAMES.has(key) || SPEAKER_N.test(name) || seen.has(key)) continue;
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
