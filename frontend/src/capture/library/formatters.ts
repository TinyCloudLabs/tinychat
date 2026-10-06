// How the Library writes durations, days and times (TC-761). Durations are
// tabular clock times; days are grouped Today, Yesterday, then by date.

/** "0:42", "31:20", "1:02:05". */
export function formatClockDuration(totalSeconds: number): string {
  const total = Math.max(0, Math.round(totalSeconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
}

/** "31 min", "1 h 2 min", "under a minute": the detail's meta line. */
export function formatSpokenDuration(totalSeconds: number): string {
  const minutes = Math.round(totalSeconds / 60);
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return `${minutes} min`;
  const rest = minutes % 60;
  return rest === 0 ? `${Math.floor(minutes / 60)} h` : `${Math.floor(minutes / 60)} h ${rest} min`;
}

function parse(iso: string | null): Date | null {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

function dayStart(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** Whole days between the two dates' local midnights (0 = the same day). */
function daysBetween(earlier: Date, later: Date): number {
  return Math.round((dayStart(later) - dayStart(earlier)) / 86_400_000);
}

function shortDate(date: Date, now: Date): string {
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  });
}

export function timeOfDay(date: Date): string {
  return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/** A row's day group: "Today", "Yesterday", "Oct 3", "Dec 30, 2025", or "No date". */
export function dayGroupLabel(iso: string | null, now: Date): string {
  const date = parse(iso);
  if (!date) return "No date";
  const days = daysBetween(date, now);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return shortDate(date, now);
}

/** When, on a row: the time inside a day group, else the day and time ("Today 9:28", "Oct 5, 2:00 PM"). */
export function rowWhen(iso: string | null, now: Date, grouped: boolean): string | null {
  const date = parse(iso);
  if (!date) return null;
  if (grouped) return timeOfDay(date);
  const days = daysBetween(date, now);
  if (days === 0) return `Today ${timeOfDay(date)}`;
  if (days === 1) return `Yesterday ${timeOfDay(date)}`;
  return `${shortDate(date, now)}, ${timeOfDay(date)}`;
}

/** The detail's meta date: "Oct 5, 2026 · 2:00 PM". */
export function detailWhen(iso: string | null): string | null {
  const date = parse(iso);
  if (!date) return null;
  return `${date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })} · ${timeOfDay(date)}`;
}

/** Consecutive items under their day label, in the order given (newest first). */
export function groupByDay<T extends { startedAt: string | null }>(items: readonly T[], now: Date): { label: string; items: T[] }[] {
  const groups: { label: string; items: T[] }[] = [];
  for (const item of items) {
    const label = dayGroupLabel(item.startedAt, now);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.items.push(item);
    else groups.push({ label, items: [item] });
  }
  return groups;
}
