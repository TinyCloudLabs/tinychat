import { CANONICAL_ORIGIN } from "../originMove";

/**
 * The popup flow's `state`: `home.<nonce>` on home.tinycloud.xyz so the backend posts to that origin, else the bare
 * nonce (the backend's FRONTEND_URL, tinycloud.chat).
 */
export function popupOAuthState(nonce: string, homeOrigin: boolean = globalThis.location?.origin === CANONICAL_ORIGIN): string {
  return homeOrigin ? `home.${nonce}` : nonce;
}
