// Times in the feed, short: the time alone for today ("9:02"), the day and time on another day ("11 Nov, 9:02"),
// and the year too when it is not this year, each in the reader's own locale and time zone. The full date and time
// stays one hover away, and in the markup for machines.

const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

export function shortTime(at: string, now = Date.now()): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return at;
  const today = new Date(now);
  const time = { hour: "numeric", minute: "2-digit" } as const;
  if (sameDay(date, today)) return date.toLocaleTimeString(undefined, time);
  return date.toLocaleString(undefined, { day: "numeric", month: "short", ...(date.getFullYear() === today.getFullYear() ? {} : { year: "numeric" }), ...time });
}

/**
 * A list's time, relative and short (the design agent, after midnight's "Nov 12, 11:59 PM" pushed the status off the
 * compact card): "12 min", "3 h" the same day, "Yesterday", a weekday within the week ("Mon"), else "12 Nov".
 */
export function relativeTime(at: string, now = Date.now()): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return at;
  const today = new Date(now);
  const minutes = Math.max(1, Math.round((now - date.getTime()) / 60_000));
  if (minutes < 60) return `${minutes} min`;
  if (sameDay(date, today)) return `${Math.floor(minutes / 60)} h`;
  const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
  if (sameDay(date, yesterday)) return "Yesterday";
  if (now - date.getTime() < 6 * 86_400_000) return date.toLocaleDateString(undefined, { weekday: "short" });
  return date.toLocaleDateString(undefined, { day: "numeric", month: "short", ...(date.getFullYear() === today.getFullYear() ? {} : { year: "numeric" }) });
}

/**
 * An open card's header time (the design agent): the time alone today ("1:15 PM"), then "Yesterday", a weekday within
 * the week ("Mon"), else the day ("12 Nov"), so the author's name keeps its room on a phone.
 */
export function dayTime(at: string, now = Date.now()): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return at;
  return sameDay(date, new Date(now)) ? date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) : relativeTime(at, now);
}

/** A card's time: `relative` in lists (compact cards, tiles), `day` in an open card's header; the full stamp on hover. */
export function ShortTime({ at, className, relative = false, day = false }: { at: string; className?: string; relative?: boolean; day?: boolean }) {
  return <time dateTime={at} title={new Date(at).toLocaleString()} className={className}>{relative ? relativeTime(at) : day ? dayTime(at) : shortTime(at)}</time>;
}
