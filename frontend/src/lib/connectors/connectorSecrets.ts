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
