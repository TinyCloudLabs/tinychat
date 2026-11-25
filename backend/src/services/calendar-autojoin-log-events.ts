import { emitToStdout, requestLogAccountHash } from "../request-context.js";
import type { CalendarConnection, CalendarOccurrence } from "./calendar-autojoin-store.js";

const DECISIONS = [
  "sent", "completed", "failed", "cancelled", "missed", "missed_window", "not_accepted",
  "event_ineligible", "event_changed", "already_recorded", "unverified_capture", "capacity_exhausted",
  "shared", "recording_deleted", "autojoin_disabled", "create_rejected", "google_needs_reconnect",
  "lookup_identity_mismatch", "unknown",
] as const;
export type CalendarDecisionReason = (typeof DECISIONS)[number];

const CONNECTION_CODES = [
  "needs_reconnect", "calendar_scan_failed", "scan_incomplete", "calendar_transport", "calendar_rate_limited",
  "calendar_unauthorized", "calendar_access_denied", "calendar_unavailable", "calendar_invalid_response", "unknown",
] as const;
export type CalendarConnectionCode = (typeof CONNECTION_CODES)[number];

export interface CalendarTickCounts {
  tenants: number;
  rows: number;
  scans: number;
  timers_due: number;
  scan_complete: boolean;
  duration_ms: number;
}

export type CalendarAutojoinLogEvent =
  | ({ event: "calendar_autojoin_tick" } & CalendarTickCounts)
  | { event: "calendar_autojoin_decision"; reason: CalendarDecisionReason; start: string; tenant_hash?: string }
  | { event: "calendar_autojoin_connection"; state: CalendarConnection["state"]; code?: CalendarConnectionCode; tenant_hash?: string };

function tenantHash(tenant: string): { tenant_hash: string } | object {
  const hash = requestLogAccountHash(tenant);
  return hash ? { tenant_hash: hash.slice(0, 12) } : {};
}

/** Projection accepts only known decisions. Runtime data from rows is checked as well. */
export function calendarDecisionEvent(row: Pick<CalendarOccurrence, "tenant" | "start">, reason: CalendarDecisionReason): CalendarAutojoinLogEvent & { event: "calendar_autojoin_decision" } {
  return { event: "calendar_autojoin_decision", reason: DECISIONS.includes(reason) ? reason : "unknown",
    start: new Date(row.start).toISOString(), ...tenantHash(row.tenant) };
}

export function calendarConnectionEvent(row: Pick<CalendarConnection, "tenant" | "state" | "errorCode">): CalendarAutojoinLogEvent & { event: "calendar_autojoin_connection" } {
  const code = row.errorCode ? CONNECTION_CODES.find(value => value === row.errorCode) ?? "unknown" : undefined;
  return { event: "calendar_autojoin_connection", state: row.state, ...(code ? { code } : {}), ...tenantHash(row.tenant) };
}

export function calendarTickEvent(counts: CalendarTickCounts): CalendarAutojoinLogEvent & { event: "calendar_autojoin_tick" } {
  return { event: "calendar_autojoin_tick", ...counts };
}

export function emitCalendarAutojoinEvent(event: CalendarAutojoinLogEvent): void {
  emitToStdout(event);
}
