import type { ConnectorConnection } from "./types";

export const GRANOLA_SAVED_KEY_WARNING = "Granola didn’t accept the saved key. It’s invalid or expired, so reconnect with a new one.";
export const GRANOLA_PLAN_INACTIVE = "Your Granola plan isn’t active. Granola’s API needs a Business or Enterprise plan. Check your subscription in the Granola app, then try again.";

// connector_state has no provider-specific notice column. On an otherwise
// successful run last_sync_error can carry this fixed, non-error notice code.
export const GRANOLA_SUMMARIES_ONLY = "granola:transcripts-disabled";

export function granolaKeyExpired(connection: ConnectorConnection | null): boolean {
  return connection?.connectorId === "granola" && connection.status === "connected"
    && connection.lastSyncStatus === "error" && connection.lastSyncError === GRANOLA_SAVED_KEY_WARNING;
}

export function granolaSummariesOnly(connection: ConnectorConnection | null): boolean {
  return connection?.connectorId === "granola" && connection.status === "connected"
    && connection.lastSyncStatus === "ok" && connection.lastSyncError === GRANOLA_SUMMARIES_ONLY;
}
