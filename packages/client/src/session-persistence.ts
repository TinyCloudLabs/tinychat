// ── Session Persistence ──────────────────────────────────────────────
//
// Reads/clears TinyCloud sessions from BrowserSessionStorage's localStorage.
// Kept in a separate file to avoid importing @tinycloud/web-sdk (browser-only).

/** Session data read from BrowserSessionStorage for restoring without SIWE. */
export interface PersistedTinyCloudSession {
  address: string;
  chainId: number;
  did: string;
  expiresAt: string;
}

/** localStorage keys used by BrowserSessionStorage. */
const TC_SESSION_KEY_PREFIX = "tinycloud:session:";
const TC_ACTIVE_ADDRESS_KEY = "tinycloud:session:active-address";
const TC_RUNTIME_GRANTS_KEY_PREFIX = "tinycloud:session:runtime-grants:";
/**
 * Check if a TinyCloud session is persisted in BrowserSessionStorage.
 *
 * Browser sign-in may restore from BrowserSessionStorage, so callers that
 * need a fresh SIWE nonce must clear the persisted session before signing.
 * This helper reads localStorage directly and returns the session metadata
 * needed for a headless restore.
 */
export function loadPersistedSession(address: string): PersistedTinyCloudSession | null {
  try {
    const raw = localStorage.getItem(TC_SESSION_KEY_PREFIX + address.toLowerCase());
    if (!raw) return null;

    const data = JSON.parse(raw);

    // Check expiry
    if (data.expiresAt && new Date(data.expiresAt) < new Date()) {
      localStorage.removeItem(TC_SESSION_KEY_PREFIX + address.toLowerCase());
      return null;
    }

    // Build primary DID from address + chainId
    const chainId = data.chainId ?? 1;
    const did = `did:pkh:eip155:${chainId}:${data.address}`;

    return {
      address: data.address,
      chainId,
      did,
      expiresAt: data.expiresAt,
    };
  } catch {
    return null;
  }
}

/**
 * Synchronously clear the per-address SDK session before any remote sign-out.
 */
export function clearPersistedSession(address: string): void {
  const normalizedAddress = address.toLowerCase();
  try {
    localStorage.removeItem(TC_SESSION_KEY_PREFIX + normalizedAddress);
    localStorage.removeItem(TC_RUNTIME_GRANTS_KEY_PREFIX + normalizedAddress);
    if (localStorage.getItem(TC_ACTIVE_ADDRESS_KEY)?.toLowerCase() === normalizedAddress) {
      localStorage.removeItem(TC_ACTIVE_ADDRESS_KEY);
    }
  } catch {
    // localStorage unavailable
  }
}
