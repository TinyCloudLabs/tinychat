// What the backend's Google `/callback` puts on the URL when it sends a same-tab flow back to the app
// (backend/src/routes/google-oauth.ts, `tab.`/`hometab.`/`onetab.` returns). No imports: originMove.ts reads it
// before the app loads, and googleOAuthSameTab.ts imports originMove.ts.

export const SAME_TAB_STATE_PREFIXES = ["tab.", "hometab.", "onetab."] as const;
export const SAME_TAB_CODE_PARAM = "google_oauth_code";
export const SAME_TAB_ERROR_PARAM = "google_oauth_error";

/** The flow's `state` when `search` is a same-tab Google return, else null. */
export function sameTabReturnState(search: string): string | null {
  const params = new URLSearchParams(search);
  const state = params.get("state");
  if (!state || !SAME_TAB_STATE_PREFIXES.some((prefix) => state.startsWith(prefix))) return null;
  return params.has(SAME_TAB_CODE_PARAM) || params.has(SAME_TAB_ERROR_PARAM) ? state : null;
}
