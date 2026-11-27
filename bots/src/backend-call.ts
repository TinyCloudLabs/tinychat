/**
 * The headers of a signed POST from this service to the backend. The backend refuses every POST without
 * `X-Requested-With: XMLHttpRequest` before any route runs (packages/server/src/csrf.ts), and these routes sit behind
 * that check; the signature in `authorization` is what proves the caller.
 */
export function backendCallHeaders(authorization: string): Record<string, string> {
  return { authorization, "content-type": "application/json", "x-requested-with": "XMLHttpRequest" };
}
