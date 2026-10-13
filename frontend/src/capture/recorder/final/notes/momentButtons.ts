const MOMENT = /<li([^>]*)><strong>(\d+):(\d{2})(?::(\d{2}))?<\/strong>/g;

/** Seconds into the recording a rendered moment's time names, as `parseMomentLines` counts them. */
export function momentSeconds(
  first: number,
  middle: number,
  last: number | null,
): number | null {
  if (middle > 59 || (last !== null && last > 59)) return null;
  return last === null ? first * 60 + middle : first * 3600 + middle * 60 + last;
}

/** A moment line's bold time ("- **0:42** text") becomes a button that names where it plays from. */
export function buttonizeMoments(html: string): string {
  return html.replace(MOMENT, (whole, attrs: string, a: string, b: string, c?: string) => {
    const seconds = momentSeconds(Number(a), Number(b), c === undefined ? null : Number(c));
    if (seconds === null) return whole;
    const time = c === undefined ? `${a}:${b}` : `${a}:${b}:${c}`;
    const label = `Play from ${time}`;
    return `<li${attrs}><button type="button" class="nt-moment" data-at="${seconds}" title="${label}" aria-label="${label}"><strong>${time}</strong></button>`;
  });
}
