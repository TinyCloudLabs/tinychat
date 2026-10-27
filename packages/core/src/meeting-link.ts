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
 */
export function meetingLinkFromInput(raw: string): string | null {
  return readLink(raw, true);
}

const MEET_CODE = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/i;
const GOOGLE_MEET_PATH = /^\/meet\/([a-z]{3}-[a-z]{4}-[a-z]{3})\/?$/i;
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const LINK_LIKE = /^(?:https?:\/\/|www\.)|^[a-z0-9-]+(?:\.[a-z0-9-]+)+\/\S/i;
const BARE_HOST = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:[/?#:]|$)/i;

function readLink(raw: string, unwrap: boolean): string | null {
  let text = raw.trim();
  // A pasted invite line: use its first link.
  if (/\s/.test(text)) text = text.split(/\s+/).map(stripWrapping).find(token => LINK_LIKE.test(token) || MEET_CODE.test(token)) ?? "";
  else text = stripWrapping(text);
  if (!text) return null;
  if (MEET_CODE.test(text)) return `https://meet.google.com/${text.toLowerCase()}`;
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
  // Google Meet's /meet/<code> variants normalize to the direct URL the provider accepts.
  const meet = (host === "google.com" || host === "www.google.com" || host === "meet.google.com")
    ? GOOGLE_MEET_PATH.exec(url.pathname)
    : null;
  if (meet) return `https://meet.google.com/${meet[1]!.toLowerCase()}${url.search}${url.hash}`;
  return text;
}

/** Drops quotes, brackets and sentence punctuation around a pasted link. */
function stripWrapping(token: string): string {
  return token.replace(/^[<("'[]+/, "").replace(/[>)"'\].,;:!?]+$/, "");
}
