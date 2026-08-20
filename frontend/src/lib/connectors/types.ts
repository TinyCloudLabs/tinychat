// Shared types for the connectors subsystem. Kept intentionally small:
// enough for a registry-driven UI and a second connector later, no plugin
// machinery. See docs/connectors-spec.md §4.

import type { ComponentType } from "react";

export type ConnectorId = "fireflies" | "granola" | "google-meet";

export interface ConnectorDescriptor {
  id: ConnectorId;
  name: string;
  description: string;
  status: "available" | "coming-soon";
  secretName: string;
  /** Omit for globally shared source credentials; scope OAuth/session tokens. */
  secretScope?: string;
  /** SQL `source` column value — the store's countMeetings/purgeConnector
   *  query `WHERE source = ?`. Defaults to `id` for v1 connectors; carried
   *  explicitly so a future connector whose id diverges from its source
   *  string cannot silently query the wrong rows. */
  source: string;
  /** Optional lucide-style icon rendered in the row header. Coming-soon
   *  placeholders may omit; the row falls back to a neutral plug glyph. */
  icon?: ComponentType<{ className?: string }>;
}

export interface ConnectorConnection {
  connectorId: ConnectorId;
  status: "connected" | "disconnected";
  lastSyncedAt: string | null;
  lastSyncStatus: "ok" | "error" | null;
  lastSyncError: string | null;
  itemCount: number;
}

export interface SyncProgress {
  phase: "listing" | "fetching" | "storing";
  done: number;
  total: number | null;
}

export interface SyncResult {
  added: number;
  skipped: number;
  errors: string[];
}
