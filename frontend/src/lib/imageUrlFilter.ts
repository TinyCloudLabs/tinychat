import { ADDRESS_BIT_LIMIT, IMAGE_BIT_FLOOR, URL_PLUMBING, addressBits, signedShape } from "./imageAddressBits";
import { servesOpaqueIds } from "./imageHosts";

// Which image addresses in model-written or note Markdown load on their own, which ask first, and which never load.
// An image address can carry text out (`![](https://host/a.png?d=<owner data>)`); an ordinary image address does not look
// like that. This is permissive: any host loads. Each sign that an address carries data adds a weight, and the address asks
// when the weights reach ASK_THRESHOLD. Under the signs is a bound that does not depend on shape: an address with room for
// more than ADDRESS_BIT_LIMIT bits of data asks, whatever it looks like (imageAddressBits.ts). It looks at the address
// alone and keeps no state; what the images of one reply carry together is bounded in imageBudget.ts.
//
// Normalisation: the WHATWG URL parser lowercases the host, turns an international name into its ASCII (xn--) form and an
// IPv4 host written as one number, in octal or in hex into dotted form. Each path segment and query key or value is
// percent-decoded once before it is judged; escapes that remain are a sign of their own. The fragment is never sent in the
// request, so it is not judged.

export const ASK_THRESHOLD = 100;

export type ImageReasonCode =
  | "refused"
  | "malformed"
  | "insecure"
  | "credentials"
  | "ip-host"
  | "private-host"
  | "capture-host"
  | "idn"
  | "idn-lookalike"
  | "port"
  | "host-depth"
  | "host-data"
  | "host-text"
  | "nested-url"
  | "redirect"
  | "hidden-url"
  | "params"
  | "tracking"
  | "payload-param"
  | "blob"
  | "encoded-text"
  | "secret"
  | "email"
  | "text-query"
  | "text-path"
  | "escaped-plain"
  | "binary"
  | "double-encoded"
  | "bad-escape"
  | "structured-data"
  | "long"
  | "non-ascii"
  | "capacity";

export type ImageReason = { code: ImageReasonCode; weight: number; detail: string };

export type ImageVerdict =
  | {
      kind: "load";
      score: number;
      reasons: ImageReason[];
      /** The room for data in the address, in bits (imageAddressBits.ts), counted on its own. */
      bits: number;
      /** The addresses that room was counted over: this one, or on a CDN whose requests the uploader cannot read, only the
       * addresses inside it. The reply's budget counts them again against what the reply's earlier images sent. */
      charged: string[];
    }
  | { kind: "block"; reasons: ImageReason[] }
  | { kind: "ask"; host: string; address: string; score: number; reasons: ImageReason[]; bits: number };

type Step = readonly [atLeast: number, weight: number];

/** The weight of the highest step `n` reaches; 0 below the first. */
function stepped(n: number, steps: readonly Step[]): number {
  let weight = 0;
  for (const [atLeast, w] of steps) if (n >= atLeast) weight = w;
  return weight;
}

// Opaque characters (not words, numbers or id shapes) pooled over the whole address, so a blob split across segments or
// parameters adds up. Below 28 is an ordinary id (a YouTube id is 11, a base64 MD5 22).
const BLOB_STEPS: readonly Step[] = [[28, 40], [44, 70], [56, 100], [120, 130]];
// Hash-shaped tokens (MD5/SHA hex, UUIDs, short hex fingerprints, IPFS CIDs) are how CDNs name files. This many of their
// characters are free per address (two SHA-256s, or four UUIDs or MD5s); the rest count as opaque.
const FREE_ID_CHARS = 128;
// Digits beyond this (two 19-digit snowflake ids and a timestamp) count as opaque: decimal is an encoding too.
const FREE_DIGITS = 60;
// Opaque characters in the labels above the registrable domain.
const HOST_DATA_STEPS: readonly Step[] = [[16, 40], [24, 70], [32, 100]];
const HOST_DEPTH_STEPS: readonly Step[] = [[4, 30], [5, 60], [7, 100]];
const HOST_TEXT_STEPS: readonly Step[] = [[4, 40], [6, 100]];
// Words in query values (an image parameter takes a number or a keyword, not a sentence) and in the path (headlines and
// Wikimedia file names are sentences, so the path is allowed far more). One- and two-word values are keywords
// ("lang=en", "name=large"); the first few of those are free.
const QUERY_TEXT_STEPS: readonly Step[] = [[3, 30], [4, 60], [6, 100]];
const FREE_LOOSE_WORDS = 3;
const PATH_TEXT_STEPS: readonly Step[] = [[16, 40], [20, 60], [24, 100]];
// Decoded bytes count as text only with this much variety (bits per character). Short English text is about 3 or more;
// repeated decimals read as hex ("16.666666666667") are under 2.
const MIN_TEXT_ENTROPY = 2.5;
// A stretch of printable ASCII this long inside decoded bytes is text.
const MIN_TEXT_STRETCH = 12;
const LENGTH_STEPS: readonly Step[] = [[300, 40], [600, 100]];
// Characters outside ASCII in the path and query have steps of their own.
const NON_ASCII_STEPS: readonly Step[] = [[64, 40], [128, 100]];
const MAX_PARAMS = 8;
const MAX_NESTING = 1;

const W = {
  malformed: 60,
  insecure: 15,
  credentials: 100,
  ipHost: 100,
  privateHost: 120,
  captureHost: 100,
  idn: 25,
  idnLookalike: 100,
  port: 35,
  oddPort: 60,
  nestedUrl: 40,
  redirect: 100,
  hiddenUrl: 100,
  tracking: 30,
  payloadParam: 40,
  encodedText: 100,
  secret: 100,
  email: 100,
  structuredData: 80,
  escapedPlain: 60,
  escapedPlainMany: 100,
  binary: 60,
  binaryMany: 100,
  doubleEncoded: 100,
  badEscape: 20,
} as const;

// Second-level names under a two-letter country code ("example.co.uk" is registrable, "co.uk" is not). Without the public
// suffix list this is an approximation.
const SECOND_LEVEL = new Set(["co", "com", "org", "net", "gov", "edu", "ac"]);
// Hosting platforms where the label in front of the suffix is the customer's own registered name (a bucket, a project, a
// distribution), as in the public suffix list's private section. That label is part of the registrable name: it cannot vary
// per request, so it is not judged as data.
const TENANT_SUFFIX =
  /\.(s3\.amazonaws\.com|s3[.-][a-z0-9-]+\.amazonaws\.com|cloudfront\.net|r2\.dev|r2\.cloudflarestorage\.com|[a-z0-9]+\.(?:cdn\.)?digitaloceanspaces\.com|blob\.core\.windows\.net|supabase\.co|vercel\.app|public\.blob\.vercel-storage\.com|netlify\.app|github\.io|pages\.dev|web\.app|firebaseapp\.com|appspot\.com|myshopify\.com|herokuapp\.com|imgix\.net|files\.wordpress\.com|substack\.com|b-cdn\.net|azureedge\.net)$/;
const IPV4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/;
const PRIVATE_NAME = /(?:^|\.)(?:localhost|local|internal|intranet|lan|corp|home\.arpa)$/;
// Services whose purpose is to show their owner every request they receive, and tunnels to someone's own machine.
const CAPTURE_HOST =
  /(?:^|\.)(?:webhook\.site|requestbin\.(?:com|net)|pipedream\.net|requestcatcher\.com|beeceptor\.com|hookbin\.com|interact\.sh|oast\.(?:fun|live|site|online|pro|me)|oastify\.com|burpcollaborator\.net|canarytokens\.com|dnslog\.cn|ceye\.io|ngrok\.(?:io|app|dev)|ngrok-free\.(?:app|dev)|trycloudflare\.com|loca\.lt|serveo\.net)$/;
const HOST_PLUMBING = new Set(["www", "cdn", "img", "images", "image", "static", "media", "assets", "us", "eu", "ap", "east", "west", "north", "south", "central"]);

const REDIRECT_PARAM =
  /^(?:redirect|redirect_?ur[il]|redir|next|goto|go|return|return_?to|return_?url|continue|dest|destination|target|forward|fwd|out|jump|callback|rurl|to)$/;
const TRACKING_PARAM = /^(?:utm_[a-z]+|fbclid|gclid|dclid|msclkid|yclid|twclid|igshid|mc_[ce]id|_hsenc|_hsmi|mkt_tok)$/;
const TRACKING_PATH = /(?:^|\/)(?:pixel|track(?:ing|er)?|beacon|collect|open|1x1|spacer)(?:\.(?:gif|png))?(?:\/|$)/i;
// A last path segment that names a redirector ("/url?q=", "/redirect?to=", "/out?u=").
const REDIRECT_PATH = /\/(?:url|redirect|redir|out|away|go|goto|jump|exit|leave|external|link)(?:\.[a-z]{2,5})?\/?$/i;
// The ports web servers are commonly run on besides 80 and 443.
const COMMON_PORTS = new Set(["8080", "8443", "8000", "8888", "3000", "5000"]);
// Serialized data in a value: JSON, markup, or line breaks.
const STRUCTURED = /\{\s*"|"\s*:|\[\s*\{|<\/?[a-z]+>|[\r\n]/i;
const PAYLOAD_PARAM =
  /^(?:data|payload|exfil|leak|dump|stolen|secret|password|passwd|pwd|ssn|cookie|session|session_?id|auth|credentials|creds|prompt|history|conversation|chat|context|memory|msg|message|content|body|api_?key|private|env)$/;
const ODD_SCHEME = /^(?:javascript|data|blob|file|ftp|vbscript|wss?|gopher):/i;
const HTTP_INSIDE = /https?:/i;
const SECRET_SHAPE =
  /eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.|\bsk-[A-Za-z0-9_-]{16,}|\bgh[pousr]_[A-Za-z0-9]{20,}|\bgithub_pat_|\bxox[abprs]-[A-Za-z0-9-]{10,}|\bAKIA[0-9A-Z]{16}\b|-----BEGIN/;
const EMAIL = /[A-Za-z0-9._%+-]{2,}@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.([A-Za-z]{2,})\b/;
const FILE_TYPE = /^(?:png|jpe?g|gif|webp|svg|avif|ico|bmp)$/i;
const ENCODED_FILE_PATH = /^[\w.-]+(?:\/[\w.-]+)+\.(?:png|jpe?g|gif|webp|avif|svg)$/i;
// eslint-disable-next-line no-control-regex
const ODD_RAW = /[\\\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff\uff00-\uffef]/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;
// The first character a URL parser does not skip at the start of a value.
// eslint-disable-next-line no-control-regex
const VALUE_START = /[^\s+\u0000-\u0020]/;

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b|\b[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}\b/g;
const CID = /\bbaf[a-z2-7]{50,60}\b|\bQm[1-9A-HJ-NP-Za-km-z]{44}\b/g;
// A SHA-1 or SHA-256 in padded base64url (27 or 43 characters and the "="): how thumbor and other resizers sign a path.
const BASE64_DIGEST = /(^|[^A-Za-z0-9_-])((?:[A-Za-z0-9_-]{27}|[A-Za-z0-9_-]{43})=)(?![A-Za-z0-9_=-])/g;
const UNIFORM_HEX = /^(?:[0-9a-f]+|[0-9A-F]+)$/;
const HASH_LENGTHS = new Set([24, 32, 40, 64]); // a database object id, MD5, SHA-1, SHA-256
const MAX_FINGERPRINT_HEX = 20;
// "w800", "v1312461204", "320px", "1024x768": a label with a number, not an id.
const LABELLED_NUMBER = /^(?:[A-Za-z]{1,12}\d{1,14}|\d{1,6}[A-Za-z]{1,4}|[A-Za-z]?\d{1,5}[xX]\d{1,5})$/;
const NOT_ALPHANUMERIC = /[^\p{L}\p{N}]+/u;
const BASE64_RUN = /[A-Za-z0-9+/_-]{16,}/g;
// Hex, possibly cut into groups by dashes (the shape of a UUID). A run of digits alone is a number, not hex.
const HEX_RUN = /[0-9a-fA-F][0-9a-fA-F-]{14,}[0-9a-fA-F]/g;
const BASE32_RUN = /[A-Za-z2-7]{24,}/g;
const RUN_BREAKERS = /[.~,;:!*'()\s]/g;

type Escapes = { plain: number; binary: number; double: number; stray: number };

/** Percent-decodes `part` once. Bytes that are not UTF-8 come out as Latin-1, so nothing stays hidden behind a bad escape. */
function decodeOnce(part: string, notes?: Escapes): string {
  if (notes && /%(?![0-9A-Fa-f]{2})/.test(part)) notes.stray++;
  return part.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
    const bytes = run.split("%").slice(1).map((hex) => parseInt(hex, 16));
    if (notes) {
      for (const byte of bytes) {
        if ((byte >= 0x30 && byte <= 0x39) || (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a)) notes.plain++;
        else if (byte < 0x20 || byte === 0x7f) notes.binary++;
      }
    }
    try {
      return decodeURIComponent(run);
    } catch {
      if (notes) notes.binary += bytes.filter((byte) => byte >= 0x80).length;
      return String.fromCharCode(...bytes);
    }
  });
}

const STILL_ESCAPED = /%[0-9A-Fa-f]{2}/;
/** Text in which every % begins "%20". */
const ONLY_SPACES_ESCAPED = /^(?:[^%]|%20)*$/;

/** A value as a URL parser would finally read it: decoded until stable, tabs and newlines dropped, width folded, `\` as `/`. */
function parserView(value: string): string {
  let view = value;
  for (let round = 0; round < 4; round++) {
    const next = decodeOnce(view.replace(/[\t\n\r]/g, ""));
    if (next === view) break;
    view = next;
  }
  return view.replace(/[\t\n\r]/g, "").normalize("NFKC").replace(/\\/g, "/");
}

/** Bits per character of the text's own character distribution. */
export function shannonEntropy(text: string): number {
  const counts = new Map<string, number>();
  for (const char of text) counts.set(char, (counts.get(char) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) bits -= (count / text.length) * Math.log2(count / text.length);
  return bits;
}

/** Text has letters, digits and spaces, and variety: "ffffffgffffff" (a run of sixes read as hex) is not text. */
function isText(text: string): boolean {
  const plain = text.match(/[\p{L}\p{N} ]/gu)?.length ?? 0;
  return plain >= text.length * 0.6 && shannonEntropy(text) >= MIN_TEXT_ENTROPY;
}

/** The bytes as text, when they are readable text: all of them (any script), or a stretch of plain ASCII among other bytes
 * (a run decoded with something in front of it). A hash or a signature is arbitrary bytes: twelve random bytes in a row are
 * all printable about once in a hundred thousand. */
function readable(bytes: number[]): { text: string; whole: boolean } | undefined {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes));
    if (!CONTROL.test(text) && isText(text)) return { text, whole: true };
  } catch {
    // Not UTF-8 as a whole; a stretch of it may still be text.
  }
  let best = "";
  let stretch = "";
  for (const byte of bytes) {
    stretch = byte >= 0x20 && byte < 0x7f ? stretch + String.fromCharCode(byte) : "";
    if (stretch.length > best.length) best = stretch;
  }
  return best.length >= MIN_TEXT_STRETCH && isText(best) ? { text: best, whole: false } : undefined;
}

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

/** The readable text a hex, base64, base64url or base32 run inside `token` decodes to, if any does; `run` is that run when
 * it sits in the token as written (not found only after joining pieces). Each run is tried at every alignment, so a prefix
 * glued to it ("img-<base64>") does not hide it. `whole` says the text is all the run decodes to: nothing was skipped in
 * front of it and no other bytes sit beside it. */
function hiddenText(token: string): { text: string; run?: string; whole: boolean } | undefined {
  const joined = token.replace(RUN_BREAKERS, "");
  for (const source of joined === token ? [token] : [token, joined]) {
    const found = (hit: { text: string; whole: boolean } | undefined, run: string, exact: boolean) =>
      hit === undefined ? undefined : { text: hit.text, run: source === token ? run : undefined, whole: hit.whole && exact };
    for (const run of source.match(HEX_RUN) ?? []) {
      const digits = run.replace(/-/g, "");
      // Digits alone are usually a number (an id, a timestamp); only a long run of them is tried as hex.
      if (digits.length < (/[a-fA-F]/.test(digits) ? 16 : 24)) continue;
      for (const offset of [0, 1]) {
        const hit = found(readable((digits.slice(offset).match(/../g) ?? []).map((pair) => parseInt(pair, 16))), run, offset === 0 && digits.length % 2 === 0);
        if (hit) return hit;
      }
    }
    for (const run of source.match(BASE64_RUN) ?? []) {
      // Base64 of text always has letters; digits alone are numbers that happen to decode.
      if (!/[A-Za-z]/.test(run)) continue;
      const base64 = run.replace(/-/g, "+").replace(/_/g, "/");
      for (const offset of [0, 1, 2, 3]) {
        const aligned = base64.slice(offset);
        let bytes: number[];
        try {
          bytes = Array.from(atob(aligned.slice(0, aligned.length - (aligned.length % 4 === 1 ? 1 : 0))), (char) => char.charCodeAt(0));
        } catch {
          continue;
        }
        const hit = bytes.length >= 12 ? found(readable(bytes), run, offset === 0 && aligned.length % 4 !== 1) : undefined;
        if (hit) return hit;
      }
    }
    for (const run of source.match(BASE32_RUN) ?? []) {
      const lower = run.toLowerCase();
      if (run !== lower && run !== run.toUpperCase()) continue;
      const bits = Array.from(lower, (char) => BASE32.indexOf(char).toString(2).padStart(5, "0")).join("");
      const hit = found(readable((bits.match(/.{8}/g) ?? []).map((byte) => parseInt(byte, 2))), run, true);
      if (hit) return hit;
    }
  }
  return undefined;
}

const VOWEL = /[aeiouy]/;
// No word, and no file name of joined words, runs to more letters than this without a separator.
const MAX_WORD_LETTERS = 32;

/** A run of letters that reads as a word or as joined words (camelCase), not as a random string. A Latin word with
 * diacritics is judged as the plain word. Another script has no word shape this can check, so it is counted by its
 * characters, four to a word, and like a Latin word it is not a word past MAX_WORD_LETTERS without a separator. A run
 * that mixes scripts is not a word. */
function wordsIn(run: string): string[] | undefined {
  if (/[^A-Za-z]/.test(run)) {
    if (/^\p{Script=Latin}+$/u.test(run)) return wordsIn(run.normalize("NFD").replace(/\p{M}/gu, "").replace(/[^A-Za-z]/g, "e"));
    if (/[A-Za-z]/.test(run) || Array.from(run).length > MAX_WORD_LETTERS) return undefined;
    return run.match(/.{1,4}/gu) ?? [];
  }
  const letters = run;
  const parts = letters.replace(/([a-z])([A-Z])/g, "$1 $2").split(" ");
  if (!parts.every((part) => /^(?:[A-Z]?[a-z]+|[A-Z]+|[A-Z]{2,5}[a-z]{3,})$/.test(part))) return undefined;
  if (letters.length >= 6 && letters.length / parts.length < 3) return undefined;
  for (const part of parts) {
    if (part.length > MAX_WORD_LETTERS) return undefined;
    if (part.length < 12) continue;
    const lower = part.toLowerCase();
    const vowels = [...lower].filter((char) => VOWEL.test(char)).length / lower.length;
    if (vowels < 0.2 || vowels > 0.7 || /[^aeiouy]{6}/.test(lower)) return undefined;
  }
  return parts;
}

type Pool = {
  add: (code: ImageReasonCode, weight: number, detail: string) => void;
  opaque: string[];
  /** Every piece that could be part of an encoded run (opaque pieces, hex ids, longer numbers), in address order. */
  runs: string[];
  idChars: number;
  digits: number;
  chars: number;
  pathWords: Set<string>;
  queryWords: Set<string>;
  looseWords: Set<string>;
  escapes: Escapes;
  nested: number;
  /** The non-ASCII characters of each path segment and query key and value; a file name that repeats is counted once. */
  nonAscii: Set<string>;
  /** The addresses whose room for data is counted (see ImageVerdict.charged). */
  charged: string[];
};

/** Sorts one decoded path segment or query key or value into the pool: words, numbers, id shapes and what is left, opaque. */
function judgeToken(token: string, where: "path" | "query-key" | "query-value", pool: Pool, waived: boolean): void {
  if (waived) return;
  pool.chars += token.length;
  // eslint-disable-next-line no-control-regex
  const foreign = token.replace(/[\u0000-\u007f]/g, "");
  if (foreign !== "") pool.nonAscii.add(foreign);
  const shaped = token
    .replace(UUID, (id) => ((pool.idChars += id.length - 4), " "))
    .replace(CID, (id) => ((pool.idChars += id.length), " "))
    .replace(BASE64_DIGEST, (_match, before: string, id: string) => ((pool.idChars += id.length === 28 ? 40 : 64), `${before} `));
  const phrase = new Set<string>();
  const crumbs: string[] = [];
  const before = pool.opaque.length;
  for (const piece of shaped.split(NOT_ALPHANUMERIC)) {
    if (piece === "") continue;
    if (/^\d+$/.test(piece)) {
      if (piece.length >= 8) pool.runs.push(piece);
      if (piece.length > 20) pool.opaque.push(piece);
      else pool.digits += piece.length;
    } else if (/^\p{L}+$/u.test(piece)) {
      const words = wordsIn(piece);
      if (words === undefined) {
        if (piece.length >= 6) pool.opaque.push(piece);
        pool.runs.push(piece);
        continue;
      }
      const bag = where === "path" ? pool.pathWords : phrase;
      for (const word of words) if (word.length >= 2 && !URL_PLUMBING.has(word.toLowerCase())) bag?.add(word.toLowerCase());
    } else if (/[^A-Za-z0-9]/.test(piece)) {
      // Letters or digits mixed with another script: not a word in either, so it is opaque.
      pool.opaque.push(piece);
    } else if (piece.length < 6) {
      if (!LABELLED_NUMBER.test(piece)) crumbs.push(piece);
    } else if (UNIFORM_HEX.test(piece) && (piece.length <= MAX_FINGERPRINT_HEX || HASH_LENGTHS.has(piece.length))) {
      pool.idChars += piece.length;
      pool.runs.push(piece);
    } else if (LABELLED_NUMBER.test(piece)) {
      pool.digits += piece.replace(/\D/g, "").length;
    } else {
      pool.opaque.push(piece);
      pool.runs.push(piece);
    }
  }
  // Short mixed pieces next to a long opaque run are part of it: standard base64 is cut up by its own "+" and "/".
  if (pool.opaque.slice(before).join("").length >= 12) pool.opaque.push(...crumbs);
  // A query value of three or more words is a phrase; one or two words is usually a keyword ("lang=en", "name=large").
  // A parameter name is a name ("expirationTimestamp"); only a phrase in that place counts.
  if (phrase.size >= 3) for (const word of phrase) pool.queryWords.add(word);
  else if (where === "query-value") for (const word of phrase) pool.looseWords.add(word);
}

/** RFC 3492: the Unicode form of an `xn--` label's tail. */
function punycodeDecode(input: string): string | undefined {
  const basic = input.lastIndexOf("-");
  const out = basic > 0 ? Array.from(input.slice(0, basic), (char) => char.charCodeAt(0)) : [];
  let n = 128;
  let i = 0;
  let bias = 72;
  for (let at = basic > 0 ? basic + 1 : 0; at < input.length; ) {
    const before = i;
    for (let weight = 1, k = 36; ; k += 36) {
      if (at >= input.length) return undefined;
      const code = input.charCodeAt(at++);
      const digit = code >= 48 && code <= 57 ? code - 22 : code >= 97 && code <= 122 ? code - 97 : 36;
      if (digit >= 36) return undefined;
      i += digit * weight;
      const t = k <= bias ? 1 : k >= bias + 26 ? 26 : k - bias;
      if (digit < t) break;
      weight *= 36 - t;
    }
    const length = out.length + 1;
    let delta = before === 0 ? Math.floor((i - before) / 700) : (i - before) >> 1;
    delta += Math.floor(delta / length);
    let k = 0;
    for (; delta > 455; k += 36) delta = Math.floor(delta / 35);
    bias = k + Math.floor((36 * delta) / (delta + 38));
    n += Math.floor(i / length);
    i %= length;
    if (n > 0x10ffff) return undefined;
    out.splice(i++, 0, n);
  }
  return String.fromCodePoint(...out);
}

// Cyrillic and Greek letters that are drawn like Latin ones: a label made only of these reads as a Latin name.
const LATIN_TWINS = /^[аеорсухіјѕһԁԛԝӏοανρτυικ0-9-]+$/u;
const OTHER_SCRIPT = /[\p{Script=Cyrillic}\p{Script=Greek}\p{Script=Armenian}\p{Script=Cherokee}]/u;

function isPrivateIPv4(a: number, b: number): boolean {
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

function isPrivateIPv6(address: string): boolean {
  if (address === "::" || address === "::1" || /^f[cd]/.test(address) || /^fe[89ab]/.test(address)) return true;
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(address);
  if (!mapped) return false;
  const high = parseInt(mapped[1]!, 16);
  return isPrivateIPv4(high >> 8, high & 0xff);
}

/** The labels of a host name above its registrable domain: "a.b.example.com" -> ["a", "b"]. */
function labelsAboveRegistrable(host: string, labels: string[]): string[] {
  const tenant = TENANT_SUFFIX.exec(host);
  const tld = labels.at(-1) ?? "";
  const registrable = tenant
    ? tenant[1]!.split(".").length + 1
    : labels.length > 2 && tld.length === 2 && SECOND_LEVEL.has(labels.at(-2) ?? "")
      ? 3
      : 2;
  return labels.slice(0, Math.max(0, labels.length - registrable));
}

function judgeHost(hostname: string, add: Pool["add"]): void {
  const host = hostname.replace(/\.$/, "");
  if (host.startsWith("[")) {
    const address = host.slice(1, -1);
    if (isPrivateIPv6(address)) add("private-host", W.privateHost, `${host} is a loopback or private network address`);
    else add("ip-host", W.ipHost, `${host} is an IP address, not a name`);
    return;
  }
  const ipv4 = IPV4.exec(host);
  if (ipv4) {
    if (isPrivateIPv4(Number(ipv4[1]), Number(ipv4[2]))) add("private-host", W.privateHost, `${host} is a loopback or private network address`);
    else add("ip-host", W.ipHost, `${host} is an IP address, not a name`);
    return;
  }
  if (!host.includes(".") || PRIVATE_NAME.test(host)) {
    add("private-host", W.privateHost, `${host} is a name on this machine or the local network`);
    return;
  }
  if (CAPTURE_HOST.test(host)) add("capture-host", W.captureHost, `${host} is a request-capture or tunnel service`);

  const labels = host.split(".");
  if (labels.includes("")) add("malformed", W.malformed, "the host name has an empty label");
  const unicodeLabels = labels.map((label) => {
    if (!label.startsWith("xn--")) return label;
    const unicode = punycodeDecode(label.slice(4));
    const ownLetters = unicode?.replace(/[0-9-]/g, "") ?? "";
    if (unicode === undefined) add("idn", W.idnLookalike, `${label} is not valid punycode`);
    else if (LATIN_TWINS.test(unicode) || (OTHER_SCRIPT.test(ownLetters) && /\p{Script=Latin}/u.test(ownLetters))) {
      add("idn-lookalike", W.idnLookalike, `${label} is "${unicode}": letters from another script that look Latin`);
    } else add("idn", W.idn, `${label} is the international name "${unicode}"`);
    return unicode ?? label;
  });

  const above = labelsAboveRegistrable(host, unicodeLabels);
  const depth = stepped(above.length, HOST_DEPTH_STEPS);
  if (depth > 0) add("host-depth", depth, `${above.length} labels above the registrable domain`);

  let opaque = 0;
  const words = new Set<string>();
  for (const label of above) {
    for (const piece of label.split(NOT_ALPHANUMERIC)) {
      if (/^\d+$/.test(piece)) {
        if (piece.length > 4) opaque += piece.length;
      } else if (/^\p{L}+$/u.test(piece)) {
        const found = wordsIn(piece);
        if (found === undefined) opaque += piece.length;
        else for (const word of found) if (word.length >= 2 && !HOST_PLUMBING.has(word)) words.add(word);
      } else if (/[^A-Za-z0-9]/.test(piece) || (piece.length >= 4 && !LABELLED_NUMBER.test(piece))) {
        opaque += piece.length;
      }
    }
  }
  const hidden = hiddenText(above.join(""));
  if (hidden !== undefined) add("encoded-text", W.encodedText, `the subdomain labels decode to readable text ("${hidden.text.slice(0, 24)}")`);
  const data = stepped(opaque, HOST_DATA_STEPS);
  if (data > 0) add("host-data", data, `${opaque} opaque characters in the subdomain labels`);
  const text = stepped(words.size, HOST_TEXT_STEPS);
  if (text > 0) add("host-text", text, `${words.size} words in the subdomain labels`);
}

/** The names of the query parameters that form a complete, well-formed signed-URL shape (imageAddressBits.ts): those
 * parameters are not judged as blobs, length or parameter count; their room for data is counted by their grammar. A
 * signature that decodes to text is not a signature. */
function signedParams(params: readonly (readonly [string, string])[]): ReadonlySet<string> {
  const shape = signedShape(params);
  if (!shape || params.some(([name, value]) => shape.names.has(name) && hiddenText(value) !== undefined)) return new Set();
  return shape.names;
}

/** An address inside `text` (decoded once): where it starts, or -1. `leading` allows the scheme-less `//host` form. */
function nestedAt(text: string, leading: boolean): number {
  const http = text.search(HTTP_INSIDE);
  if (http >= 0) return http;
  if (!leading) return -1;
  const start = text.search(VALUE_START);
  const bare = start < 0 ? "" : text.slice(start);
  return bare.startsWith("//") || ODD_SCHEME.test(bare) ? start : -1;
}

function looksNested(view: string): boolean {
  return HTTP_INSIDE.test(view) || /:\/\/|^\s*\/\//.test(view) || ODD_SCHEME.test(view.trim());
}

/** Judges one URL's own parts into the pool; an address found inside it is judged the same way, into the same pool.
 * `outerCharged` says an address around this one already has its room for data counted, this one's text included. */
function gather(url: URL, raw: string, depth: number, pool: Pool, outerCharged = false): void {
  const { add } = pool;
  const inside = depth > 0 ? "inside the address: " : "";
  const note: Pool["add"] = (code, weight, detail) => add(code, weight, inside + detail);

  if (ODD_RAW.test(raw) || !/^https?:\/\/[^/\\]/i.test(raw)) {
    note("malformed", W.malformed, "written in a form the browser silently repairs (backslashes, control or invisible characters, or no //)");
  }
  if (url.protocol === "http:") note("insecure", W.insecure, "http, not https");
  if (url.username || url.password) note("credentials", W.credentials, "a user name or password before the host");
  judgeHost(url.hostname, note);
  if (url.port) note("port", COMMON_PORTS.has(url.port) ? W.port : W.oddPort, `port ${url.port}`);

  const waived = servesOpaqueIds(url.hostname.replace(/\.$/, ""));
  const chargedHere = !outerCharged && !waived;
  if (chargedHere) pool.charged.push(url.href);

  // An address inside this one. Its parts are judged in place of the text that carries it, which is sound only when that
  // text is exactly the address as a URL parser writes it back: nothing in front of it, no fragment, no dot-segments, no
  // escaping the parser would change. Otherwise the outer host receives bytes the inner address does not show, so it asks,
  // and the caller judges the whole text as written. Returns whether the inner address was judged.
  const nested = (inner: string, redirect: boolean, before = ""): boolean => {
    const again = pool.nested++ > 0;
    let innerUrl: URL | undefined;
    try {
      innerUrl = new URL(inner);
    } catch {
      innerUrl = undefined;
    }
    const web = innerUrl !== undefined && /^https?:$/.test(innerUrl.protocol);
    const canonical = web && before === "" && !inner.includes("#") && innerUrl!.href === inner;
    if (redirect) note("redirect", W.redirect, "a redirect parameter carries another address");
    else if (!web) note("nested-url", W.hiddenUrl, "carries an address that is not a web address");
    else if (depth >= MAX_NESTING || again) note("nested-url", W.hiddenUrl, "more than one address inside the address");
    else if (!canonical) note("nested-url", W.hiddenUrl, "the address inside is not written as a browser writes one (text before it, a fragment, dot-segments or changed escaping)");
    else note("nested-url", W.nestedUrl, `carries another address (${innerUrl!.host})`);
    if (!canonical || depth >= MAX_NESTING) return false;
    gather(innerUrl!, inner, depth + 1, pool, outerCharged || chargedHere);
    return true;
  };

  // Path. A segment where another address starts hands the rest of the path to that address.
  const segments = url.pathname.split("/");
  let pathNested = false;
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index]!;
    const once = decodeOnce(segment);
    const at = nestedAt(once, false);
    if (at >= 0) {
      const rest = segments.slice(index + 1);
      if (!nested([once.slice(at), ...rest].join("/"), false, once.slice(0, at))) for (const whole of [segment, ...rest]) judgeSegment(whole, "path", pool, waived);
      pathNested = true;
      break;
    }
    const hidden = judgeSegment(segment, "path", pool, waived);
    if (hidden !== undefined) nested(hidden, false);
  }
  if (!pathNested && looksNested(parserView(url.pathname).replace(/^\/+/, "x"))) {
    note("hidden-url", W.hiddenUrl, "the path hides another address behind repeated or odd encoding");
  }
  if (TRACKING_PATH.test(url.pathname)) note("tracking", W.tracking, "the path is a tracking-pixel name");

  // Query.
  const query = url.search.slice(1);
  const params = (query === "" ? [] : query.split(/[&;]/).filter(Boolean)).map((param) => {
    const eq = param.indexOf("=");
    return [eq < 0 ? param : param.slice(0, eq), eq < 0 ? "" : param.slice(eq + 1)] as const;
  });
  const signed = signedParams(params.map(([key, value]) => [decodeOnce(key), decodeOnce(value)] as const));
  let counted = 0;
  let tracking = false;
  for (const [key, value] of params) {
    const name = decodeOnce(key).toLowerCase();
    if (signed.has(decodeOnce(key))) continue;
    counted++;
    if (TRACKING_PARAM.test(name)) tracking = true;
    const inKey = judgeSegment(key, "query-key", pool, waived);
    if (inKey !== undefined) nested(inKey, false);
    const once = decodeOnce(value);
    const at = nestedAt(once, true);
    if (at >= 0) {
      if (!nested(once.slice(at), REDIRECT_PARAM.test(name) || REDIRECT_PATH.test(url.pathname), once.slice(0, at))) judgeSegment(value, "query-value", pool, waived);
      continue;
    }
    if (looksNested(parserView(value))) {
      note("hidden-url", W.hiddenUrl, `parameter ${name} hides another address behind repeated or odd encoding`);
    }
    if (PAYLOAD_PARAM.test(name) && once.length >= 4) note("payload-param", W.payloadParam, `a parameter named ${name} with a value`);
    // A value that is itself a path ("url=/images/hero.png") is judged as path, where words are ordinary.
    const hidden = judgeSegment(value, /^[^\s+]*\/[^\s+]*$/.test(once) ? "path" : "query-value", pool, waived);
    if (hidden !== undefined) nested(hidden, REDIRECT_PARAM.test(name) || REDIRECT_PATH.test(url.pathname));
  }
  if (tracking) note("tracking", W.tracking, "tracking parameters");
  if (!waived && counted > MAX_PARAMS) {
    note("params", 30 + 15 * (counted - MAX_PARAMS - 1), `${counted} query parameters`);
  }
}

/** Decodes one raw segment, key or value once (again while escapes remain, noting that) and judges it. Returns the web
 * address an encoded run in it decodes to, if one does (GitHub's camo proxy, imgix `mark64=`), for the caller to judge. */
function judgeSegment(raw: string, where: "path" | "query-key" | "query-value", pool: Pool, waived: boolean): string | undefined {
  // Every layer of encoding is decoded and noted: control and non-text bytes under a second layer count like any others.
  // A second layer is itself a sign, with one exception: when the only thing under it is spaces ("%2520", a file name
  // escaped twice by a publisher's CDN). A space is not data, and what it separates is judged as words like any other.
  let text = decodeOnce(raw, pool.escapes);
  for (let round = 0; round < 3 && STILL_ESCAPED.test(text); round++) {
    if (round === 0 && !ONLY_SPACES_ESCAPED.test(text)) pool.escapes.double++;
    text = decodeOnce(text, pool.escapes);
  }
  // An encoded run that is really text, wherever it sits and whoever the host is. One that is exactly a web address or an
  // image's file path ("img/31430110.jpg"), with nothing else in the run, is what some CDNs put in their addresses: it is
  // judged as that address or path.
  const hidden = hiddenText(text);
  let address: string | undefined;
  if (hidden?.run !== undefined && hidden.whole && /^https?:\/\/\S+$/i.test(hidden.text)) {
    address = hidden.text;
    text = text.replace(hidden.run, " ");
  } else if (hidden?.run !== undefined && hidden.whole && ENCODED_FILE_PATH.test(hidden.text)) {
    text = text.replace(hidden.run, " ");
    judgeToken(hidden.text, "path", pool, waived);
  } else if (hidden !== undefined && (!waived || looksNested(hidden.text))) {
    pool.add("encoded-text", W.encodedText, `an encoded run decodes to readable text ("${hidden.text.slice(0, 24)}")`);
  }
  if (SECRET_SHAPE.test(text)) pool.add("secret", W.secret, "contains something shaped like a key or token");
  const email = EMAIL.exec(text);
  if (email && !FILE_TYPE.test(email[1]!)) pool.add("email", W.email, "contains an email address");
  if (STRUCTURED.test(text)) pool.add("structured-data", W.structuredData, "contains serialized data (JSON, markup or line breaks)");
  judgeToken(text, where, pool, waived);
  return address;
}

/** Judges one image address from the page's own Markdown. */
export function imageUrlVerdict(src: string): ImageVerdict {
  const raw = src.trim();
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { kind: "block", reasons: [{ code: "refused", weight: ASK_THRESHOLD, detail: "not an absolute web address" }] };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { kind: "block", reasons: [{ code: "refused", weight: ASK_THRESHOLD, detail: `${url.protocol} addresses never load` }] };
  }

  const reasons: ImageReason[] = [];
  const pool: Pool = {
    // The same finding from several places (two encoded runs, an address inside the address) is reported once per detail.
    add: (code, weight, detail) => {
      if (!reasons.some((reason) => reason.code === code && reason.detail === detail)) reasons.push({ code, weight, detail });
    },
    opaque: [],
    runs: [],
    idChars: 0,
    digits: 0,
    chars: 0,
    pathWords: new Set(),
    queryWords: new Set(),
    looseWords: new Set(),
    escapes: { plain: 0, binary: 0, double: 0, stray: 0 },
    nested: 0,
    nonAscii: new Set(),
    charged: [],
  };
  gather(url, raw, 0, pool);

  // A blob cut into pieces that each look like an id or a number still decodes once the pieces are put back together.
  // Unrelated pieces joined by chance can decode to stray letters of other scripts, so only plain ASCII text counts here.
  const split = pool.runs.length > 1 && !reasons.some((reason) => reason.code === "encoded-text") ? hiddenText(pool.runs.join("")) : undefined;
  if (split !== undefined && /^[\u0020-\u007e]{16,}$/.test(split.text)) {
    pool.add("encoded-text", W.encodedText, `pieces of the address join into an encoded run that decodes to readable text ("${split.text.slice(0, 24)}")`);
  }

  // The same opaque piece twice (a Wikimedia thumbnail repeats its file name) says nothing new.
  const joined = [...new Set(pool.opaque)].join("");
  const opaque = joined.length + Math.max(0, pool.idChars - FREE_ID_CHARS) + Math.max(0, pool.digits - FREE_DIGITS);
  const blob = stepped(opaque, BLOB_STEPS);
  if (blob > 0) {
    pool.add("blob", blob, `${opaque} opaque characters in the path and query${joined ? ` (${shannonEntropy(joined).toFixed(1)} bits per character)` : ""}`);
  }
  const loose = [...pool.looseWords].filter((word) => !pool.queryWords.has(word)).length;
  const queryWords = pool.queryWords.size + Math.max(0, loose - FREE_LOOSE_WORDS);
  const queryText = stepped(queryWords, QUERY_TEXT_STEPS);
  if (queryText > 0) pool.add("text-query", queryText, `${queryWords} words in the query values`);
  const pathText = stepped(pool.pathWords.size, PATH_TEXT_STEPS);
  if (pathText > 0) pool.add("text-path", pathText, `${pool.pathWords.size} different words in the path`);
  const long = stepped(pool.chars, LENGTH_STEPS);
  if (long > 0) pool.add("long", long, `${pool.chars} characters of path and query`);
  const nonAscii = [...pool.nonAscii].reduce((sum, run) => sum + Array.from(run).length, 0);
  const foreign = stepped(nonAscii, NON_ASCII_STEPS);
  if (foreign > 0) pool.add("non-ascii", foreign, `${nonAscii} characters outside ASCII in the path and query`);

  const { plain, binary, double, stray } = pool.escapes;
  if (plain > 0) pool.add("escaped-plain", plain > 2 ? W.escapedPlainMany : W.escapedPlain, `${plain} letters or digits written as %XX, which nothing needs`);
  if (binary > 0) pool.add("binary", binary > 3 ? W.binaryMany : W.binary, `${binary} percent-escapes that decode to control or non-text bytes`);
  if (double > 0) pool.add("double-encoded", W.doubleEncoded, "percent-encoded more than once");
  if (stray > 0) pool.add("bad-escape", W.badEscape, "a % that is not an escape");

  // The bound under the signs: the room for data, whatever its shape.
  const seen = new Set<string>();
  const bits = Math.max(IMAGE_BIT_FLOOR, Math.ceil(pool.charged.reduce((sum, href) => sum + addressBits(new URL(href), seen), 0)));
  if (bits > ADDRESS_BIT_LIMIT) pool.add("capacity", ASK_THRESHOLD, `room for about ${bits} bits of data, over the ${ADDRESS_BIT_LIMIT} one address may have`);

  const score = reasons.reduce((sum, reason) => sum + reason.weight, 0);
  if (score < ASK_THRESHOLD) return { kind: "load", score, reasons, bits, charged: pool.charged };
  return { kind: "ask", host: url.host, address: url.href, score, reasons, bits };
}

export const IMAGE_PROMPT_COPY = {
  title: (host: string) => `Load image from ${host}?`,
  why: (host: string) => `${host} will see the full address, which can include text from this page.`,
  load: "Load",
  notNow: "Not now",
  /** What stays where an image did not load. */
  notLoaded: (description: string) => (description ? `Image not loaded: ${description}` : "Image not loaded"),
  /** One prompt for the images a reply or note holds beyond what loads on its own (lib/imageBudget.ts). */
  more: {
    title: (count: number, hosts: readonly string[]) => {
      const shown = hosts.slice(0, 3);
      const sites =
        hosts.length > 3
          ? `${shown.join(", ")} and ${hosts.length - 3} more ${hosts.length === 4 ? "site" : "sites"}`
          : shown.length > 1
            ? `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}`
            : (shown[0] ?? "");
      return `Load ${count} more ${count === 1 ? "image" : "images"} from ${sites}?`;
    },
    why: "These sites will see the full addresses, which can include text from this page.",
  },
} as const;
