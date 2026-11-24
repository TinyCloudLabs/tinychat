// A connector secret saved before each had its own encryption key (v1) is sealed to the owner's whole encryption
// network, which a sign-in no longer opens. Reading one fails with one of the codes below, and connecting again cannot
// fix that: the new key is saved but the older records stay unreadable. The fix is the older-keys approval
// (legacyKeyReseal.ts), which moves them onto their own keys.
//
// Only a read the user started may ask for that approval (Sync now): one prompt per press, then one retry of the read.
// Background reads never prompt; they use needsOlderKeysApproval to report "needs the older-keys approval" instead.
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import type { SecretsResult } from "./connectorSecrets";
import { resolveLegacyConnectorKeys, type LegacyKeysOutcome } from "./legacyKeyReseal";
import { GRANOLA_MISSING_KEY_CODE, GRANOLA_RECONNECT_REQUIRED } from "./granolaStatus";
import { connectorNamedKeyWritesEnabled } from "./namedKeyWrites";
import { OLDER_KEYS_SYNC_DECLINED } from "../homeStrings";

/** The SDK's codes for a record sealed to the whole network that this session cannot open (see sdk-services `VaultError`). */
const OLDER_KEY_CODES: Record<string, true> = { DECRYPTION_FAILED: true, DECRYPT_DENIED: true, LEGACY_ENVELOPE: true };

/** True when a failed secret read is an older key that needs the older-keys approval. */
export function isOlderKeyError(error: unknown): boolean {
  if (error === null || typeof error !== "object" || !("code" in error)) return false;
  return typeof error.code === "string" && OLDER_KEY_CODES[error.code] === true;
}

/** An older-key failure that the older-keys approval can fix: only while connectors save their secrets under their own keys. */
export function needsOlderKeysApproval(error: unknown): boolean {
  return isOlderKeyError(error) && connectorNamedKeyWritesEnabled();
}

type ApprovalTcw = Parameters<typeof resolveLegacyConnectorKeys>[0] & Pick<TinyCloudWeb, "session">;

/** A failed read that the older-keys approval was asked about: `olderKeys` says why it still failed. */
export type OlderKeyRead<E> = SecretsResult<string, E> | { ok: false; error: E; olderKeys: "declined" | "failed" };

/**
 * Runs `read`. When it fails with an older-key code (and connectors save their secrets under their own keys), asks the
 * older-keys approval once. "moved" reads again once and returns that result as it is; "declined" and "failed" return the
 * first failure marked with `olderKeys`; "nothing" (no older key found) returns the first failure unchanged.
 */
export async function readWithOlderKeysApproval<E>(
  tcw: ApprovalTcw,
  read: () => Promise<SecretsResult<string, E>>,
  resolve: (tcw: ApprovalTcw, address: string) => Promise<LegacyKeysOutcome> = resolveLegacyConnectorKeys,
): Promise<OlderKeyRead<E>> {
  const first = await read();
  if (first.ok || !needsOlderKeysApproval(first.error)) return first;
  const address = tcw.session()?.address;
  if (!address) return first;
  let outcome: LegacyKeysOutcome;
  try {
    outcome = await resolve(tcw, address);
  } catch {
    outcome = "failed";
  }
  if (outcome === "moved") return read();
  if (outcome === "declined" || outcome === "failed") return { ok: false, error: first.error, olderKeys: outcome };
  return first;
}

/**
 * The line the Connectors card shows when a Sync now press could not read its saved key. A declined approval names the
 * approval; a failed one shows the plain read failure; every other failure keeps its own message.
 */
export function syncKeyReadMessage(
  failed: Extract<OlderKeyRead<{ code?: string; message?: string }>, { ok: false }>,
  engine: "gmeet" | "granola" | "fireflies",
): string {
  const readFailed = engine === "gmeet" ? "Could not read the saved Google connection" : "Could not read API key";
  if ("olderKeys" in failed) return failed.olderKeys === "declined" ? OLDER_KEYS_SYNC_DECLINED : readFailed;
  if (engine === "granola" && failed.error?.code === GRANOLA_MISSING_KEY_CODE) return GRANOLA_RECONNECT_REQUIRED;
  return failed.error?.message ?? readFailed;
}
