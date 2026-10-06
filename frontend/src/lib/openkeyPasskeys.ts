/**
 * Whether OpenKey may offer passkeys in this shell.
 *
 * The Exo desktop app is an ad-hoc-signed Tauri/WKWebView build where WebAuthn
 * does not work, so it opens OpenKey with `passkeysSupported: false` and the
 * OpenKey modal offers only email and Google. Web and mobile keep passkeys.
 * Detection matches `frontend/src/lib/pwa.ts`.
 */
export function openkeyPasskeysSupported(): boolean {
  return !(typeof window !== "undefined" && "__TAURI_INTERNALS__" in window);
}
