// Spike configuration. Reads from Expo public env vars (EXPO_PUBLIC_*), which
// are inlined at bundle time and safe to expose to the client.
//
// On-device auth is NOT in scope for this spike: the bearer token is a
// placeholder sourced from EXPO_PUBLIC_CHAT_TOKEN (or empty). A real client
// would mint/refresh this via the OpenKey/TinyCloud sign-in flow and store it
// in secure storage — see WHAT REMAINS in the spike report.

export const BACKEND_URL =
  process.env.EXPO_PUBLIC_BACKEND_URL ?? "https://api.tinycloud.chat";

// Default model mirrors the web app's DEFAULT_MODEL (phala/gpt-oss-120b).
export const CHAT_MODEL =
  process.env.EXPO_PUBLIC_MODEL ?? "phala/gpt-oss-120b";

/**
 * Placeholder auth-token accessor. Returns the env-provided token (for manual
 * device testing) or an empty string. Structurally where a real session store's
 * `getToken()` would plug in.
 */
export function getAuthToken(): string {
  return process.env.EXPO_PUBLIC_CHAT_TOKEN ?? "";
}
