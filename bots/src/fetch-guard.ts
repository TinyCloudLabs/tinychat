// Reads one web page for Main, from our own server, with no credentials: the only code in the bots service that dials an
// address a page or the model named. It runs in the key-less `bots-fetch` process (fetch-main.ts), never in the gateway.
//
// What it guarantees, in the order a request meets it:
//  - the address passes `readableAddress` (http or https, no user info, port 80 or 443, a real multi-label name);
//  - the name is resolved here, once per hop, and EVERY answer must be a public address (see blockedAddress);
//  - the connection is made to one of those checked addresses, never to the name again; TLS verifies the certificate
//    against the original name;
//  - each redirect (at most MAX_REDIRECTS) is run through all of the above again, and through the owner's site list;
//  - at most MAX_BODY_BYTES of body are read, only text-like types are accepted, one deadline covers the whole read.
// Nothing is sent but a GET with a fixed User-Agent: no cookie, no referer, no body, no credential.

import { readableAddress } from "./web";

export const MAX_REDIRECTS = 3;
export const MAX_BODY_BYTES = 1024 * 1024;
export const MAX_HEADER_BYTES = 16 * 1024;
export const TOTAL_MS = 20_000;
export const USER_AGENT = "TinyChatBot/1.0 (+https://tinycloud.xyz)";
const TEXT_TYPES = ["text/html", "application/xhtml+xml", "text/plain"];

/** One open connection to a checked address. */
export interface Conn {
  write(data: string): void;
  /** The response bytes, as they arrive; ends when the server closes. */
  read(): AsyncIterable<Uint8Array>;
  destroy(): void;
}

export interface GuardDeps {
  /** Every address the name resolves to. */
  lookup(host: string): Promise<string[]>;
  /** Connects to `ip` (already checked); `servername` is the original name, for TLS when `secure`. */
  connect(ip: string, port: number, secure: boolean, servername: string): Promise<Conn>;
}

export interface GuardLimits {
  maxRedirects: number;
  maxBodyBytes: number;
  maxHeaderBytes: number;
  totalMs: number;
}

export const LIMITS: GuardLimits = { maxRedirects: MAX_REDIRECTS, maxBodyBytes: MAX_BODY_BYTES, maxHeaderBytes: MAX_HEADER_BYTES, totalMs: TOTAL_MS };

export type PageFailure = "address" | "site" | "blocked" | "redirect" | "status" | "type" | "timeout" | "network" | "protocol";
export type PageResult =
  | { ok: true; url: URL; contentType: string; /** The header as sent, with its charset. */ declared: string; body: Uint8Array; truncated: boolean }
  | { ok: false; reason: PageFailure };

// --- addresses ---------------------------------------------------------------------------------------------------

function ipv4(text: string): number | undefined {
  const parts = text.split(".");
  if (parts.length !== 4) return undefined;
  let value = 0;
  for (const part of parts) {
    if (!/^[0-9]{1,3}$/.test(part) || Number(part) > 255) return undefined;
    value = value * 256 + Number(part);
  }
  return value;
}

/** [network, prefix length] pairs: everything an outside page has no business reaching, or that is not one site. */
const BLOCKED_V4: Array<[string, number]> = [
  ["0.0.0.0", 8], // this network
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // shared address space (CGNAT), which includes private overlay networks
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, including the cloud metadata address
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // documentation
  ["192.88.99.0", 24], // 6to4 relay
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // documentation
  ["203.0.113.0", 24], // documentation
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, and broadcast
];

function blockedV4(value: number): boolean {
  return BLOCKED_V4.some(([network, bits]) => {
    const base = ipv4(network)!;
    const size = 2 ** (32 - bits);
    return value >= base && value < base + size;
  });
}

/** Eight 16-bit groups of an IPv6 address, or undefined if it is not one. Accepts `::` and an embedded dotted IPv4. */
function ipv6(text: string): number[] | undefined {
  let rest = text.toLowerCase();
  const zone = rest.indexOf("%");
  if (zone >= 0) rest = rest.slice(0, zone);
  if (!rest.includes(":")) return undefined;
  const dotted = rest.lastIndexOf(".");
  if (dotted >= 0) {
    const cut = rest.lastIndexOf(":");
    const tail = ipv4(rest.slice(cut + 1));
    if (tail === undefined) return undefined;
    rest = `${rest.slice(0, cut + 1)}${((tail >>> 16) & 0xffff).toString(16)}:${(tail & 0xffff).toString(16)}`;
  }
  const halves = rest.split("::");
  if (halves.length > 2) return undefined;
  const parse = (part: string) => (part === "" ? [] : part.split(":"));
  const head = parse(halves[0]!);
  const tail = halves.length === 2 ? parse(halves[1]!) : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 1 ? head.length !== 8 : fill < 1) return undefined;
  const groups = [...head, ...Array<string>(halves.length === 2 ? fill : 0).fill("0"), ...tail];
  if (groups.length !== 8 || !groups.every(group => /^[0-9a-f]{1,4}$/.test(group))) return undefined;
  return groups.map(group => parseInt(group, 16));
}

function blockedV6(groups: number[]): boolean {
  const [a, b, c, d, e, f] = groups as [number, number, number, number, number, number, number, number];
  const embedded = (((groups[6]! << 16) | groups[7]!) >>> 0);
  // IPv4-mapped (::ffff:a.b.c.d): judged as the IPv4 address inside.
  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && f === 0xffff) return blockedV4(embedded);
  // Only global unicast, 2000::/3, can be a public site; everything else (loopback, unspecified, ULA fc00::/7,
  // link-local fe80::/10, site-local fec0::/10, multicast ff00::/8, IPv4-compatible ::/96, discard, ...) is refused.
  if ((a & 0xe000) !== 0x2000) return true;
  if (a === 0x2001 && b === 0x0db8) return true; // documentation
  if (a === 0x2001 && b === 0) return true; // Teredo
  if (a === 0x2002) return true; // 6to4: embeds an IPv4 address
  if (a === 0x2001 && b === 0x0002 && c === 0) return true; // benchmarking
  if (a === 0x2001 && b >= 0x0010 && b <= 0x002f) return true; // ORCHID and other IETF-reserved blocks
  return false;
}

/**
 * Whether `ip` (text, as a resolver returns it) must never be dialled. Anything that does not parse as an address is
 * refused, so a resolver's odd answer cannot slip through.
 */
export function blockedAddress(ip: string): boolean {
  const v4 = ipv4(ip);
  if (v4 !== undefined) return blockedV4(v4);
  const v6 = ipv6(ip);
  if (v6 !== undefined) return blockedV6(v6);
  return true;
}

// --- reading one response ----------------------------------------------------------------------------------------

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

const decode = new TextDecoder("latin1");

interface Head {
  status: number;
  headers: Map<string, string>;
}

function parseHead(raw: Uint8Array): Head | undefined {
  const lines = decode.decode(raw).split("\r\n");
  const status = /^HTTP\/1\.[01] ([0-9]{3})(?: |$)/.exec(lines[0] ?? "");
  if (!status) return undefined;
  const headers = new Map<string, string>();
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(":");
    if (colon <= 0) return undefined;
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    headers.set(name, headers.has(name) ? `${headers.get(name)}, ${value}` : value);
  }
  return { status: Number(status[1]), headers };
}

const TIMED_OUT = Symbol("timed out");

function concat(parts: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** Decodes a chunked body incrementally; `feed` returns false when the body has ended. Bytes beyond `cap` are dropped. */
class Chunked {
  #buffer = new Uint8Array(0);
  #remaining = -1; // -1: expecting a size line
  #trailer = false;
  done = false;
  bad = false;
  readonly parts: Uint8Array[] = [];
  bytes = 0;
  truncated = false;
  readonly #cap: number;

  constructor(cap: number) {
    this.#cap = cap;
  }

  feed(chunk: Uint8Array): void {
    const joined = new Uint8Array(this.#buffer.length + chunk.length);
    joined.set(this.#buffer);
    joined.set(chunk, this.#buffer.length);
    this.#buffer = joined;
    while (!this.done && !this.bad) {
      if (this.#trailer) {
        const end = indexOf(this.#buffer, "\r\n");
        if (end < 0) return this.#limit();
        const line = end === 0;
        this.#buffer = this.#buffer.subarray(end + 2);
        if (line) this.done = true;
      } else if (this.#remaining === -1) {
        const end = indexOf(this.#buffer, "\r\n");
        if (end < 0) return this.#limit();
        const size = /^([0-9a-fA-F]{1,8})(?:;.*)?$/.exec(decode.decode(this.#buffer.subarray(0, end)).trim());
        if (!size) {
          this.bad = true;
          return;
        }
        this.#remaining = parseInt(size[1]!, 16);
        this.#buffer = this.#buffer.subarray(end + 2);
        if (this.#remaining === 0) this.#trailer = true;
      } else {
        if (this.#buffer.length < this.#remaining + 2) {
          // Take what is here of this chunk's data; its closing CRLF comes with the rest.
          const take = Math.min(this.#buffer.length, this.#remaining);
          this.#take(this.#buffer.subarray(0, take));
          this.#remaining -= take;
          this.#buffer = this.#buffer.subarray(take);
          return;
        }
        this.#take(this.#buffer.subarray(0, this.#remaining));
        if (this.#buffer[this.#remaining] !== 13 || this.#buffer[this.#remaining + 1] !== 10) {
          this.bad = true;
          return;
        }
        this.#buffer = this.#buffer.subarray(this.#remaining + 2);
        this.#remaining = -1;
      }
      if (this.truncated) return;
    }
  }

  #limit(): void {
    if (this.#buffer.length > 4096) this.bad = true; // a size line or trailer that long is not honest
  }

  #take(data: Uint8Array): void {
    const room = this.#cap - this.bytes;
    if (data.length > room) this.truncated = true;
    const kept = data.subarray(0, Math.max(0, room));
    if (kept.length > 0) {
      this.parts.push(kept.slice());
      this.bytes += kept.length;
    }
  }
}

function indexOf(haystack: Uint8Array, needle: string): number {
  for (let i = 0; i + needle.length <= haystack.length; i++) {
    let match = true;
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle.charCodeAt(j)) {
        match = false;
        break;
      }
    }
    if (match) return i;
  }
  return -1;
}

// --- the fetch ---------------------------------------------------------------------------------------------------

export interface OneHop {
  head: Head;
  body: Uint8Array;
  truncated: boolean;
}

/** One request to one checked address; a failure is a PageFailure. The deadline covers connecting and reading. */
async function hop(conn: Conn, url: URL, limits: GuardLimits, until: Promise<typeof TIMED_OUT>): Promise<OneHop | PageFailure> {
  conn.write(
    `GET ${url.pathname}${url.search} HTTP/1.1\r\nHost: ${url.host}\r\nUser-Agent: ${USER_AGENT}\r\n` +
      `Accept: text/html,application/xhtml+xml,text/plain;q=0.9\r\nAccept-Encoding: identity\r\nConnection: close\r\n\r\n`,
  );
  const iterator = conn.read()[Symbol.asyncIterator]();
  let pending = new Uint8Array(0);
  let head: Head | undefined;
  let chunked: Chunked | undefined;
  let length = -1;
  const parts: Uint8Array[] = [];
  let bytes = 0;
  let truncated = false;
  for (;;) {
    const step = await Promise.race([iterator.next(), until]);
    if (step === TIMED_OUT) return "timeout";
    if (step.done) break;
    const piece = step.value;
    if (!head) {
      const joined = new Uint8Array(pending.length + piece.length);
      joined.set(pending);
      joined.set(piece, pending.length);
      const end = indexOf(joined, "\r\n\r\n");
      if (end < 0) {
        if (joined.length > limits.maxHeaderBytes) return "protocol";
        pending = joined;
        continue;
      }
      if (end > limits.maxHeaderBytes) return "protocol";
      head = parseHead(joined.subarray(0, end));
      if (!head) return "protocol";
      const encoding = head.headers.get("content-encoding");
      const transfer = head.headers.get("transfer-encoding")?.toLowerCase();
      if (encoding && encoding.toLowerCase() !== "identity") return "type";
      if (transfer && transfer !== "chunked") return "protocol";
      if (REDIRECTS.has(head.status) || head.status !== 200) return { head, body: new Uint8Array(0), truncated: false };
      if (transfer === "chunked") chunked = new Chunked(limits.maxBodyBytes);
      else if (head.headers.has("content-length")) {
        const declared = head.headers.get("content-length")!;
        if (!/^[0-9]{1,12}$/.test(declared)) return "protocol";
        length = Number(declared);
      }
      const first = joined.subarray(end + 4);
      if (!feedBody(first)) break;
      continue;
    }
    if (!feedBody(piece)) break;
  }
  conn.destroy();
  if (!head) return "protocol";
  if (chunked) {
    if (chunked.bad) return "protocol";
    return { head, body: concat(chunked.parts, chunked.bytes), truncated: chunked.truncated || !chunked.done };
  }
  return { head, body: concat(parts, bytes), truncated };

  /** Adds body bytes; false when nothing more is wanted (cap reached, length reached, or a bad chunk). */
  function feedBody(data: Uint8Array): boolean {
    if (chunked) {
      chunked.feed(data);
      return !chunked.done && !chunked.bad && !chunked.truncated;
    }
    const room = limits.maxBodyBytes - bytes;
    const wanted = length >= 0 ? Math.min(room, length - bytes) : room;
    if (data.length > wanted) {
      parts.push(data.slice(0, Math.max(0, wanted)));
      bytes += Math.max(0, wanted);
      truncated = bytes >= limits.maxBodyBytes && (length < 0 || length > bytes);
      return false;
    }
    parts.push(data.slice());
    bytes += data.length;
    return !(length >= 0 && bytes >= length);
  }
}

function mediaType(value: string | undefined): string {
  return (value ?? "").split(";")[0]!.trim().toLowerCase();
}

/**
 * Reads `raw` as plain bytes. `allowed` is the owner's site list (null: any public site); it is asked about the first
 * address and about every redirect target. Never throws: a failure is a short reason, which the caller turns into one
 * fixed sentence for the model.
 */
export async function fetchGuarded(raw: string, allowed: ((host: string) => boolean) | null, deps: GuardDeps, limits: GuardLimits = LIMITS): Promise<PageResult> {
  const deadline = Promise.withResolvers<typeof TIMED_OUT>();
  const timer = setTimeout(() => deadline.resolve(TIMED_OUT), limits.totalMs);
  const until = deadline.promise;
  let current: Conn | undefined;
  try {
    let url = readableAddress(raw);
    if (!url) return { ok: false, reason: "address" };
    for (let redirects = 0; ; redirects++) {
      if (allowed && !allowed(url.hostname)) return { ok: false, reason: "site" };
      const answers = await Promise.race([deps.lookup(url.hostname).catch(() => undefined), until]);
      if (answers === TIMED_OUT) return { ok: false, reason: "timeout" };
      if (!answers || answers.length === 0) return { ok: false, reason: "network" };
      // Every answer, not the first: a name with one public and one internal address is refused outright.
      if (answers.some(blockedAddress)) return { ok: false, reason: "blocked" };
      const secure = url.protocol === "https:";
      const port = secure ? 443 : 80;
      const pending = deps.connect(answers[0]!, port, secure, url.hostname).catch(() => undefined);
      const opened = await Promise.race([pending, until]);
      if (opened === TIMED_OUT) {
        // A connection that opens after the deadline is closed, so a slow server cannot pin sockets.
        void pending.then(late => late?.destroy());
        return { ok: false, reason: "timeout" };
      }
      if (!opened) return { ok: false, reason: "network" };
      current = opened;
      const result = await hop(opened, url, limits, until).catch((): PageFailure => "network");
      opened.destroy();
      current = undefined;
      if (typeof result === "string") return { ok: false, reason: result };
      const { head } = result;
      if (REDIRECTS.has(head.status)) {
        if (redirects >= limits.maxRedirects) return { ok: false, reason: "redirect" };
        const location = head.headers.get("location");
        if (!location || location.length > 2048) return { ok: false, reason: "redirect" };
        let next: URL;
        try {
          next = new URL(location, url);
        } catch {
          return { ok: false, reason: "redirect" };
        }
        // The same checks as the first address, so a redirect cannot reach what a typed address could not.
        const readable = readableAddress(next.href);
        if (!readable) return { ok: false, reason: "address" };
        url = readable;
        continue;
      }
      if (head.status !== 200) return { ok: false, reason: "status" };
      const type = mediaType(head.headers.get("content-type"));
      if (!TEXT_TYPES.includes(type)) return { ok: false, reason: "type" };
      url.hash = "";
      return { ok: true, url, contentType: type, declared: head.headers.get("content-type") ?? "", body: result.body, truncated: result.truncated };
    }
  } finally {
    clearTimeout(timer);
    current?.destroy();
  }
}
