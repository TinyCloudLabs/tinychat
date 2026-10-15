const AUTOMATIC_RETRY_CODES: ReadonlySet<string> = new Set([
  "service_paused",
  "service_unavailable",
  "connection_lost",
  "offline",
  "request_timeout",
  "upstream_bad_response",
  "http_5xx",
  "service_busy",
  "transcript_save_failed",
  "held_result_persistence_failed",
  "STORAGE_QUOTA_EXCEEDED",
  "upload_capability_limit",
]);

export function isAutomaticRetryableCode(code: string | null): boolean {
  return code !== null && AUTOMATIC_RETRY_CODES.has(code);
}
