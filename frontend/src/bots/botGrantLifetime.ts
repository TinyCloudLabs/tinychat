export const BOT_GRANT_MAX_LIFETIME_MS = 7 * 86_400_000;

/** Bounds a bot child grant to seven days and to the parent session. */
export function botGrantLifetime(siwe: string, now = Date.now()): number {
  const expires = Date.parse(/^Expiration Time:\s*(\S+)/im.exec(siwe)?.[1] ?? "");
  return Math.min(BOT_GRANT_MAX_LIFETIME_MS, expires - now);
}

/**
 * When the session signed in by `siwe` stops carrying authority, in Unix ms: its signed end, or the later renewed end
 * that `bearer` carries for this session's own key. The backend binds that end into the bearer it issues at
 * verify-renewal, from the node's renewal record, and accepts this session's descriptors and grants up to it; One
 * only reads it to stay inside what the backend accepts. NaN when neither end is known.
 */
export function sessionAuthorityEnd(siwe: string, bearer: string | null): number {
  const signed = Date.parse(/^Expiration Time:\s*(\S+)/im.exec(siwe)?.[1] ?? "");
  const sessionDid = /^URI:\s*(did:key:[^\s#]+)/im.exec(siwe)?.[1];
  let renewed = Number.NaN;
  try {
    const claims = bearer?.split(".")[1]?.replace(/-/g, "+").replace(/_/g, "/");
    const payload: unknown = claims ? JSON.parse(atob(claims.padEnd(Math.ceil(claims.length / 4) * 4, "="))) : undefined;
    const renewal = typeof payload === "object" && payload !== null && "renewal" in payload ? payload.renewal : undefined;
    if (
      sessionDid && typeof renewal === "object" && renewal !== null && "sessionDid" in renewal && "end" in renewal &&
      renewal.sessionDid === sessionDid && typeof renewal.end === "number" && Number.isSafeInteger(renewal.end)
    ) {
      renewed = renewal.end * 1000;
    }
  } catch {
    // Not a bearer this backend issued: the signed end stands.
  }
  return Number.isFinite(renewed) && !(renewed <= signed) ? renewed : signed;
}
