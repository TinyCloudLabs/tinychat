// Thin wrapper over `tcw.secrets` (`ISecretsService`). See docs/connectors-spec.md §7.
// Result plumbing only — never throws, never invents an error, never fallbacks silently.
// The SDK's put may 404 on the first call in a session created via manifest capabilities
// because the owned `secrets` space was never registered with the node. In that one case
// we call `tcw.ensureOwnedSpaceHosted?.("secrets")` (if the SDK exposes it) and retry
// ONCE. If the method doesn't exist we surface the original error — no silent fallback.

import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import type { ConnectorDescriptor } from "./types";

/** Same Result shape the SDK uses. Errors propagate untouched. */
export type SecretsResult<T, E> =
  | { ok: true; data: T }
  | { ok: false; error: E };

/** Shape of errors surfaced by `tcw.secrets` operations. The SDK does not
 *  expose a stable enum, so we forward whatever it hands us and let the UI
 *  render `message` (with `code` for logs). */
export type SecretsErr = { code?: string; message?: string };

/** Minimum surface we invoke on tcw. Kept structural so tests can supply a fake. */
type SecretsTcw = Pick<TinyCloudWeb, "secrets"> & {
  ensureOwnedSpaceHosted?: TinyCloudWeb["ensureOwnedSpaceHosted"];
};

/**
 * True if `err` looks like a "space/resource not found" from the node — the
 * signal we retry on for the first-put case.
 */
function isNotFoundShaped(err: unknown): boolean {
  if (err === null || typeof err !== "object") return false;
  const e = err as { code?: unknown; message?: unknown };
  if (typeof e.code === "string" && /NOT_FOUND/i.test(e.code)) return true;
  if (typeof e.message === "string" && /not found|404/i.test(e.message)) return true;
  return false;
}

export function isSecretsUnlocked(tcw: SecretsTcw): boolean {
  return tcw.secrets.isUnlocked;
}

/** Message we substitute for the cold-cache unlock failure. */
export const UNLOCK_NEEDS_SIGN_IN_MESSAGE =
  "Please sign out and sign back in to unlock secrets.";

/**
 * True if `err` is the vault's "no signer, no cached signature" failure.
 *
 * A boot-time session restore reconnects the TinyCloud session but NOT the
 * wallet, so the vault has no signer. That is fine while the master signature
 * is still cached in IndexedDB (the warm path — unlock succeeds silently), but
 * on a cold cache (new browser profile, cleared storage, other device) the
 * vault cannot derive the master key and returns VAULT_LOCKED. The only fix
 * available to the user is a fresh sign-in, which reconnects the signer.
 */
function isMissingUnlockSigner(err: unknown): boolean {
  if (err === null || typeof err !== "object") return false;
  const e = err as { code?: unknown; message?: unknown };
  return (
    e.code === "VAULT_LOCKED" &&
    typeof e.message === "string" &&
    /signer is required/i.test(e.message)
  );
}

// ── Unlock-event registry (I2) ───────────────────────────────────────
//
// `unlockSecrets` is the one choke point every production unlock site shares.
// Anything that wants to react to a user-initiated unlock subscribes HERE
// instead of to four call sites, and — deliberately — it subscribes without
// making `lib/` import from `chat/`: the registry is zero-dependency, lives
// beside its emit, and is a strict OUTPUT of a successful unlock (never an
// input to it, so nothing a subscriber does can cause the vault to open).

type SecretsUnlockedListener = () => void;
const secretsUnlockedListeners = new Set<SecretsUnlockedListener>();

/** Subscribe to successful user-initiated unlocks. Returns the unsubscribe. */
export function onSecretsUnlocked(cb: SecretsUnlockedListener): () => void {
  secretsUnlockedListeners.add(cb);
  return () => {
    secretsUnlockedListeners.delete(cb);
  };
}

/** Tests only. */
export function resetSecretsUnlockedListenersForTests(): void {
  secretsUnlockedListeners.clear();
}

/** Tests only: drive the notify loop directly, so its re-entrancy behaviour is
 *  testable — the production path always reaches it through an awaited unlock,
 *  which can never nest synchronously. */
export function notifySecretsUnlockedForTests(): void {
  notifySecretsUnlocked();
}

/** True while a notification pass is mid-loop. A nested notify during an
 *  in-flight one is suppressed entirely — defense in depth against a
 *  subscriber that itself triggers a successful unlock and self-feeds the
 *  loop. Our production subscriber re-arms a drain and never unlocks, so
 *  suppression loses nothing. */
let notifyingSecretsUnlocked = false;

/** Fire every listener in registration order. A throwing subscriber neither
 *  corrupts the caller's unlock result nor starves the next subscriber, and a
 *  re-entrant call is a no-op (see the flag above). */
function notifySecretsUnlocked(): void {
  if (notifyingSecretsUnlocked) return;
  notifyingSecretsUnlocked = true;
  try {
    for (const cb of [...secretsUnlockedListeners]) {
      try {
        cb();
      } catch {
        // Quiet by contract: the caller is awaiting an unlock, not a subscriber.
      }
    }
  } finally {
    notifyingSecretsUnlocked = false;
  }
}

export async function unlockSecrets<E>(
  tcw: SecretsTcw,
): Promise<SecretsResult<void, E>> {
  const result = (await tcw.secrets.unlock()) as SecretsResult<void, E>;
  // Rewrite only this one error's message into something the user can act on.
  // The code and the rest of the error are preserved for logs — no swallowing,
  // no retry, no fallback.
  if (!result.ok && isMissingUnlockSigner(result.error)) {
    return {
      ok: false,
      error: { ...result.error, message: UNLOCK_NEEDS_SIGN_IN_MESSAGE },
    };
  }
  // Notify on ok only — a failed unlock (including the rewritten one) did not
  // open the vault, so no re-arm may fire. Fire-and-forget: subscribers must
  // not delay the caller.
  if (result.ok) notifySecretsUnlocked();
  return result;
}

export async function saveConnectorKey<E>(
  tcw: SecretsTcw,
  descriptor: ConnectorDescriptor,
  key: string,
): Promise<SecretsResult<void, E>> {
  const first = (await tcw.secrets.put(descriptor.secretName, key, {
    scope: descriptor.secretScope,
  })) as SecretsResult<void, E>;
  if (first.ok) return first;
  if (!isNotFoundShaped(first.error)) return first;
  if (typeof tcw.ensureOwnedSpaceHosted !== "function") return first;
  await tcw.ensureOwnedSpaceHosted("secrets");
  return (await tcw.secrets.put(descriptor.secretName, key, {
    scope: descriptor.secretScope,
  })) as SecretsResult<void, E>;
}

export async function getConnectorKey<E>(
  tcw: SecretsTcw,
  descriptor: ConnectorDescriptor,
): Promise<SecretsResult<string, E>> {
  return (await tcw.secrets.get(descriptor.secretName, {
    scope: descriptor.secretScope,
  })) as SecretsResult<string, E>;
}

export async function deleteConnectorKey<E>(
  tcw: SecretsTcw,
  descriptor: ConnectorDescriptor,
): Promise<SecretsResult<void, E>> {
  return (await tcw.secrets.delete(descriptor.secretName, {
    scope: descriptor.secretScope,
  })) as SecretsResult<void, E>;
}
