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
  /** Persisted transport hosts take precedence over a changed application default. */
  tinycloudHosts?: string[];
}

/** localStorage key prefix used by BrowserSessionStorage. */
const TC_SESSION_KEY_PREFIX = "tinycloud:session:";

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
      tinycloudHosts: Array.isArray(data.tinycloudHosts)
        && data.tinycloudHosts.length > 0
        && data.tinycloudHosts.every((host: unknown) => typeof host === "string" && host.length > 0)
        ? data.tinycloudHosts : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Clear the persisted TinyCloud session from BrowserSessionStorage.
 * Used during sign-out when TinyCloudWeb instance isn't available (restored sessions).
 */
export function clearPersistedSession(address: string): void {
  try {
    localStorage.removeItem(TC_SESSION_KEY_PREFIX + address.toLowerCase());
  } catch {
    // localStorage unavailable
  }
}
