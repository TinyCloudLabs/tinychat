import { REDACTED, redactSecrets } from "@tinyboilerplate/core/feed/sitrep";

export const TITLE_LINK = "[link]";
export const TITLE_HIDDEN = "[hidden]";
/** A Courier card's title when nothing of its first line is left once links and tokens are taken out. */
export const COURIER_EMPTY_TITLE = "New message";
const COURIER_TITLE_MAX = 120;

/** Punctuation after a link ends the sentence, not the link. */
const keepTrailing = (marker: string) => (match: string) => marker + (/[.,;:!?)\]}]+$/.exec(match)?.[0] ?? "");

// Characters that show as nothing (format characters, the no-break and Hangul fillers, the blank Braille cell): taken out
// before NFKC, so none can split a link or a token past the rules, and fullwidth or styled letters read as plain ones.
const INVISIBLE = /[\p{Cf}\u00A0\uFEFF\u3164\u115F\u1160\u2800\uFFA0]/gu;
// Every line break reads as "\n" before the rules run: NEL (U+0085) is not whitespace to a regex, so a link would run on through it.
const LINE_BREAK = /\r\n|[\r\n\u0085\u2028\u2029]/g;

// Applied in order: a bearer token before the URL it may sit in, links before the tokens inside them.
const TITLE_RULES: ReadonlyArray<[pattern: RegExp, replace: (match: string) => string]> = [
  // The word after "Bearer" (or "Bearer:", "Bearer="), on the same line, including one the guard already turned into
  // "[link]". Case-sensitive, so a "ring bearer" keeps its word.
  [/\bBearer(?:[:=][^\S\n]*|[^\S\n]+)\S+/g, () => TITLE_HIDDEN],
  [/\b(?:[a-z][a-z0-9+.-]*:\/\/|https?:|www\.)[^\s<>"'`]+/gi, keepTrailing(TITLE_LINK)],
  // A link written without its scheme: host.tld/path, the host in any script.
  [/(?<![\p{L}\p{N}_-])(?:[\p{L}\p{N}-]+\.)+\p{L}{2,}\/[^\s<>"'`]*/giu, keepTrailing(TITLE_LINK)],
  // An address carrying a token: a +tag, or a long run in its local part (reply+abc@…, x7Kq…@…).
  [/[^\s@<>"'`()]+@(?:[a-z0-9-]+\.)+[a-z]{2,}\b/gi, (email) => {
    const local = email.slice(0, email.indexOf("@"));
    return local.includes("+") || /[A-Za-z0-9_-]{16,}/.test(local) ? TITLE_LINK : email;
  }],
  [/\beyJ[\w-]*\.[\w-]+(?:\.[\w-]*)?/g, () => TITLE_HIDDEN],
  [/\b(?:0x)?[0-9a-f]{32,}\b/gi, () => TITLE_HIDDEN],
  // Long base64 or base64url, dots and padding allowed inside: letters and digits together, 32 characters or more. No
  // word in a sentence is that long. A run never ends on a dot, so the sentence's own full stop stays.
  [/[A-Za-z0-9+/_-][A-Za-z0-9+/_.=-]{30,}[A-Za-z0-9+/_=-]/g, (run) => (/\d/.test(run) && /[A-Za-z]/.test(run) ? TITLE_HIDDEN : run)],
];

/**
 * A card's title as Home shows it, and any text Home shows in its place. Characters that show as nothing go first and
 * the rest is NFKC-normalized. Whatever the secret guard refuses goes next (redactSecrets), and its mark becomes
 * "[link]" so a title shows one link mark. Then any link is replaced with "[link]", and a bearer token, a JWT, a long
 * hex or base64 string with "[hidden]", even where the guard would let them through: a title is read at a glance, in a
 * list, and never needs to show either.
 *
 * A message relayed over Courier (`courier`) is titled by its first line, which its sender wrote. Its row already
 * starts with the Courier mark and the sender, so its title is a short summary: that line, shortened, or
 * "New message" when nothing but links and tokens was in it.
 */
export function shownTitle(title: string, courier = false): string {
  const visible = title.replace(INVISIBLE, "").normalize("NFKC").replace(LINE_BREAK, "\n");
  const guarded = redactSecrets(visible).replaceAll(REDACTED, TITLE_LINK);
  const redacted = TITLE_RULES.reduce((text, [pattern, replace]) => text.replace(pattern, replace), guarded);
  if (!courier) return redacted;
  const line = redacted.split("\n").map((part) => part.replace(/\s+/g, " ").trim()).find(Boolean) ?? "";
  const words = line.replaceAll(TITLE_LINK, "").replaceAll(TITLE_HIDDEN, "");
  if (!/[\p{L}\p{N}]/u.test(words)) return COURIER_EMPTY_TITLE;
  const chars = [...line];
  return chars.length > COURIER_TITLE_MAX ? `${chars.slice(0, COURIER_TITLE_MAX - 1).join("").trimEnd()}…` : line;
}
