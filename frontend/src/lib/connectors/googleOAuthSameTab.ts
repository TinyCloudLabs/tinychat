import { SAME_TAB_CODE_PARAM, SAME_TAB_ERROR_PARAM, sameTabReturnState } from "./googleOAuthReturn";
import { oauthReturnTag, type OAuthReturnTag } from "./googleOAuthState";

const KEY_PREFIX = "exo-google-oauth-tab:";

/** `tab.<path>.<nonce>`; `hometab.…` on home.tinycloud.xyz and `onetab.…` on tinycloud.one, so the backend returns to that origin. */
export function sameTabState(path: string, nonce: string, tag: OAuthReturnTag | null = oauthReturnTag()): string {
  const encoded = btoa(path).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  return `${tag ?? ""}tab.${encoded}.${nonce}`;
}

export function saveSameTabVerifier(state: string, verifier: string, purpose: "connect" | "autojoin"): void {
  sessionStorage.setItem(`${KEY_PREFIX}${state}`, JSON.stringify({ verifier, purpose }));
}

export function pendingSameTabReturn(): { state: string; code: string | null; error: boolean; verifier: string; purpose: "connect" | "autojoin" } | null {
  const state = sameTabReturnState(window.location.search);
  if (!state) return null;
  const params = new URLSearchParams(window.location.search);
  const saved = sessionStorage.getItem(`${KEY_PREFIX}${state}`);
  if (!saved) return null;
  let transaction: { verifier?: unknown; purpose?: unknown };
  try { transaction = JSON.parse(saved) as typeof transaction; } catch { return null; }
  if (typeof transaction.verifier !== "string" ||
    (transaction.purpose !== "connect" && transaction.purpose !== "autojoin")) return null;
  const code = params.get(SAME_TAB_CODE_PARAM);
  const error = params.get(SAME_TAB_ERROR_PARAM) === "not_completed";
  return code || error ? { state, code, error, verifier: transaction.verifier, purpose: transaction.purpose } : null;
}

export function clearSameTabReturn(state: string): void {
  sessionStorage.removeItem(`${KEY_PREFIX}${state}`);
  const url = new URL(window.location.href);
  url.searchParams.delete("state");
  url.searchParams.delete(SAME_TAB_CODE_PARAM);
  url.searchParams.delete(SAME_TAB_ERROR_PARAM);
  window.history.replaceState(window.history.state, "", url);
}
