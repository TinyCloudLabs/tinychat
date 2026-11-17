// Which image addresses in model-written or note Markdown load on their own, which ask first, and which never load.
// An image address can carry text (`![](https://host/a.png?d=<owner data>)`); a normal image address does not. This looks
// at the address alone, keeps no state, and judges shape only: a short payload in a normal-looking address passes.

export type ImageReason =
  | "credentials"
  | "long-query"
  | "many-params"
  | "long-path"
  | "encoded"
  | "text-like";

export type ImageVerdict =
  | { kind: "load" }
  | { kind: "block" }
  | { kind: "ask"; host: string; address: string; reasons: ImageReason[] };

export const MAX_QUERY_CHARS = 64;
export const MAX_QUERY_PARAMS = 8;
export const MAX_SEGMENT_CHARS = 64;
export const MAX_PATH_CHARS = 160;
const MIN_ENCODED_RUN = 40;
const MAX_HASH_HEX = 64; // a SHA-256 in hex is the longest hash a CDN names a file by
const MAX_PERCENT_ESCAPES = 8;
const MIN_TEXT_WORDS = 6;

const BASE64_RUN = /[A-Za-z0-9+_=-]{40,}/g;
const HEX = /^[0-9a-fA-F]+$/;
const PERCENT_ESCAPE = /%[0-9A-Fa-f]{2}/g;
const WORD_SEPARATORS = /[-_+\s]+/;
const WORD = /^[A-Za-z]{2,}$/;
const FILE_EXTENSION = /\.[A-Za-z0-9]{1,5}$/;

function decode(part: string): string {
  try {
    return decodeURIComponent(part.replace(/\+/g, " "));
  } catch {
    return part;
  }
}

function isEncodedRun(run: string): boolean {
  if (run.length < MIN_ENCODED_RUN) return false;
  if (HEX.test(run) && run.length <= MAX_HASH_HEX) return false;
  return /[A-Z]/.test(run) && /[a-z]/.test(run) && /\d/.test(run);
}

function wordCount(text: string): number {
  return decode(text)
    .split(WORD_SEPARATORS)
    .filter((piece) => WORD.test(piece)).length;
}

/** Judges one image address from the page's own Markdown. */
export function imageUrlVerdict(src: string): ImageVerdict {
  let url: URL;
  try {
    url = new URL(src);
  } catch {
    return { kind: "block" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return { kind: "block" };

  const reasons: ImageReason[] = [];
  if (url.username || url.password) reasons.push("credentials");

  const query = url.search.slice(1);
  const params = query === "" ? [] : query.split("&").filter(Boolean);
  if (query.length > MAX_QUERY_CHARS) reasons.push("long-query");
  if (params.length > MAX_QUERY_PARAMS) reasons.push("many-params");

  // A file name is judged without its extension: a hash plus ".jpg" is still a hash.
  const segments = url.pathname.split("/").map((segment) => segment.replace(FILE_EXTENSION, ""));
  if (url.pathname.length > MAX_PATH_CHARS || segments.some((s) => s.length > MAX_SEGMENT_CHARS)) {
    reasons.push("long-path");
  }

  // Each path segment and each query key and value is a place text can sit.
  const tokens = [...segments];
  for (const param of params) {
    const eq = param.indexOf("=");
    tokens.push(eq < 0 ? param : param.slice(0, eq), eq < 0 ? "" : param.slice(eq + 1));
  }
  const escapes = (url.pathname + url.search).match(PERCENT_ESCAPE)?.length ?? 0;
  if (escapes > MAX_PERCENT_ESCAPES || tokens.some((t) => (t.match(BASE64_RUN) ?? []).some(isEncodedRun))) {
    reasons.push("encoded");
  }
  if (tokens.some((t) => wordCount(t) >= MIN_TEXT_WORDS)) reasons.push("text-like");

  if (reasons.length === 0) return { kind: "load" };
  return { kind: "ask", host: url.host, address: url.href, reasons };
}

export const IMAGE_PROMPT_COPY = {
  title: (host: string) => `Load image from ${host}?`,
  why: (host: string) => `${host} will see the full address, which can include text from this page.`,
  load: "Load",
  notNow: "Not now",
  /** What stays where an image did not load. */
  notLoaded: (description: string) => (description ? `Image not loaded: ${description}` : "Image not loaded"),
} as const;
