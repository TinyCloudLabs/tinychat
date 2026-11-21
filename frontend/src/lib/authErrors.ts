import { appPlatform, type AppPlatform } from "./platform";

/** An Error whose message was written for the user and may be shown as is. */
export class UserFacingError extends Error {
  override readonly name = "UserFacingError";
}

export const WEBVIEW_UPDATE_MESSAGE =
  "TinyCloud One needs a newer Android System WebView to sign in. Update it in Google Play, then try again.";
export const BROWSER_UPDATE_MESSAGE =
  "Your browser is too old to sign in to TinyCloud One. Update it, then try again.";
export const SIGN_IN_FAILED_MESSAGE = "Couldn't sign in. Try again.";

export const WEBVIEW_UPDATE_LINK = {
  href: "https://play.google.com/store/apps/details?id=com.google.android.webview",
  label: "Update Android System WebView",
} as const;

/** The link a user needs to act on `message`, when there is one. */
export function errorLinkFor(message: string | null): { href: string; label: string } | null {
  return message === WEBVIEW_UPDATE_MESSAGE ? WEBVIEW_UPDATE_LINK : null;
}

function errorChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  for (let current = error; current !== undefined && current !== null && chain.length < 5;
    current = (current as { cause?: unknown }).cause) chain.push(current);
  return chain;
}

/** The server's definite refusals of an OpenKey signing request: asking again with the same request cannot succeed. */
export type OpenKeyRefusal = "APP_KEY_GRANT_REFUSED" | "KEY_DELETE_NOT_GRANTABLE" | "INVALID_SIWE_RECAP";
const REFUSALS: Record<OpenKeyRefusal, true> = { APP_KEY_GRANT_REFUSED: true, KEY_DELETE_NOT_GRANTABLE: true, INVALID_SIWE_RECAP: true };
const isRefusal = (value: unknown): value is OpenKeyRefusal => typeof value === "string" && Object.hasOwn(REFUSALS, value);

/**
 * How an OpenKey popup or sheet ended without success, for the screen that opened it. `code` is the SDK's own error
 * code (never its message), or null when the failure did not come from OpenKey.
 */
export type OpenKeyFailure =
  | { kind: "cancelled" }
  | { kind: "popup-blocked"; embeddedWebview: boolean }
  | { kind: "refused"; code: OpenKeyRefusal }
  | { kind: "session-ended" }
  | { kind: "failed"; code: string | null };

const SDK_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

/**
 * Reads an `OpenKeyError` (`{ code, message, reason? }`, not an Error) anywhere in the cause chain; a cancel anywhere
 * in it wins. SDK 0.12 reports a refusal as `{ code: "UNKNOWN", message: <refusal code> }`; 0.13 uses the refusal as
 * the code.
 */
export function openKeyFailureOf(error: unknown): OpenKeyFailure {
  const coded = errorChain(error).flatMap((link) => {
    if (typeof link !== "object" || link === null) return [];
    const { code, message, reason } = link as { code?: unknown; message?: unknown; reason?: unknown };
    return typeof code === "string" && SDK_CODE.test(code) ? [{ code, message, reason }] : [];
  });
  if (coded.some(({ code }) => code === "USER_CANCELLED")) return { kind: "cancelled" };
  const first = coded[0];
  if (!first) return { kind: "failed", code: null };
  const { code, message, reason } = first;
  if (code === "POPUP_BLOCKED") return { kind: "popup-blocked", embeddedWebview: reason === "embedded-webview" };
  if (code === "UNAUTHORIZED") return { kind: "session-ended" };
  if (isRefusal(code)) return { kind: "refused", code };
  if (code === "UNKNOWN" && isRefusal(message)) return { kind: "refused", code: message };
  return { kind: "failed", code };
}

/** OpenKey rejects a closed or cancelled request with `{ code: "USER_CANCELLED" }`, which is not an Error. */
export function isSignInCancelled(error: unknown): boolean {
  return openKeyFailureOf(error).kind === "cancelled";
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === "string" ? message : "";
}

const CRYPTO_UNSUPPORTED = /createPrivateKey|Ed25519|Unrecognized name|WebCrypto subtle/i;

/** A message that is safe to show for a failed sign-in or restore. Logging the raw error is the caller's job (describeAuthFailure). */
export function authErrorMessage(error: unknown, platform: AppPlatform = appPlatform()): string {
  if (error instanceof UserFacingError) return error.message;
  if (errorChain(error).some((link) => CRYPTO_UNSUPPORTED.test(messageOf(link)))) {
    return platform === "android" ? WEBVIEW_UPDATE_MESSAGE : BROWSER_UPDATE_MESSAGE;
  }
  return SIGN_IN_FAILED_MESSAGE;
}
