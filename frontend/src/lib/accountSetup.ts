// An owner with no TinyCloud account record who signs in on the phone. The phone's WebView origin is not on the web
// SDK's first-party list, so the SDK refuses the owner's first request to the node with AccountSetupRequiredError.
// It does not throw it at sign-in: the phone's session is restored, not signed in, by the SDK, so the refusal comes
// back from the first call as a Result error (`code: "NETWORK_ERROR"`, `cause.code: "ACCOUNT_SETUP_REQUIRED"`).
// `checkAccountSetup` makes that first call at sign-in so the owner reads this screen's copy instead of a generic failure.
import { APP_ID } from "@tinyboilerplate/core";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { withAbortTimeout } from "./abortTimeout";

/** Where an owner creates the account. One constant for the link and for anything that routes there. */
export const ACCOUNT_SETUP_URL = "https://tinycloud.one/";
/** The sign-in screen's line for an owner who has no TinyCloud account yet. */
export const ACCOUNT_SETUP_MESSAGE =
  "There's no TinyCloud account for this sign-in. Create one at tinycloud.one, then come back here and sign in.";
/** The button that opens ACCOUNT_SETUP_URL. */
export const ACCOUNT_SETUP_BUTTON_LABEL = "Open tinycloud.one";

const SDK_CODE = "ACCOUNT_SETUP_REQUIRED";
const SDK_NAME = "AccountSetupRequiredError";

/** The sign-in's own error for a refused owner; `code` is the SDK's, so `isAccountSetupRequired` reads it the same way. */
export class AccountSetupRequiredError extends Error {
  readonly code = SDK_CODE;
  constructor() {
    super("No TinyCloud account for this owner");
    this.name = SDK_NAME;
  }
}

/**
 * Whether `error` is the SDK's account-setup refusal: thrown, wrapped as a `cause`, or carried by a Result error
 * (`{ code: "NETWORK_ERROR", cause: { code: "ACCOUNT_SETUP_REQUIRED" } }`). Looks at codes and names only, never messages.
 */
export function isAccountSetupRequired(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 6 && typeof current === "object" && current !== null; depth += 1) {
    const { code, name, cause, error: inner } = current as { code?: unknown; name?: unknown; cause?: unknown; error?: unknown };
    if (code === SDK_CODE || name === SDK_NAME) return true;
    current = cause ?? inner;
  }
  return false;
}

/** A path inside the sign-in's `threads/` grant. The key is read and never written; the read only asks the node and the key need not exist. */
const ACCOUNT_CHECK_KEY = `${APP_ID}/threads/.account-check`;
const ACCOUNT_CHECK_TIMEOUT_MS = 10_000;

/**
 * Makes the first request to the node for a freshly installed session and throws AccountSetupRequiredError if the SDK
 * refuses the owner. Any other outcome (found, not found, offline, timed out) returns: the sign-in goes on and each
 * later request reports its own failure.
 */
export async function checkAccountSetup(tcw: Pick<TinyCloudWeb, "kv">): Promise<void> {
  try {
    const result = await withAbortTimeout(ACCOUNT_CHECK_TIMEOUT_MS, (signal) => tcw.kv.get(ACCOUNT_CHECK_KEY, { signal }));
    if (!result.ok && isAccountSetupRequired(result.error)) throw new AccountSetupRequiredError();
  } catch (error) {
    if (isAccountSetupRequired(error)) throw new AccountSetupRequiredError();
  }
}
