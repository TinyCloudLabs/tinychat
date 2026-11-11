import { CANONICAL_ORIGIN } from "../originMove";

const KEY_PREFIX = "exo-google-oauth-tab:";

/** `tab.<path>.<nonce>`; `hometab.…` on home.tinycloud.xyz, so the backend returns to that origin. */
export function sameTabState(path: string, nonce: string, homeOrigin: boolean = globalThis.location?.origin === CANONICAL_ORIGIN): string {
  const encoded = btoa(path).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  return `${homeOrigin ? "hometab" : "tab"}.${encoded}.${nonce}`;
}

export function saveSameTabVerifier(state: string, verifier: string, purpose: "connect" | "autojoin"): void {
  sessionStorage.setItem(`${KEY_PREFIX}${state}`, JSON.stringify({ verifier, purpose }));
}

export function pendingSameTabReturn(): { state: string; code: string | null; error: boolean; verifier: string; purpose: "connect" | "autojoin" } | null {
  const params = new URLSearchParams(window.location.search);
  const state = params.get("state");
  if (!state || !(state.startsWith("tab.") || state.startsWith("hometab."))) return null;
  const saved = sessionStorage.getItem(`${KEY_PREFIX}${state}`);
  if (!saved) return null;
  let transaction: { verifier?: unknown; purpose?: unknown };
  try { transaction = JSON.parse(saved) as typeof transaction; } catch { return null; }
  if (typeof transaction.verifier !== "string" ||
    (transaction.purpose !== "connect" && transaction.purpose !== "autojoin")) return null;
  const code = params.get("google_oauth_code");
  const error = params.get("google_oauth_error") === "not_completed";
  return code || error ? { state, code, error, verifier: transaction.verifier, purpose: transaction.purpose } : null;
}

export function clearSameTabReturn(state: string): void {
  sessionStorage.removeItem(`${KEY_PREFIX}${state}`);
  const url = new URL(window.location.href);
  url.searchParams.delete("state");
  url.searchParams.delete("google_oauth_code");
  url.searchParams.delete("google_oauth_error");
  window.history.replaceState(window.history.state, "", url);
}
