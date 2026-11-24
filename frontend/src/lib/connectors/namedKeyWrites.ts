// Switch for saving a connector key under its own encryption key (a "v2" secret; TC-3284).
// OFF by default: a v2 secret is refused by readers that cannot open it yet (older CLI profiles, the roci board, OpenKey
// and the bots), so it is turned on only when every reader is ready. The read grants for these keys are not behind this
// switch. A production build turns it on only when the build sets `VITE_CONNECTOR_NAMED_KEY_WRITES` to exactly "true".
// The per-browser runtime flag below is read only in a development build (`import.meta.env.DEV`): in production it is
// ignored, so nothing on the page can turn v2 writes on.

export const NAMED_KEY_WRITES_RUNTIME_FLAG_KEY = "tinychat:connectors:named-key-writes";

export function connectorNamedKeyWritesEnabled(
  env: Record<string, unknown> = readViteEnv(),
  storage: Pick<Storage, "getItem"> | null = readStorage(),
): boolean {
  if (env.VITE_CONNECTOR_NAMED_KEY_WRITES === "true") return true;
  if (env.DEV !== true) return false;
  try {
    return storage?.getItem(NAMED_KEY_WRITES_RUNTIME_FLAG_KEY) === "true";
  } catch {
    // Storage blocked: the switch stays off.
    return false;
  }
}

/**
 * The one decision for how Connectors opens its secrets: with their own keys (the sign-in grant names the exact keys and
 * can renew, older keys are moved in a separate short approval) or the way it always has (the sign-in grant covers the
 * whole network, nothing is moved). The grant a sign-in asks for and the older-keys step both read it here, so they
 * cannot disagree.
 */
export function connectorOwnKeyGrants(
  env?: Record<string, unknown>,
  storage?: Pick<Storage, "getItem"> | null,
): boolean {
  return connectorNamedKeyWritesEnabled(env, storage);
}

function readViteEnv(): Record<string, unknown> {
  try {
    return (import.meta.env ?? {}) as Record<string, unknown>;
  } catch {
    // No Vite env injection in this runtime (bun unit tests): the build flag is off.
    return {};
  }
}

function readStorage(): Pick<Storage, "getItem"> | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}
