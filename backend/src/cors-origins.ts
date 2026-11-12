/** The fixed origin Tauri assigns to Exo's bundled frontend on macOS. */
export const EXO_DESKTOP_ORIGIN = "tauri://localhost";

/** The fixed origin Tauri assigns to Exo's bundled frontend on Windows. */
export const EXO_DESKTOP_WINDOWS_ORIGIN = "http://tauri.localhost";

/** The fixed origin Capacitor assigns to Exo's bundled frontend on Android. */
export const EXO_ANDROID_ORIGIN = "https://localhost";

/** The fixed origin Capacitor assigns to Exo's bundled frontend on iOS. */
export const EXO_IOS_ORIGIN = "capacitor://localhost";

/** The TinyCloud Home site, the canonical web origin of the single TinyChat/Home web build. */
export const HOME_WEB_ORIGIN = "https://home.tinycloud.xyz";

/** The original TinyChat web origin. Visitors whose local work has not synced stay here. */
export const TINYCHAT_WEB_ORIGIN = "https://tinycloud.chat";

/** Env var listing the web origins the backend accepts, comma-separated. FRONTEND_URL is always added. */
export const FRONTEND_ORIGINS_ENV = "FRONTEND_ORIGINS";

/** The web origins accepted when FRONTEND_ORIGINS is unset: both production sites. */
export const DEFAULT_FRONTEND_ORIGINS: readonly string[] = [TINYCHAT_WEB_ORIGIN, HOME_WEB_ORIGIN];

/**
 * The web origins the backend accepts for CORS, the SIWE domain check and Google OAuth returns:
 * FRONTEND_URL's origin, plus FRONTEND_ORIGINS (comma-separated HTTP(S) origins; unset or blank means
 * DEFAULT_FRONTEND_ORIGINS). The explicit list keeps tinycloud.chat accepted when FRONTEND_URL moves
 * to home.tinycloud.xyz. Anything that is not an exact origin throws, so a bad value fails startup.
 */
export function frontendOriginsFromEnv(frontendUrl: string, env: NodeJS.ProcessEnv = process.env): string[] {
  let frontendOrigin: string;
  try {
    const url = new URL(frontendUrl.trim());
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error();
    frontendOrigin = url.origin;
  } catch {
    throw new Error("FRONTEND_URL must be an HTTP(S) URL");
  }
  const raw = env[FRONTEND_ORIGINS_ENV] ?? "";
  const listed = raw.trim()
    ? raw.split(",").map((entry) => {
      try {
        const url = new URL(entry.trim());
        if ((url.protocol !== "https:" && url.protocol !== "http:") || url.href !== url.origin + "/") throw new Error();
        return url.origin;
      } catch {
        throw new Error(`${FRONTEND_ORIGINS_ENV} must contain only comma-separated HTTP(S) origins`);
      }
    })
    : DEFAULT_FRONTEND_ORIGINS;
  return [...new Set([frontendOrigin, ...listed])];
}

/** TinyChat's Cloudflare Pages project, including branch and commit previews. */
export const TINYCHAT_PAGES_ORIGIN = /^https:\/\/[a-z0-9-]+\.tinychat-4jq\.pages\.dev$/;

/** Exact origins used by the documented local web development flow. */
export const LOCAL_WEB_ORIGINS = [
  "http://localhost:5186",
  "https://localhost:5186",
] as const;
const SESSION_KEY_URI = /^did:key:(z6Mk[1-9A-HJ-NP-Za-km-z]{44})#\1$/;

/** Match the signed SIWE domain and delegation target, not the browser Origin.
 * Both the web SDK and native OpenKey sign a per-session DID URI; older web
 * clients may sign the exact HTTPS hostname instead. */
export function isExpectedSiweOrigin(
  domain: string,
  uri: string,
  webDomains: readonly string[],
  nativeDomain: string,
): boolean {
  if (domain === nativeDomain) return SESSION_KEY_URI.test(uri);
  if (!webDomains.includes(domain) &&
    domain !== "localhost" &&
    domain !== "tauri.localhost" &&
    !TINYCHAT_PAGES_ORIGIN.test(`https://${domain}`)) return false;
  return uri === `https://${domain}` || SESSION_KEY_URI.test(uri);
}

/** Browser origins allowed to call the TinyChat backend. */
export function appCorsOrigins(frontendOrigins: readonly string[]): Array<string | RegExp> {
  return [
    ...frontendOrigins,
    EXO_DESKTOP_ORIGIN,
    EXO_DESKTOP_WINDOWS_ORIGIN,
    EXO_ANDROID_ORIGIN,
    EXO_IOS_ORIGIN,
    TINYCHAT_PAGES_ORIGIN,
    ...LOCAL_WEB_ORIGINS,
  ];
}

/** Shared CORS options for application requests, including readable draft-7 limiter headers. */
export function appCorsOptions(frontendOrigins: readonly string[]) {
  return {
    origin: appCorsOrigins(frontendOrigins),
    exposedHeaders: ["Retry-After", "RateLimit", "RateLimit-Policy", "X-Request-Id", "X-Correlation-Id"],
  };
}
