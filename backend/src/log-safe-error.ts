/**
 * What a route may log about a failure it answers with a generic 503: the error's class, and a code only when it is a
 * short identifier (a structured `code` such as AUTH_UNAUTHORIZED, an HTTP `status`, or a snake_case message such as
 * history_grant_rejected). Never a free-text message, a stack, a cause or anything from a request or a stored record.
 */
export function logSafeError(error: unknown): { error: string; code?: string; status?: number } {
  if (!(error instanceof Error)) return { error: typeof error };
  const structured = "code" in error && typeof error.code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code) ? error.code : undefined;
  const code = structured ?? (/^[a-z][a-z0-9_]{0,63}$/.test(error.message) ? error.message : undefined);
  const status = "status" in error && Number.isInteger(error.status) && Number(error.status) >= 100 && Number(error.status) <= 599
    ? Number(error.status) : undefined;
  return { error: error.name, ...(code === undefined ? {} : { code }), ...(status === undefined ? {} : { status }) };
}
