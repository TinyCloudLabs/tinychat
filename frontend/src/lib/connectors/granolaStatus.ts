import type { ConnectorConnection } from "./types";

export const GRANOLA_SAVED_KEY_WARNING = "Granola didn’t accept the saved key. It’s invalid or expired, so reconnect with a new one.";
export const GRANOLA_PLAN_INACTIVE = "Your Granola plan isn’t active. Granola’s API needs a Business or Enterprise plan. Check your subscription in the Granola app, then try again.";
export const GRANOLA_SYNC_FAILED = "Granola sync didn't finish. Try again.";
export const GRANOLA_LAST_SYNC_FAILED = "Last sync didn't finish. Sync again.";

export const GRANOLA_RECONNECT_REQUIRED = "Reconnect Granola to sync again.";

/** The vault's missing-entry code after Reconnect removes a saved key. */
export const GRANOLA_MISSING_KEY_CODE = "KEY_NOT_FOUND";
export const GRANOLA_KEY_EXPIRED = "granola:key-expired";
// connector_state has no provider-specific notice column. On an otherwise
// successful run last_sync_error can carry this fixed, non-error notice code.
export const GRANOLA_SUMMARIES_ONLY = "granola:transcripts-disabled";
export const GRANOLA_SYNC_ERROR = "granola:sync-failed";
export const GRANOLA_SYNC_PARTIAL = "granola:sync-partial";

export function granolaSyncErrorMessage(code: string | null): string | null {
  if (code === GRANOLA_KEY_EXPIRED) return GRANOLA_SAVED_KEY_WARNING;
  if (code === GRANOLA_SYNC_ERROR || code === GRANOLA_SYNC_PARTIAL) return GRANOLA_SYNC_FAILED;
  return null;
}

export function granolaKeyExpired(connection: ConnectorConnection | null): boolean {
  return connection?.connectorId === "granola" && connection.status === "connected"
    && connection.lastSyncStatus === "error" && connection.lastSyncError === GRANOLA_KEY_EXPIRED;
}

export function granolaSummariesOnly(connection: ConnectorConnection | null): boolean {
  return connection?.connectorId === "granola" && connection.status === "connected"
    && connection.lastSyncStatus === "ok" && connection.lastSyncError === GRANOLA_SUMMARIES_ONLY;
}
