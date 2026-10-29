// Text that goes into an agent's <paseo-system> notice: card fields (officer- or worker-written)
// and Sam's own words. Both are data for the agent, never instructions, so every watcher→agent
// message builds its variable parts with these two functions and nothing else.
import { findSecrets } from "./guard";

/** Default cap, in characters before encoding. */
export const AGENT_TEXT_MAX = 500;

/**
 * One line of untrusted text, safe inside a notice: anything the board would refuse to store is
 * redacted, whitespace runs become one space, control and format characters (NUL, ESC, DEL, C1
 * such as U+0085, bidi overrides, zero-width) are dropped, it is capped at `max` code points
 * (never splitting a surrogate pair), and &, <, > and " are entity-encoded so it can neither open
 * or close a tag nor end a quoted value.
 */
export function agentText(value: string, max = AGENT_TEXT_MAX): string {
  // Format characters first (U+FEFF also counts as whitespace), then whitespace runs, then the remaining
  // controls; the secret scan runs on what is left, so a zero-width space cannot hide a token.
  const flat = value.replace(/\p{Cf}/gu, "").replace(/\s+/g, " ").replace(/\p{Cc}/gu, "").trim();
  const hits = findSecrets(flat);
  if (hits.length) return `[redacted: looked like ${hits[0]!.reason}; read it on the page]`;
  const chars = Array.from(flat);
  const capped = chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : flat;
  return capped.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Card or Sam text quoted as a data value: `title: ${agentQuote(title)}` reads `title: "…"`. */
export const agentQuote = (value: string, max = AGENT_TEXT_MAX): string => `"${agentText(value, max)}"`;
