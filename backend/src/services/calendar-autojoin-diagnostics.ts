import { KvResultError } from "@tinyboilerplate/server";
import { BackendStorageLaneTimeout } from "./backend-storage-lane.js";
import { CalendarAutojoinError } from "./calendar-autojoin-connection.js";
import { GoogleCalendarError } from "./google-calendar.js";
import { GoogleOAuthError } from "./google-oauth.js";
import { TranscriptionApiError } from "./transcription-api.js";

type CalendarAutojoinFailurePhase = "tick" | "tenant_reconcile" | "due_timer" | "dispatch_lag_status";

const KV_CODES = [
  "unavailable_retryable", "outcome_unknown", "request_timeout", "auth_unauthorized",
  "auth_forbidden", "storage_quota_exceeded",
] as const;
const CALENDAR_CODES = [
  "scan_incomplete", "calendar_transport", "calendar_rate_limited", "calendar_unauthorized",
  "calendar_access_denied", "calendar_unavailable", "calendar_invalid_response",
] as const;
const OAUTH_CODES = ["network_error", "invalid_response", "invalid_grant", "invalid_client", "access_denied"] as const;
const TRANSCRIPTION_CODES = ["capacity_exhausted", "meeting_not_found"] as const;
const AUTOJOIN_CODES = ["needs_reconnect", "autojoin_disabled", "connection_changed", "insufficient_scope"] as const;
const STATE_CODES = ["calendar_state_invalid", "calendar_listing_invalid"] as const;

function closedCode(value: unknown, allowed: readonly string[], fallback: string): string {
  return allowed.find(code => code === value) ?? fallback;
}

/** Only fixed classifications leave the worker; error payloads and provider text stay local. */
export function logCalendarAutojoinFailure(phase: CalendarAutojoinFailurePhase, error: unknown): void {
  let errorName = "UnknownError";
  let code = "unexpected_error";
  let status: number | undefined;
  if (error instanceof BackendStorageLaneTimeout) {
    errorName = "BackendStorageLaneTimeout";
    code = "storage_lane_timeout";
  } else if (error instanceof KvResultError) {
    errorName = "KvResultError";
    code = closedCode(error.code?.toLowerCase(), KV_CODES, "kv_failure");
    status = error.status;
  } else if (error instanceof GoogleCalendarError) {
    errorName = "GoogleCalendarError";
    code = closedCode(error.code, CALENDAR_CODES, "google_calendar_failure");
    status = error.status;
  } else if (error instanceof GoogleOAuthError) {
    errorName = "GoogleOAuthError";
    code = closedCode(error.error, OAUTH_CODES, "google_oauth_failure");
    status = error.status;
  } else if (error instanceof TranscriptionApiError) {
    errorName = "TranscriptionApiError";
    code = closedCode(error.code, TRANSCRIPTION_CODES, "transcription_failure");
    status = error.status;
  } else if (error instanceof CalendarAutojoinError) {
    errorName = "CalendarAutojoinError";
    code = closedCode(error.code, AUTOJOIN_CODES, "autojoin_failure");
    status = error.status;
  } else if (error instanceof SyntaxError) {
    errorName = "SyntaxError";
    code = "invalid_json";
  } else if (error instanceof Error) {
    errorName = "Error";
    code = closedCode(error.message, STATE_CODES, "unexpected_error");
  }
  console.warn(JSON.stringify({
    event: "backend_log_error", component: "calendar-autojoin", phase, error_name: errorName, code,
    ...(status !== undefined && Number.isInteger(status) && status >= 100 && status <= 599 ? { status } : {}),
  }));
}
