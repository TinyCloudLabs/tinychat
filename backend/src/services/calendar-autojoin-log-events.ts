import { emitToStdout, requestLogAccountHash, requestLogInviteHash } from "../request-context.js";
import type { CalendarConnection, CalendarOccurrence } from "./calendar-autojoin-store.js";
import type { MeetingFailureCode } from "./transcription-api.js";

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
const CONNECTION_STATES = ["disabled", "enabling", "enabled", "needs_reconnect", "unknown"] as const;

export interface CalendarTickCounts {
  tenants: number;
  rows: number;
  scans: number;
  timers_due: number;
  scan_complete: boolean;
  duration_ms: number;
}
export interface CalendarScanCounts {
  listed: number;
  eligible: number;
  skipped_not_confirmed: number;
  skipped_not_timed: number;
  skipped_no_meet_link: number;
  skipped_not_accepted: number;
  skipped_other: number;
  scan_complete: boolean;
}

export type CalendarAutojoinLogEvent =
  | ({ event: "calendar_autojoin_tick" } & CalendarTickCounts)
  | ({ event: "calendar_autojoin_scan" } & CalendarScanCounts)
  | { event: "calendar_autojoin_decision"; reason: CalendarDecisionReason; start?: string; tenant_hash?: string; invite_hash?: string; code?: MeetingFailureCode }
  | { event: "calendar_autojoin_connection"; state: CalendarConnection["state"] | "unknown"; code?: CalendarConnectionCode; tenant_hash?: string };

function tenantHash(tenant: string): { tenant_hash: string } | object {
  const hash = requestLogAccountHash(tenant);
  return hash ? { tenant_hash: hash.slice(0, 12) } : {};
}

/**
 * Invitation decisions (not_accepted, event_ineligible) carry no start time and no account pseudonym: an outsider
 * picks an invitation's start, and the account pseudonym would link it to the tenant's other lines. They carry an
 * invite-only pseudonym instead, which links only to other invitation decisions. Every other decision carries the
 * occurrence start and, when the key is configured, the account pseudonym.
 * A `failed` decision also carries the transcription service's closed failure code.
 */
export function calendarDecisionEvent(row: Pick<CalendarOccurrence, "tenant" | "start"> & Partial<Pick<CalendarOccurrence, "failureCode">>, reason: CalendarDecisionReason): CalendarAutojoinLogEvent & { event: "calendar_autojoin_decision" } {
  const closed = DECISIONS.includes(reason) ? reason : "unknown";
  if (closed === "not_accepted" || closed === "event_ineligible") {
    const invite = requestLogInviteHash(row.tenant);
    return { event: "calendar_autojoin_decision", reason: closed, ...(invite ? { invite_hash: invite.slice(0, 12) } : {}) };
  }
  return { event: "calendar_autojoin_decision", reason: closed, start: new Date(row.start).toISOString(), ...tenantHash(row.tenant),
    ...(closed === "failed" && row.failureCode ? { code: row.failureCode } : {}) };
}

export function calendarConnectionEvent(row: Pick<CalendarConnection, "tenant" | "state" | "errorCode">): CalendarAutojoinLogEvent & { event: "calendar_autojoin_connection" } {
  const code = row.errorCode ? CONNECTION_CODES.find(value => value === row.errorCode) ?? "unknown" : undefined;
  return { event: "calendar_autojoin_connection", state: CONNECTION_STATES.find(value => value === row.state) ?? "unknown",
    ...(code ? { code } : {}), ...tenantHash(row.tenant) };
}

export function calendarTickEvent(counts: CalendarTickCounts): CalendarAutojoinLogEvent & { event: "calendar_autojoin_tick" } {
  return { event: "calendar_autojoin_tick", ...counts };
}

export function calendarScanEvent(counts: CalendarScanCounts): CalendarAutojoinLogEvent & { event: "calendar_autojoin_scan" } {
  return { event: "calendar_autojoin_scan", ...counts };
}

export function emitCalendarAutojoinEvent(event: CalendarAutojoinLogEvent): void {
  emitToStdout(event);
}
