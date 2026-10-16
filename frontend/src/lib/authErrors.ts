import { appPlatform, type AppPlatform } from "./platform";

/** An Error whose message was written for the user and may be shown as is. */
export class UserFacingError extends Error {
  override readonly name = "UserFacingError";
}

export const WEBVIEW_UPDATE_MESSAGE =
  "Exo needs a newer Android System WebView to sign in. Update it in Google Play, then try again.";
export const BROWSER_UPDATE_MESSAGE =
  "Your browser is too old to sign in to Exo. Update it, then try again.";
export const SIGN_IN_FAILED_MESSAGE = "Couldn't sign in. Please try again.";

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

/** OpenKey rejects a closed or cancelled request with `{ code: "USER_CANCELLED" }`, which is not an Error. */
export function isSignInCancelled(error: unknown): boolean {
  return errorChain(error).some((link) => typeof link === "object" && (link as { code?: unknown }).code === "USER_CANCELLED");
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === "string" ? message : "";
}

const CRYPTO_UNSUPPORTED = /createPrivateKey|Ed25519|Unrecognized name|WebCrypto subtle/i;

/** A message that is safe to show for a failed sign-in or restore. Logging the raw error is the caller's job (describeAuthFailure). */
export function authErrorMessage(error: unknown, platform: AppPlatform = appPlatform()): string {
  const chain = errorChain(error);
  const userFacing = chain.find((link) => link instanceof UserFacingError);
  if (userFacing) return userFacing.message;
  if (chain.some((link) => CRYPTO_UNSUPPORTED.test(messageOf(link)))) {
    return platform === "android" ? WEBVIEW_UPDATE_MESSAGE : BROWSER_UPDATE_MESSAGE;
  }
  return SIGN_IN_FAILED_MESSAGE;
}
