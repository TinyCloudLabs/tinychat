import type { SessionStore } from "@tinyboilerplate/client";

export const CALENDAR_AUTOJOIN_PATH = "/api/connectors/google/autojoin";
export interface CalendarAutojoinOutcome {
  id: string; title?: string; start: number; reason: string; meetingId?: string;
}
export interface CalendarAutojoinStatus {
  state: "off" | "on" | "needs_reconnect" | "error";
  enabled: boolean;
  lastScanAt: number | null;
  errorCode: string | null;
  outcomes: CalendarAutojoinOutcome[];
}
export function createCalendarAutojoinClient(backendUrl: string, sessionStore: SessionStore) {
  async function request<T>(path: string, body?: unknown): Promise<T> {
    const token = sessionStore.getToken();
    if (!token || sessionStore.isExpired()) throw new Error("Sign in again to manage Calendar autojoin.");
    const response = await fetch(`${backendUrl}${CALENDAR_AUTOJOIN_PATH}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${token}`, "X-Requested-With": "XMLHttpRequest",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new Error(response.status === 404
      ? "Calendar autojoin is not configured on this backend."
      : "Calendar autojoin could not be updated. Try again.");
    return await response.json() as T;
  }
  return {
    status: () => request<CalendarAutojoinStatus>("/status"),
    disable: () => request<CalendarAutojoinStatus>("/disable", {}),
  };
}

export function calendarOutcomeLabel(reason: string): string {
  switch (reason) {
    case "missed": case "missed_window": case "expired": case "window_expired": return "The joining window passed before a bot could be sent.";
    case "cancelled": case "event_cancelled": return "The Calendar event was cancelled.";
    case "ineligible": case "event_ineligible": case "attendance_changed": return "The event no longer meets the attendance or meeting requirements for autojoin.";
    case "changed": case "event_changed": return "The event time or meeting link changed.";
    case "disabled": case "autojoin_disabled": return "Autojoin was turned off.";
    case "needs_reconnect": case "google_needs_reconnect": case "authorization_lost":
    case "calendar_access_denied": case "calendar_unauthorized": return "Reconnect Google to restore Calendar access.";
    case "calendar_rate_limited": return "Google temporarily limited Calendar access. TinyChat will retry.";
    case "scan_incomplete": return "The Calendar scan was incomplete. New joins are paused until a complete scan succeeds.";
    case "calendar_transport": case "calendar_invalid_response": case "calendar_unavailable":
    case "calendar_scan_failed": return "Calendar could not be checked. TinyChat will retry before sending a bot.";
    case "autojoin_retry": return "The notetaker is temporarily unavailable. TinyChat will retry while the meeting is eligible.";
    case "lookup_identity_mismatch": return "The recording could not be verified. No replacement bot was sent.";
    case "create_rejected": return "The notetaker service could not accept this meeting.";
    case "failed": case "create_failed": case "recording_failed": return "The notetaker could not complete this recording.";
    default: return "This occurrence could not be recorded automatically.";
  }
}
