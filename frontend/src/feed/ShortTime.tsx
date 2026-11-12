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

export function ShortTime({ at, className }: { at: string; className?: string }) {
  return <time dateTime={at} title={new Date(at).toLocaleString()} className={className}>{shortTime(at)}</time>;
}
