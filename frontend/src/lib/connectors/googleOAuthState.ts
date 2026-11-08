import { HOME_SITE } from "../homeSite";

/** The popup flow's `state`: the bare nonce, or `home.<nonce>` on the Home site so the backend posts to that origin. */
export function popupOAuthState(nonce: string, homeSite: boolean = HOME_SITE): string {
  return homeSite ? `home.${nonce}` : nonce;
}
