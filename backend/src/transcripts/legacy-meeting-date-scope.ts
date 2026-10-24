export interface CalendarContext { localDate: string; timeZone: string }

const relativeDates = ["today", "yesterday", "last_week", "this_week", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

function validCalendarDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
function validTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.length > 100) return false;
  try { new Intl.DateTimeFormat("en", { timeZone: value }).format(0); return true; } catch { return false; }
}

/** Calendar arithmetic uses the supplied local day, independent of DST offsets. */
export function resolveMeetingRelativeDates(relativeDate: string, context?: CalendarContext): { from: string; to: string } | undefined {
  if (!relativeDates.includes(relativeDate) || !validCalendarDate(context?.localDate) || !validTimeZone(context?.timeZone)) return undefined;
  const day = new Date(`${context!.localDate}T12:00:00Z`);
  const shift = (n: number) => new Date(day.getTime() + n * 86400000).toISOString().slice(0, 10);
  const weekday = (day.getUTCDay() + 6) % 7;
  if (relativeDate === "last_week") return { from: shift(-weekday - 7), to: shift(-weekday - 1) };
  if (relativeDate === "this_week") return { from: shift(-weekday), to: shift(6 - weekday) };
  const offset = relativeDate === "today" ? 0 : relativeDate === "yesterday" ? -1 : -((weekday - (relativeDates.indexOf(relativeDate) - 4) + 7) % 7);
  return { from: shift(offset), to: shift(offset) };
}

export interface LegacyMeetingDateScope { from: string; to: string; timeZone: string }

/**
 * Recognize only complete, simple English summary requests whose date scope is
 * unambiguous. This is intentionally not a general natural-language date parser:
 * other wording, quoted topics and selected-meeting follow-ups retain legacy behavior.
 */
export function resolveLegacyMeetingDateScope(question: string, context?: CalendarContext): LegacyMeetingDateScope | undefined {
  const request = question.trim().replace(/[.!?]$/, "").trim().replace(/\s+/g, " ");
  const prefix = /^(?:please )?(?:summari[sz]e|recap) (?:(?:my|our|the) )?/i;
  if (!prefix.test(request)) return undefined;
  const scope = request.replace(prefix, "");
  const trailing = /^meetings(?: with (.+?))? (?:from )?last week(?: with (.+))?$/i.exec(scope);
  const leading = /^last week(?:['’]s)? meetings(?: with (.+))?$/i.exec(scope);
  if (!trailing && !leading) return undefined;
  // Only a single optional participant clause is allowed, with names rather
  // than a second date, topic, selected-meeting reference or instruction.
  if (trailing?.[1] && trailing[2]) return undefined;
  const participant = trailing?.[1] ?? trailing?.[2] ?? leading?.[1];
  if (participant && (
    participant.length > 160
    || !/^[\p{L}\p{M}]+(?:['’-][\p{L}\p{M}]+)*(?: [\p{L}\p{M}]+(?:['’-][\p{L}\p{M}]+)*)*$/u.test(participant)
    || /\b(?:not|never|without|outside|only|if|or|about|after|before|between|since|until|through|during|from|to|in|on|for|called|named|titled|regarding|excluding|except|including|discuss|discussing|last|this|next|previous|prior|earlier|other|another|then|but|today|yesterday|tomorrow|week|month|year|monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|may|june|july|august|september|october|november|december|him|her|them|it|that|those|first|second|third|latest|meeting|meetings|summarize|summarise|recap)\b/i.test(participant)
  )) return undefined;
  const bounds = resolveMeetingRelativeDates("last_week", context);
  return bounds && context ? { ...bounds, timeZone: context.timeZone } : undefined;
}
