/** The fixed origin Tauri assigns to Exo's bundled frontend on macOS. */
export const EXO_DESKTOP_ORIGIN = "tauri://localhost";

/** The fixed origin Tauri assigns to Exo's bundled frontend on Windows. */
export const EXO_DESKTOP_WINDOWS_ORIGIN = "http://tauri.localhost";

/** TinyChat's Cloudflare Pages project, including branch and commit previews. */
export const TINYCHAT_PAGES_ORIGIN = /^https:\/\/(?:[a-z0-9-]+\.)?tinychat-4jq\.pages\.dev$/;

/** Exact origins used by the documented local web development flow. */
export const LOCAL_WEB_ORIGINS = [
  "http://localhost:5186",
  "https://localhost:5186",
] as const;

/** Browser origins allowed to call the TinyChat backend. */
export function appCorsOrigins(frontendOrigin: string): Array<string | RegExp> {
  return [
    frontendOrigin,
    EXO_DESKTOP_ORIGIN,
    EXO_DESKTOP_WINDOWS_ORIGIN,
    TINYCHAT_PAGES_ORIGIN,
    ...LOCAL_WEB_ORIGINS,
  ];
}
