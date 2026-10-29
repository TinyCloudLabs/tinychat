/**
 * The meeting link a notetaker should join, read leniently from what a person pasted.
 *
 * People paste links without `https://`, Google's `google.com/meet/<code>` form, a bare Meet
 * code, a Gmail/Calendar or Outlook redirect, or the whole "Join with Google Meet" line. The
 * transcription service only recognises a platform by its canonical host, so those forms used to
 * fail as "not a meeting link" or "platform isn't supported".
 *
 * Only those shapes are rewritten. Any other http(s) link is returned exactly as pasted (trimmed),
 * because signed and capability links (Zoom `pwd`, Signal's fragment) must reach upstream intact.
 * Returns null when nothing in the input is an http(s) link.
 *
 * Every Google Meet shape becomes `https://meet.google.com/<code>`: `/meet/<code>`, `/_meet/<code>`,
 * `g.co/meet/<code>`, `tel.meet/<code>`, a bare code with or without dashes, and the
 * `accounts.google.com?continue=` and `meet.app.goo.gl?link=` wrappers. A wrapper whose target isn't
 * a Meet link returns null, and is never followed. `meet.google.com/lookup/<nick>` can't be resolved
 * offline and is returned as pasted, like any other link. Cases: `test/fixtures/meet-link-cases.json`,
 * shared with the transcription service.
 */
export function meetingLinkFromInput(raw: string): string | null {
  return readLink(raw, true);
}

const MEET_CODE = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/i;
const BARE_CODE = /^[a-z]{10}$/i;
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const LINK_LIKE = /^(?:https?:\/\/|www\.)|^[a-z0-9-]+(?:\.[a-z0-9-]+)+\/\S/i;
const BARE_HOST = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:[/?#:]|$)/i;

function readLink(raw: string, unwrap: boolean): string | null {
  let text = raw.trim();
  // A pasted invite line: use its first Meet link, else its first link.
  const meet = firstMeetTarget(text);
  if (meet !== null) text = meet;
  else if (/\s/.test(text)) text = text.split(/\s+/).map(stripWrapping).find(token => LINK_LIKE.test(token) || MEET_CODE.test(token)) ?? "";
  else text = stripWrapping(text);
  if (!text) return null;
  if (MEET_CODE.test(text)) return `https://meet.google.com/${text.toLowerCase()}`;
  if (BARE_CODE.test(text) && !/\s/.test(raw.trim())) return `https://meet.google.com/${text.slice(0, 3)}-${text.slice(3, 7)}-${text.slice(7)}`.toLowerCase();
  if (!HAS_SCHEME.test(text)) {
    if (!BARE_HOST.test(text)) return null;
    text = `https://${text}`;
  }
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const host = url.hostname.toLowerCase();
  if (unwrap) {
    // Links copied from Gmail/Calendar and Outlook arrive wrapped in a redirect.
    const inner = (host === "google.com" || host === "www.google.com") && url.pathname === "/url"
      ? url.searchParams.get("q") ?? url.searchParams.get("url")
      : host.endsWith(".safelinks.protection.outlook.com") ? url.searchParams.get("url") : null;
    if (inner) return readLink(inner, false);
  }
  // A wrapper around a Meet link is unwrapped only when its target is a Meet link.
  const wrapped = host === "accounts.google.com" ? url.searchParams.get("continue")
    : host === "meet.app.goo.gl" ? url.searchParams.get("link") : null;
  if (wrapped !== null) return meetCanonicalFromText(wrapped);
  const canonical = meetCanonical(url);
  if (!canonical) return text;
  // A link already in canonical form is returned exactly as pasted.
  return url.href.replace(/^http:/, "https:") === canonical ? text : canonical;
}

const MEET_LOOKUP_PATH = /^\/lookup\/[^/?#&=\s]+\/?$/;
/** An exact-host `meet.google.com/…` URL that starts where a link starts: not after a letter, digit or host/path character, so lookalike hosts, userinfo and another site's query don't match. */
const MEET_HOST_URL = /(?<![\p{L}\p{N}_.@/=&?%#:+-])(?:https?:\/\/)?meet\.google\.com\/[^\s<>"'`\]]*/giu;

/** Trailing sentence punctuation is not part of a link; a closing bracket is only when the link has no opening one for it. */
function trimTrailingPunctuation(link: string): string {
  let balance = 0;
  for (const char of link) balance += char === "(" ? -1 : char === ")" ? 1 : 0;
  let end = link.length;
  for (;;) {
    const last = link[end - 1];
    if (last !== undefined && /[.,;:!?"'\]>]/.test(last)) end--;
    else if (last === ")" && balance > 0) { end--; balance--; }
    else return link.slice(0, end);
  }
}

/** The first Meet code or lookup link in free text, in the order pasted; null when there is none. */
function firstMeetTarget(text: string): string | null {
  // Where the pasted word holding each match starts, tracked as the matches advance through the text.
  let scanned = 0;
  let wordStart = 0;
  for (const match of text.matchAll(MEET_HOST_URL)) {
    for (; scanned < match.index; scanned++) if (/\s/.test(text[scanned]!)) wordStart = scanned + 1;
    // Only a label or bracket may sit between the start of the pasted word and the link: anything URL-shaped before it
    // means this Meet link is part of another link (its query, say), not a link of its own.
    if (/[/?=&#@:%]/.test(text.slice(wordStart, match.index))) continue;
    // Inside explicit <…> the link is exactly what is between them.
    const delimited = text[match.index - 1] === "<" && text[match.index + match[0].length] === ">";
    const candidate = delimited ? match[0] : trimTrailingPunctuation(match[0]);
    try {
      const url = new URL(HAS_SCHEME.test(candidate) ? candidate : `https://${candidate}`);
      if (meetCanonical(url) !== null || MEET_LOOKUP_PATH.test(url.pathname)) return candidate;
    } catch { /* not a link */ }
  }
  return null;
}

/** The canonical Meet link for a URL in one of the Meet shapes, else null. */
function meetCanonical(url: URL): string | null {
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const host = url.hostname.toLowerCase();
  const segs = url.pathname.split("/").filter(Boolean);
  const canon = (code: string | undefined, keep: boolean) =>
    code !== undefined && MEET_CODE.test(code) ? `https://meet.google.com/${code.toLowerCase()}${keep ? url.search + url.hash : ""}` : null;
  if (host === "meet.google.com") {
    if (segs.length === 1) return canon(segs[0], true);
    return segs.length === 2 && (segs[0] === "meet" || segs[0] === "_meet") ? canon(segs[1], true) : null;
  }
  // google.com/meet/<code> and g.co/meet/<code> redirect to meet.google.com/<code>.
  if (host === "google.com" || host === "www.google.com" || host === "g.co") {
    return segs.length === 2 && segs[0] === "meet" ? canon(segs[1], true) : null;
  }
  if (host === "tel.meet") return segs.length === 1 ? canon(segs[0], false) : null;
  return null;
}

function meetCanonicalFromText(value: string): string | null {
  const text = value.trim();
  try {
    return meetCanonical(new URL(HAS_SCHEME.test(text) ? text : `https://${text}`));
  } catch {
    return null;
  }
}

/** Drops quotes, brackets and sentence punctuation around a pasted link. */
function stripWrapping(token: string): string {
  return token.replace(/^[<("'[]+/, "").replace(/[>)"'\].,;:!?]+$/, "");
}
