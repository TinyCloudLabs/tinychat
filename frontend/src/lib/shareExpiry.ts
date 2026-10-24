import { SHARE_LINK_COPY } from "./shareLinkCopy";

const DAY_MS = 24 * 60 * 60 * 1000;

function startOfLocalDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/**
 * "Expires …" line for a share link, in the viewer's locale: medium date plus short time,
 * or "today at {time}" / "tomorrow at {time}" when the link expires less than 24 hours from `now`.
 */
export function formatShareExpiry(expiresAt: string, now: number, locale?: string | string[]): string {
  const expires = new Date(expiresAt);
  if (Number.isNaN(expires.getTime())) return SHARE_LINK_COPY.expires(expiresAt);
  const remaining = expires.getTime() - now;
  if (remaining >= 0 && remaining < DAY_MS) {
    const time = new Intl.DateTimeFormat(locale, { timeStyle: "short" }).format(expires);
    const sameDay = startOfLocalDay(expires) === startOfLocalDay(new Date(now));
    return SHARE_LINK_COPY.expires(sameDay ? SHARE_LINK_COPY.todayAt(time) : SHARE_LINK_COPY.tomorrowAt(time));
  }
  return SHARE_LINK_COPY.expires(new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(expires));
}

/** Drops links whose expiry is at or before `now`; an unreadable expiry is dropped too. */
export function unexpiredShares<T extends { expiresAt: string }>(shares: readonly T[], now: number): T[] {
  return shares.filter((share) => Date.parse(share.expiresAt) > now);
}
