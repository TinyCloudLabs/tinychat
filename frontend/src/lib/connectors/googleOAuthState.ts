import { CANONICAL_ORIGIN } from "../originMove";

/** The Home app's second web origin: the same build, served from tinycloud.one. */
export const TINYCLOUD_ONE_ORIGIN = "https://tinycloud.one";

/**
 * The `state` tag the backend maps to a fixed return origin: `home` for home.tinycloud.xyz, `one` for tinycloud.one,
 * none (the untagged flow, which returns to the backend's FRONTEND_URL) anywhere else.
 */
export type OAuthReturnTag = "home" | "one";

export function oauthReturnTag(origin: string | undefined = globalThis.location?.origin): OAuthReturnTag | null {
  if (origin === CANONICAL_ORIGIN) return "home";
  if (origin === TINYCLOUD_ONE_ORIGIN) return "one";
  return null;
}

/**
 * The popup flow's `state`: `<tag>.<nonce>` on a tagged origin so the backend posts to that origin, else the bare
 * nonce (the backend's FRONTEND_URL, tinycloud.chat).
 */
export function popupOAuthState(nonce: string, tag: OAuthReturnTag | null = oauthReturnTag()): string {
  return tag ? `${tag}.${nonce}` : nonce;
}
