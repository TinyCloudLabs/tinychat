import { REDACTED, redactSecrets } from "@tinyboilerplate/core/feed/sitrep";

export const TITLE_LINK = "[link]";
export const TITLE_HIDDEN = "[hidden]";
/** A Courier card's title when nothing of its first line is left once links and tokens are taken out. */
export const COURIER_EMPTY_TITLE = "New message";
const COURIER_TITLE_MAX = 120;

/** Punctuation after a link ends the sentence, not the link. */
const keepTrailing = (marker: string) => (match: string) => marker + (/[.,;:!?)\]}]+$/.exec(match)?.[0] ?? "");

// Applied in order: a bearer token before the URL it may sit in, links before the tokens inside them.
const TITLE_RULES: ReadonlyArray<[pattern: RegExp, replace: (match: string) => string]> = [
  // Any word after "Bearer" goes, including one the guard already turned into "[link]".
  [/\bBearer\s+\S+/gi, () => TITLE_HIDDEN],
  [/\b(?:[a-z][a-z0-9+.-]*:\/\/|www\.)[^\s<>"'`]+/gi, keepTrailing(TITLE_LINK)],
  // A link written without its scheme: host.tld/path.
  [/\b(?:[a-z0-9-]+\.)+[a-z]{2,}\/[^\s<>"'`]*/gi, keepTrailing(TITLE_LINK)],
  // An address carrying a token: a +tag, or a long run in its local part (reply+abc@…, x7Kq…@…).
  [/[^\s@<>"'`()]+@(?:[a-z0-9-]+\.)+[a-z]{2,}\b/gi, (email) => {
    const local = email.slice(0, email.indexOf("@"));
    return local.includes("+") || /[A-Za-z0-9_-]{16,}/.test(local) ? TITLE_LINK : email;
  }],
  [/\beyJ[\w-]*\.[\w-]+(?:\.[\w-]*)?/g, () => TITLE_HIDDEN],
  [/\b(?:0x)?[0-9a-f]{32,}\b/gi, () => TITLE_HIDDEN],
  // Long base64 or base64url: letters and digits together, 32 characters or more. No word in a sentence is that long.
  [/[A-Za-z0-9+/_-]{32,}={0,2}/g, (run) => (/\d/.test(run) && /[A-Za-z]/.test(run) ? TITLE_HIDDEN : run)],
];

/**
 * A card's title as Home shows it. Whatever the secret guard refuses goes first (redactSecrets), and its mark becomes
 * "[link]" so a title shows one link mark. Then any link is replaced with "[link]", and a bearer token, a JWT, a long
 * hex or base64 string with "[hidden]", even where the guard would let them through: a title is read at a glance, in a
 * list, and never needs to show either.
 *
 * A message relayed over Courier (`courier`) is titled by its first line, which its sender wrote. Its row already
 * starts with the Courier mark and the sender, so its title is a short summary: that line, shortened, or
 * "New message" when nothing but links and tokens was in it.
 */
export function shownTitle(title: string, courier = false): string {
  const guarded = redactSecrets(title).replaceAll(REDACTED, TITLE_LINK);
  const redacted = TITLE_RULES.reduce((text, [pattern, replace]) => text.replace(pattern, replace), guarded);
  if (!courier) return redacted;
  const line = redacted.split(/\r?\n/).map((part) => part.replace(/\s+/g, " ").trim()).find(Boolean) ?? "";
  const words = line.replaceAll(TITLE_LINK, "").replaceAll(TITLE_HIDDEN, "");
  if (!/[\p{L}\p{N}]/u.test(words)) return COURIER_EMPTY_TITLE;
  const chars = [...line];
  return chars.length > COURIER_TITLE_MAX ? `${chars.slice(0, COURIER_TITLE_MAX - 1).join("").trimEnd()}…` : line;
}
