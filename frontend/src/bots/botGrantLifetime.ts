export const BOT_GRANT_MAX_LIFETIME_MS = 7 * 86_400_000;

/** Bounds a bot child grant to seven days and to the parent session. */
export function botGrantLifetime(siwe: string, now = Date.now()): number {
  const expires = Date.parse(/^Expiration Time:\s*(\S+)/im.exec(siwe)?.[1] ?? "");
  return Math.min(BOT_GRANT_MAX_LIFETIME_MS, expires - now);
}
