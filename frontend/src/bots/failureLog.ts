import { BotsError } from "./botsApi";
import { BOTS_STRINGS } from "./botsStrings";

const NAMES: ReadonlySet<string> = new Set([
  "Error", "TypeError", "RangeError", "SyntaxError", "AbortError", "TimeoutError", "BotsError", "BotsRouteMissing", "BotsNoReply",
]);
const HISTORY_CODES: ReadonlySet<string> = new Set([
  "history_session_missing", "history_session_expired", "history_signed_out", "history_approval_declined",
  "history_authority_missing", "history_disabled", "history_owner_changed",
]);
const CODES: ReadonlySet<string> = new Set([...Object.keys(BOTS_STRINGS.errors), ...HISTORY_CODES]);

const known = (set: ReadonlySet<string>, value: unknown): string => (typeof value === "string" && set.has(value) ? value : "unknown");

/**
 * What the console keeps of a failure: a name and a code from fixed lists (anything else reads "unknown") and a message
 * only when it is one of our own. No stack and no other text.
 */
export function loggedFailure(value: unknown): Record<string, unknown> {
  if (!(value instanceof Error)) return { type: typeof value };
  const code = (value as { code?: unknown }).code;
  const message = value instanceof BotsError ? `Bots request failed: ${known(CODES, value.code)}` : HISTORY_CODES.has(value.message) ? value.message : undefined;
  return { name: known(NAMES, value.name), code: code === undefined ? undefined : known(CODES, code), message };
}
