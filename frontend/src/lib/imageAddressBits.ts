// How much room an image address has for data, in bits.
//
// The weighted signs in imageUrlFilter.ts recognise shapes (an encoded run, a blob, a redirect). This is the bound under
// them: whatever the shape, an address can carry no more than it has room for. The estimate is the length of a code that
// can write the address down, piece by piece: every character the receiving server gets is charged log2 of the alphabet
// it is drawn from. Because it is a code (each address has a codeword, no codeword is the start of another), at most 2^B
// different addresses can cost B bits or less, so addresses that cost B bits in total cannot carry more than B bits,
// however the data is disguised. Nothing in it is a guess about intent, and no character is free.
//
// What is charged: the whole host name (no part of it is assumed to be fixed), the port, and the path and query as sent,
// percent-decoded once, plus how they were escaped. The fragment is never sent. A piece that already appeared (earlier in
// the address, or in an earlier image of the same reply) costs only an index into what has been seen: a gallery from one
// site does not pay for its host and folders again.

// The two limits. An ordinary image address is 60 to 100 characters at 5 to 6 bits each: on about 7,700 real <img src>
// addresses the estimate has a median of about 540 bits, a 99th percentile of about 1,240 and a maximum of 1,486. So
// neither limit can be small without asking about ordinary images. The limit on one address is the lowest round number
// none of those real addresses reaches. The reply's budget is the bound on what a reply can send without a prompt: at
// 4,096 about half of real ten-image replies would show the prompt, at 8,192 none did.
/** An address with more room than this asks. */
export const ADDRESS_BIT_LIMIT = 1536;
/** The images of one reply or note that load without asking have, together, no more room than this (imageBudget.ts). */
export const REPLY_BIT_BUDGET = 8192;
/** No image is free: each is charged at least this, whatever its host. */
export const IMAGE_BIT_FLOOR = 32;

// Words that are URL plumbing rather than text: file types, sizes and the vocabulary of image CDNs' transform parameters.
export const URL_PLUMBING: ReadonlySet<string> = new Set(
  (
    "image images img photo photos picture pictures pic pics media upload uploads file files asset assets static content " +
    "public thumb thumbs thumbnail thumbnails fetch cdn wp commons wikipedia avatar avatars original default large medium " +
    "small png jpg jpeg gif webp svg avif ico bmp format auto fit crop fill cover contain center faces face entropy compress " +
    "tinysrgb srgb smart true false block light dark top bottom left right clip scale limit good best eco low progressive " +
    "steep quality width height resize size max min identicon retro robohash monsterid wavatar blank px"
  ).split(" "),
);

// The words an address is most likely to hold. One of them costs an index into this list instead of its letters.
const COMMON_WORDS: ReadonlySet<string> = new Set([
  ...URL_PLUMBING,
  ...(
    "www com org net io co uk de app api web http https the of and in to for on at by with from is logo logos icon icons " +
    "banner hero header footer background main index home page news article articles post posts blog user users profile " +
    "product products item items category gallery video videos production prod dist build cache resources data new store " +
    "mobile desktop black white wikimedia github amazonaws cloudfront"
  ).split(" "),
]);

// What starts each piece of the code, in bits. As probabilities (2^-bits) these sum to under 1 over everything that can
// come next: 6 common separators, 60 other ASCII characters, the end of the text, and the 10 kinds of piece.
const COMMON_SEPARATOR = 4; // / . - _ = &
const OTHER_ASCII = 9; // any other ASCII character that is not a letter or digit, control characters included
const END_OF_TEXT = 4;
// rare: hex, base36, base62, mixed-case letters, non-ASCII, and text written as hex
const KIND = { seen: 4, common: 3, word: 3, number: 4, rare: 7 } as const;

const LETTER_CASES = Math.log2(3); // lower, Capitalized or UPPER
/** A piece of `length` characters from an alphabet of `symbols`, with one more symbol to end it. */
const spelled = (length: number, symbols: number) => (length + 1) * Math.log2(symbols + 1);

// Characters outside ASCII, by block: [first, last, bits for one character, with room for an end mark]. A run stays in one
// block; a character in no listed block is charged as any code point at all.
const BLOCKS: readonly (readonly [number, number, number])[] = [
  [0x80, 0x24f, 9], // Latin with diacritics
  [0x370, 0x3ff, 8], // Greek
  [0x400, 0x52f, 9], // Cyrillic
  [0x590, 0x5ff, 7], // Hebrew
  [0x600, 0x6ff, 9], // Arabic
  [0x900, 0xe7f, 11], // Indic scripts and Thai
  [0x3040, 0x30ff, 8], // kana
  [0x4e00, 0x9fff, 15], // CJK ideographs
  [0xac00, 0xd7af, 14], // Hangul
];
const ANY_CODE_POINT = 21;
const BLOCK_CHOICE = Math.log2(BLOCKS.length + 1);

function blockOf(codePoint: number): number {
  return BLOCKS.findIndex(([first, last]) => codePoint >= first && codePoint <= last);
}

const SINGLE_CASE_WORD = /^(?:[a-z]+|[A-Z]+|[A-Z][a-z]+)$/;

/** The cheapest way to write a run of ASCII letters and digits as one piece, not counting an index into `seen`. */
function wholeRun(run: string): number {
  if (/^\d+$/.test(run)) return KIND.number + spelled(run.length, 10);
  if (SINGLE_CASE_WORD.test(run)) {
    const letters = KIND.word + LETTER_CASES + spelled(run.length, 26);
    return COMMON_WORDS.has(run.toLowerCase()) ? Math.min(letters, KIND.common + LETTER_CASES + Math.log2(COMMON_WORDS.size)) : letters;
  }
  if (/^[A-Za-z]+$/.test(run)) return KIND.rare + spelled(run.length, 52);
  if (/^(?:[0-9a-f]+|[0-9A-F]+)$/.test(run)) return KIND.rare + 1 + spelled(run.length, 16);
  if (/^(?:[0-9a-z]+|[0-9A-Z]+)$/.test(run)) return KIND.rare + 1 + spelled(run.length, 36);
  return KIND.rare + spelled(run.length, 62);
}

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![0-9a-f])";
// A UUID (in either case), a run of ASCII letters and digits, a run outside ASCII, or one other ASCII character.
const UUID_UPPER = UUID.replace(/a-f/g, "A-F");
const PIECES = new RegExp(`${UUID}|${UUID_UPPER}|[A-Za-z0-9]+|[^\\u0000-\\u007f]+|[\\u0000-\\u007f]`, "g");
const IS_UUID = new RegExp(`^(?:${UUID}|${UUID_UPPER})$`);

/** A run of ASCII letters and digits: as one piece, as one already seen, or as its letter runs and digit runs in turn
 * ("320px" is a number and a word), whichever is cheapest. Everything it holds is then seen. */
function runBits(run: string, seen: Set<string>): number {
  const index = (piece: string) => (seen.has(piece) ? KIND.seen + Math.log2(seen.size) : Infinity);
  const parts = run.match(/[A-Za-z]+|\d+/g) ?? [];
  let bits = Math.min(index(run), wholeRun(run));
  if (parts.length > 1) bits = Math.min(bits, parts.reduce((sum, part) => sum + Math.min(index(part), wholeRun(part)), 0));
  // Printable text written as hex (how GitHub's image proxy writes the address it fetches) costs what the text costs.
  if (run.length >= 16 && /^(?:(?:[0-9a-f]{2})+|(?:[0-9A-F]{2})+)$/.test(run)) {
    const text = String.fromCharCode(...(run.match(/../g) ?? []).map((pair) => parseInt(pair, 16)));
    if (/^[\u0020-\u007e]+$/.test(text)) bits = Math.min(bits, KIND.rare + 1 + textBits(text, seen));
  }
  for (const piece of [run, ...parts]) seen.add(piece);
  return bits;
}

/** A run of characters outside ASCII, cut wherever the block changes. */
function foreignBits(run: string, seen: Set<string>): number {
  if (seen.has(run)) return KIND.seen + Math.log2(seen.size);
  seen.add(run);
  let bits = 0;
  let block: number | undefined;
  for (const char of run) {
    const next = blockOf(char.codePointAt(0)!);
    const perChar = next < 0 ? ANY_CODE_POINT : BLOCKS[next]![2];
    if (next !== block) bits += KIND.rare + BLOCK_CHOICE + perChar; // a new piece: its kind, its block and its end mark
    block = next;
    bits += perChar;
  }
  return bits;
}

/** A text as its pieces in turn, and its end. */
function textBits(text: string, seen: Set<string>): number {
  let bits = END_OF_TEXT;
  for (const piece of text.match(PIECES) ?? []) {
    if (IS_UUID.test(piece)) {
      // A UUID is 128 bits in either case. The shape is tested, not the length: other pieces are 36 long too.
      bits += seen.has(piece) ? KIND.seen + Math.log2(seen.size) : KIND.rare + 1 + 128;
      seen.add(piece);
    } else if (/^[A-Za-z0-9]/.test(piece)) bits += runBits(piece, seen);
    else if (piece.charCodeAt(0) > 0x7f) bits += foreignBits(piece, seen);
    else bits += "/.-_=&".includes(piece) ? COMMON_SEPARATOR : OTHER_ASCII;
  }
  return bits;
}

/** Percent-decodes `text` once. A run of escapes that is not UTF-8 comes out as one lone surrogate per byte: text no valid
 * escape decodes to, so two different addresses never decode to the same text. */
function decodeEscapes(text: string): string {
  return text.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
    try {
      return decodeURIComponent(run);
    } catch {
      return String.fromCharCode(...run.split("%").slice(1).map((hex) => 0xdc00 + parseInt(hex, 16)));
    }
  });
}

// The path and query are charged as their decoded text, so how they were escaped is charged here: three habits, and the
// exceptions to each. An escape the URL parser would have written anyway (a non-ASCII byte, a space, a quote) is no choice
// and costs nothing. A letter, digit or one of - . _ ~ is left as it is: each one escaped is an exception. Other
// punctuation is either escaped (encodeURIComponent) or left, and the hex digits are in one case or the other: whichever
// the part does less often is the exception. Two bits name the habits.
// eslint-disable-next-line no-control-regex
const PATH_MUST_ESCAPE = /[\u0000-\u0020"#<>?`{}\u007f]/;
// eslint-disable-next-line no-control-regex
const QUERY_MUST_ESCAPE = /[\u0000-\u0020"#<>'\u007f]/;

/** `count` exceptions among `places`: a bit for each and one to stop, then which place each is. */
const exceptions = (count: number, places: number) => 1 + count * (1 + Math.log2(places + 1));

function escapeBits(part: string, mustEscape: RegExp): number {
  let plain = 0;
  let needless = 0;
  let escaped = 0;
  let literal = 0;
  let lower = 0;
  let upper = 0;
  for (const [found, hex] of part.matchAll(/%([0-9A-Fa-f]{2})|[\s\S]/g)) {
    if (hex === undefined) {
      if (/[A-Za-z0-9\-._~]/.test(found)) plain++;
      else literal++;
      continue;
    }
    lower += hex.replace(/[^a-f]/g, "").length;
    upper += hex.replace(/[^A-F]/g, "").length;
    const byte = parseInt(hex, 16);
    const char = String.fromCharCode(byte);
    if (byte >= 0x80 || mustEscape.test(char)) continue;
    if (/[A-Za-z0-9\-._~]/.test(char)) needless++;
    else escaped++;
  }
  return 2 + exceptions(needless, plain + needless) + exceptions(Math.min(escaped, literal), escaped + literal) + exceptions(Math.min(lower, upper), lower + upper);
}

// Signed-URL parameters, by grammar: [name, what its value must look like, the most bits a value of that grammar can
// hold]. The shape is recognised by grammar, not by host. When every parameter of a shape is present once, under exactly
// these names, and well-formed, the shape is charged those bits instead of its text: the names and fixed values are no
// choice. Shapes whose signature is an RSA value (Google Cloud Storage V4, CloudFront) are not listed: they are charged
// as text.
type SignedField = readonly [name: string, grammar: RegExp, bits: number];
const SIGNED_HEADER = "(?:host|range|content-type|content-md5|x-amz-(?:date|content-sha256|security-token|checksum-mode|user-agent|acl))";
const REGION = "(?:auto|[a-z]{2}(?:-gov)?-(?:north|south|east|west|central|northeast|southeast|southwest|northwest)-\\d|[a-z]{3}\\d)";
const SIGNED_SHAPES: readonly (readonly SignedField[])[] = [
  [
    // AWS Signature V4: S3, R2, Spaces, MinIO.
    ["X-Amz-Algorithm", /^AWS4-HMAC-SHA256$/, 0],
    // a key id (129), a date (27) and a region (19)
    ["X-Amz-Credential", new RegExp(`^(?:[A-Z0-9]{16,20}|[0-9a-f]{32})/\\d{8}/${REGION}/s3/aws4_request$`), 175],
    ["X-Amz-Date", /^\d{8}T\d{6}Z$/, 47],
    ["X-Amz-Expires", /^\d{1,6}$/, 21],
    ["X-Amz-SignedHeaders", new RegExp(`^${SIGNED_HEADER}(?:;${SIGNED_HEADER}){0,5}$`), 21],
    ["X-Amz-Signature", /^[0-9a-f]{64}$/, 256],
  ],
  [
    // Azure Blob SAS.
    ["sv", /^\d{4}-\d{2}-\d{2}$/, 27],
    ["se", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?Z$/, 47],
    ["sr", /^[a-z]{1,2}$/, 10],
    ["sp", /^[a-z]{1,10}$/, 48],
    ["sig", /^[A-Za-z0-9+/]{43}=$/, 258],
  ],
];
// Parameters that travel with a signed URL; counted with a complete shape above.
const SIGNED_EXTRAS: readonly SignedField[] = [
  ["X-Amz-Content-Sha256", /^UNSIGNED-PAYLOAD$/, 0],
  ["x-id", /^GetObject$/, 0],
  ["st", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?Z$/, 47],
  ["spr", /^https(?:,http)?$/, 1],
];

/** The parameters (names and values percent-decoded once) that form a complete, well-formed signed-URL shape, and the
 * most bits their values can hold. */
export function signedShape(params: readonly (readonly [name: string, value: string])[]): { names: ReadonlySet<string>; bits: number } | undefined {
  const values = new Map<string, string>();
  const repeated = new Set<string>();
  for (const [name, value] of params) {
    if (values.has(name)) repeated.add(name);
    values.set(name, value);
  }
  const wellFormed = ([name, grammar]: SignedField) => !repeated.has(name) && values.has(name) && grammar.test(values.get(name)!);
  for (const shape of SIGNED_SHAPES) {
    if (!shape.every(wellFormed)) continue;
    const fields = [...shape, ...SIGNED_EXTRAS.filter(wellFormed)];
    return { names: new Set(fields.map(([name]) => name)), bits: fields.reduce((sum, [, , bits]) => sum + bits, 0) };
  }
  return undefined;
}

// Which signed shape it is and which of the parameters that travel with one are there.
const SHAPE_CHOICE = Math.ceil(Math.log2(SIGNED_SHAPES.length)) + SIGNED_EXTRAS.length;

/**
 * The room for data in one address, in bits (not rounded, no floor). `seen` holds the pieces of the addresses already
 * counted in the same reply; this address's pieces are added to it.
 */
export function addressBits(address: URL, seen: Set<string>): number {
  const userinfo = address.username || address.password ? `${address.username}:${address.password}@` : "";
  const origin = `//${userinfo}${address.hostname}${address.port ? `:${address.port}` : ""}`;
  // http or https, and whether a bare "?" ends the address: a bit each. A host the reply already sent to is one index; a
  // new one is spelled out. The path and the query are two texts, each with its own end, so where the query starts is
  // never in doubt.
  let bits = 2 + (seen.has(origin) ? KIND.seen + Math.log2(seen.size) : textBits(origin.slice(2), seen));
  seen.add(origin);
  bits += escapeBits(address.pathname, PATH_MUST_ESCAPE) + escapeBits(address.search.slice(1), QUERY_MUST_ESCAPE);

  // A signed shape is charged by its grammar, plus where each of its parameters sits among the others; the rest is text.
  let query = address.search.slice(1);
  const params = query.split("&").map((param) => {
    const eq = param.indexOf("=");
    return [decodeEscapes(eq < 0 ? param : param.slice(0, eq)), decodeEscapes(eq < 0 ? "" : param.slice(eq + 1)), param] as const;
  });
  const signed = signedShape(params.map(([name, value]) => [name, value] as const));
  if (signed) {
    bits += KIND.rare + SHAPE_CHOICE + signed.bits + signed.names.size * Math.log2(params.length + 1);
    query = params.filter(([name]) => !signed.names.has(name)).map(([, , param]) => param).join("&");
  }
  return bits + textBits(decodeEscapes(address.pathname), seen) + textBits(decodeEscapes(query), seen);
}
