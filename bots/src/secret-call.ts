// call_with_secret: one HTTPS call, made by the gateway, to a site the owner approved for one secret. The value never
// enters the sandbox: Main writes {{secret}} where it goes, the gateway puts the value in and hides it in the reply.
//
// Rules, in the order a call meets them (each refusal is one fixed sentence; nothing the site sent is ever quoted):
//  - the address is https on port 443, no user info, a real name (no IP literal), exactly one of the approved sites;
//  - {{secret}} appears only in the secret's own header (KNOWN_SECRETS' header for a known service, the one the
//    supervisor sent otherwise), never in the address, the body, a header name or another header (Naomi's ruling on
//    Bobbie's review, 22 Nov);
//  - headers are plain: no line breaks, none of the hop-by-hop or framing headers, which the gateway sets itself;
//  - the name is resolved once and EVERY answer must be public (fetch-guard's blockedAddress); the connection goes to
//    a checked address and TLS verifies the certificate against the site's name;
//  - a redirect is never followed: Main is told where it pointed, with the value hidden;
//  - the reply is read up to MAX_REPLY_BYTES under one deadline (CALL_MS), compressed replies are refused, then the
//    value is hidden (secret-redact.ts) before anything is cut to MAX_REPLY_CHARS.

import { utcMinute } from "./asks";
import { blockedAddress, exchange, type GuardDeps, type PageFailure, TIMED_OUT, USER_AGENT } from "./fetch-guard";
import { isRecord } from "./guards";
import { joinSites, knownSecret, SECRET_NAME } from "./secret-catalog";
import { redactor, redactThenTruncate } from "./secret-redact";
import { readableAddress, toolText } from "./web";

export const PLACEHOLDER = "{{secret}}";
export const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export type Method = (typeof METHODS)[number];
/** The request body Main may send (the design's `body.maxLength`). */
export const MAX_REQUEST_BODY_CHARS = 1024 * 1024;
const MAX_HEADERS = 32;
const MAX_HEADER_VALUE_CHARS = 8 * 1024;
/** A reply bigger than this is refused as too large rather than cut, so no cut can split the value. */
export const MAX_REPLY_BYTES = 1024 * 1024;
/** Reply text handed to Main is cut here, after the value is hidden. */
export const MAX_REPLY_CHARS = 100_000;
/** Inside the sandbox's 60 s MCP timeout, so the gateway's answer is the one Main gets. */
export const CALL_MS = 45_000;
/** Per approved secret and UTC day: calls made, and reply bytes read ("per-secret daily call and byte caps"). */
export const DAILY_CALLS_PER_SECRET = 200;
export const DAILY_REPLY_BYTES_PER_SECRET = 50 * 1024 * 1024;
const MAX_LOCATION_CHARS = 300;

/** The two tools on the app server that use approved secrets (design section 03). */
export const SECRET_TOOLS = [
  {
    name: "call_with_secret",
    description:
      "Make one HTTPS call to a site the owner approved for this secret. Put {{secret}} only in a header, like Authorization: Bearer {{secret}}; " +
      "for a known service, only in the header that service uses. It is refused in the address or the body. Redirects are returned, not followed. " +
      "The reply comes back with the value replaced by [hidden].",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["name", "method", "url"],
      properties: {
        name: { type: "string" },
        method: { enum: METHODS },
        url: { type: "string" },
        headers: { type: "object", additionalProperties: { type: "string" } },
        body: { type: "string", maxLength: MAX_REQUEST_BODY_CHARS },
      },
    },
  },
  {
    name: "list_secrets",
    description: "The secrets you asked for, with their state, sites and when access ends. Never values.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
  },
] as const;

/** Set by the gateway, never by Main. */
const RESERVED_HEADERS: Record<string, true> = {
  host: true, "content-length": true, "transfer-encoding": true, connection: true, "keep-alive": true, upgrade: true, te: true, trailer: true,
  expect: true, "accept-encoding": true, "proxy-authorization": true, "proxy-connection": true, "user-agent": true,
};
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/;
const TEXT_TYPE = /^(text\/[a-z0-9.+-]+|application\/([a-z0-9.+-]+\+)?(json|xml)|application\/x-www-form-urlencoded|application\/x-ndjson)$/;

/**
 * What Main is told, word for word (design section 03; the last four are the gateway's own limits). `{NAME}`,
 * `{SITES}`, `{EXAMPLE}`, `{DATE}`, `{HOST}`, `{ADDRESS}`, `{REASON}` are filled in from our own records; `{ADDRESS}`
 * is the redirect's target with the value hidden.
 */
export const SECRET_CALL_ERRORS = {
  notAsked: "You can’t use {NAME}. Ask for it with request_secret.",
  pending: "The owner hasn’t approved {NAME} yet.",
  ended: "Your access to {NAME} ended on {DATE}. If you still need it, ask again with request_secret.",
  site: "{NAME} is approved only for {SITES}.",
  noPlaceholder: "Put {{secret}} in a header, like {EXAMPLE}.",
  placeholder: "{{secret}} can only go in a header. For {NAME} use {EXAMPLE}.",
  redirect: "{HOST} answered with a redirect to {ADDRESS}. It wasn’t followed; the secret is only sent to approved sites.",
  missing: "{NAME} isn’t in the owner’s TinyCloud Secrets. The request card shows them how to add it.",
  failed: "The call to {HOST} failed: {REASON}.",
  invalid: "That call can’t be made: use an https address on an approved site, one of GET, POST, PUT, PATCH or DELETE, and plain headers.",
  daily: "Today’s limit for calls with {NAME} is used up.",
  busy: "Another call with a secret is still running. Try again when it ends.",
  unavailable: "{NAME} can’t be used right now. Try again later.",
} as const;
export type SecretCallError = keyof typeof SECRET_CALL_ERRORS;

export type CallFailure = "timeout" | "could not connect" | "reply too large";

/** The gateway's own record of an approved secret; Main's arguments never change it. */
export interface ApprovedSecret {
  name: string;
  /** Lower-case host names, no port. */
  sites: string[];
  /** Lower-case header name the value may go in. */
  header: string;
  /** Epoch ms the owner's approval ends. */
  until: number;
}

/** A call that passed every check that needs no value and no network. */
export interface PreparedCall {
  secret: ApprovedSecret;
  method: Method;
  url: URL;
  headers: Array<[string, string]>;
  body: string | undefined;
}

export interface SentenceFill {
  name?: string;
  sites?: string[];
  header?: string;
  until?: number;
  host?: string;
  address?: string;
  reason?: CallFailure;
}

/** How Main should write the header: `Authorization: Bearer {{secret}}`, `X-Api-Key: {{secret}}`. */
export function headerExample(name: string, header: string): string {
  const shown = header.split("-").map(part => part.charAt(0).toUpperCase() + part.slice(1)).join("-");
  const prefix = knownSecret(name)?.header.prefix ?? (header === "authorization" ? "Bearer " : "");
  return `${shown}: ${prefix}${PLACEHOLDER}`;
}

export function sentence(error: SecretCallError, fill: SentenceFill = {}): string {
  return SECRET_CALL_ERRORS[error]
    .replaceAll("{NAME}", fill.name ?? "")
    .replaceAll("{SITES}", joinSites(fill.sites ?? []))
    .replaceAll("{EXAMPLE}", headerExample(fill.name ?? "", fill.header ?? "authorization"))
    .replaceAll("{DATE}", fill.until === undefined ? "" : utcMinute(fill.until))
    .replaceAll("{HOST}", fill.host ?? "")
    .replaceAll("{ADDRESS}", fill.address ?? "")
    .replaceAll("{REASON}", fill.reason ?? "");
}

export const refusal = (error: SecretCallError, fill: SentenceFill = {}) => toolText(sentence(error, fill), true);

/** The name Main gave, if it is a secret name at all. */
export function secretName(args: Record<string, unknown>): string | undefined {
  return typeof args.name === "string" && SECRET_NAME.test(args.name) ? args.name : undefined;
}

/** True when the text holds the placeholder as written or percent-encoded. */
function mentionsPlaceholder(text: string): boolean {
  if (text.includes(PLACEHOLDER)) return true;
  try {
    return decodeURIComponent(text).includes(PLACEHOLDER);
  } catch {
    return false;
  }
}

/** Checks Main's arguments against the approved secret. Returns the call, or the refusal to send back. */
export function prepareCall(args: Record<string, unknown>, secret: ApprovedSecret): PreparedCall | { refused: SecretCallError } {
  if (Object.keys(args).some(key => !["name", "method", "url", "headers", "body"].includes(key))) return { refused: "invalid" };
  const method = args.method;
  if (typeof method !== "string" || !(METHODS as readonly string[]).includes(method)) return { refused: "invalid" };
  if (typeof args.url !== "string") return { refused: "invalid" };
  if (mentionsPlaceholder(args.url)) return { refused: "placeholder" };
  const url = readableAddress(args.url);
  if (!url || url.protocol !== "https:") return { refused: "invalid" };
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!secret.sites.includes(host)) return { refused: "site" };
  url.hash = "";

  let body: string | undefined;
  if (args.body !== undefined) {
    if (typeof args.body !== "string" || args.body.length > MAX_REQUEST_BODY_CHARS) return { refused: "invalid" };
    if (mentionsPlaceholder(args.body)) return { refused: "placeholder" };
    body = args.body;
  }

  const headers: Array<[string, string]> = [];
  let placed = false;
  if (args.headers !== undefined) {
    if (!isRecord(args.headers)) return { refused: "invalid" };
    const entries = Object.entries(args.headers);
    if (entries.length > MAX_HEADERS) return { refused: "invalid" };
    const seen: Record<string, true> = {};
    for (const [name, value] of entries) {
      if (mentionsPlaceholder(name)) return { refused: "placeholder" };
      const lower = name.toLowerCase();
      if (!HEADER_NAME.test(name) || RESERVED_HEADERS[lower] || seen[lower]) return { refused: "invalid" };
      if (typeof value !== "string" || value.length > MAX_HEADER_VALUE_CHARS || /[\r\n\0]/.test(value)) return { refused: "invalid" };
      seen[lower] = true;
      if (mentionsPlaceholder(value)) {
        // Only in the secret's own header, and written plainly there exactly once.
        if (lower !== secret.header || value.split(PLACEHOLDER).length !== 2) return { refused: "placeholder" };
        placed = true;
      }
      headers.push([name, value]);
    }
  }
  if (!placed) return { refused: "noPlaceholder" };
  return { secret, method: method as Method, url, headers, body };
}

export type CallResult =
  | { ok: true; text: string; bytes: number }
  | { ok: false; reason: CallFailure; bytes: number }
  | { ok: false; reason: "redirect"; address: string; bytes: number }
  /** The stored value can't be sent as a header (empty, or a line break in it). */
  | { ok: false; reason: "value"; bytes: number };

function failureOf(reason: PageFailure): CallFailure {
  return reason === "timeout" ? "timeout" : "could not connect";
}

/**
 * Makes the call with the value in place. On success the reply is tool text `{status, contentType, body, truncated}`
 * with the value hidden everywhere it is returned; `bytes` is the reply body read. Never throws.
 */
export async function sendCall(call: PreparedCall, value: string, deps: GuardDeps, limits = { totalMs: CALL_MS, maxBodyBytes: MAX_REPLY_BYTES }): Promise<CallResult> {
  // A value that could break the request's framing is never sent.
  if (value === "" || /[\r\n\0]/.test(value)) return { ok: false, reason: "value", bytes: 0 };
  const hide = redactor(value);
  // Reply headers are read byte for byte as Latin-1 (fetch-guard), so a non-ASCII value shows there in that spelling.
  const hideHead = redactor(new TextDecoder("latin1").decode(new TextEncoder().encode(value)));
  const headerText = (text: string) => hideHead.redact(hide.redact(text));
  const host = call.url.hostname.toLowerCase().replace(/\.$/, "");
  const lines = [`${call.method} ${call.url.pathname}${call.url.search} HTTP/1.1`, `Host: ${host}`, `User-Agent: ${USER_AGENT}`, "Accept-Encoding: identity", "Connection: close"];
  for (const [name, template] of call.headers) lines.push(`${name}: ${template.replace(PLACEHOLDER, () => value)}`);
  const body = call.body ?? "";
  if (call.body !== undefined || call.method === "POST" || call.method === "PUT" || call.method === "PATCH") {
    lines.push(`Content-Length: ${Buffer.byteLength(body)}`);
  }
  const request = `${lines.join("\r\n")}\r\n\r\n${body}`;

  const deadline = Promise.withResolvers<typeof TIMED_OUT>();
  const timer = setTimeout(() => deadline.resolve(TIMED_OUT), limits.totalMs);
  let open: { destroy(): void } | undefined;
  try {
    const answers = await Promise.race([deps.lookup(host).catch(() => undefined), deadline.promise]);
    if (answers === TIMED_OUT) return { ok: false, reason: "timeout", bytes: 0 };
    // Every answer must be public, as for pages: a name with one internal address is refused outright.
    if (!answers || answers.length === 0 || answers.some(blockedAddress)) return { ok: false, reason: "could not connect", bytes: 0 };
    const pending = deps.connect(answers[0]!, 443, true, host).catch(() => undefined);
    const opened = await Promise.race([pending, deadline.promise]);
    if (opened === TIMED_OUT) {
      void pending.then(late => late?.destroy());
      return { ok: false, reason: "timeout", bytes: 0 };
    }
    if (!opened) return { ok: false, reason: "could not connect", bytes: 0 };
    open = opened;
    const isRedirect = (status: number) => status >= 300 && status < 400;
    const result = await exchange(
      opened, request, { maxRedirects: 0, maxBodyBytes: limits.maxBodyBytes, maxHeaderBytes: 16 * 1024, totalMs: limits.totalMs }, deadline.promise,
      status => !isRedirect(status),
    ).catch((): PageFailure => "network");
    if (typeof result === "string") return { ok: false, reason: failureOf(result), bytes: 0 };
    const bytes = result.body.length;
    if (result.truncated) return { ok: false, reason: "reply too large", bytes };
    const status = result.head.status;
    if (isRedirect(status)) {
      const address = headerText(result.head.headers.get("location") ?? "").replace(/[\0-\x1f\x7f]/g, "").slice(0, MAX_LOCATION_CHARS);
      return { ok: false, reason: "redirect", address: address || "another address", bytes };
    }
    const contentType = result.head.headers.get("content-type") ?? "";
    const media = contentType.split(";")[0]!.trim().toLowerCase();
    const text = TEXT_TYPE.test(media) ? new TextDecoder().decode(result.body) : "";
    const shown = redactThenTruncate(text, hide, MAX_REPLY_CHARS, false);
    return {
      ok: true,
      bytes,
      text: JSON.stringify({ status, contentType: headerText(contentType).slice(0, 200), body: shown.text, truncated: shown.truncated }),
    };
  } finally {
    clearTimeout(timer);
    open?.destroy();
  }
}
