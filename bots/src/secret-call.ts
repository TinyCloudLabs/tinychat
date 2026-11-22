// call_with_secret: one HTTPS call, made by the gateway, to a site the owner approved for one secret. The value never
// enters the sandbox: Main writes {{secret}} where it goes, the gateway puts the value in and hides it in the reply.
//
// Rules, in the order a call meets them (each refusal is one fixed sentence; nothing the site sent is ever quoted):
//  - the address is https on port 443, no user info, a real name (no IP literal), exactly one of the approved sites;
//  - {{secret}} appears only in the header the secret's service uses (KNOWN_SECRETS' `header`), never in the address,
//    the body, a header name or another header (Naomi's ruling on Bobbie's review, 22 Nov);
//  - headers are plain: no line breaks, none of the hop-by-hop or framing headers, which the gateway sets itself;
//  - the name is resolved once and EVERY answer must be public (fetch-guard's blockedAddress); the connection goes to
//    a checked address and TLS verifies the certificate against the site's name;
//  - a redirect is never followed: Main gets its status and nothing else;
//  - the reply is read up to MAX_REPLY_BYTES under one deadline (CALL_MS), compressed replies are refused, then the
//    value is hidden (secret-redact.ts) before anything is cut to MAX_REPLY_CHARS.

import { blockedAddress, exchange, type GuardDeps, type PageFailure, TIMED_OUT, USER_AGENT } from "./fetch-guard";
import { isRecord } from "./guards";
import { redactor, redactThenTruncate } from "./secret-redact";
import { readableAddress, toolText } from "./web";

export const PLACEHOLDER = "{{secret}}";
export const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
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
/** Calls one approved secret may make per UTC day ("the gateway also caps calls a day per secret"). */
export const DAILY_CALLS_PER_SECRET = 200;

/** Set by the gateway, never by Main. */
const RESERVED_HEADERS = new Set([
  "host", "content-length", "transfer-encoding", "connection", "keep-alive", "upgrade", "te", "trailer", "expect",
  "accept-encoding", "proxy-authorization", "proxy-connection", "user-agent",
]);
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/;
const TEXT_TYPE = /^(text\/[a-z0-9.+-]+|application\/([a-z0-9.+-]+\+)?(json|xml)|application\/x-www-form-urlencoded|application\/x-ndjson)$/;

/** What Main is told, word for word. `{NAME}`, `{SITES}`, `{HEADER}`, `{DATE}`, `{HOST}` are filled in from our own records. */
export const SECRET_CALL_ERRORS = {
  notAsked: "You can't use {NAME}. Ask for it with request_secret.",
  pending: "The owner hasn't approved {NAME} yet.",
  ended: "Your access to {NAME} ended on {DATE} UTC. If you still need it, ask again with request_secret.",
  site: "{NAME} is approved only for {SITES}.",
  placeholder: "Put {{secret}} in the {HEADER} header, where the value goes. It can't go in the address, the body or another header.",
  invalid: "That call can't be made: use an https address on an approved site, one of GET, POST, PUT, PATCH or DELETE, and plain headers.",
  missing: "{NAME} isn't in the owner's TinyCloud Secrets. The request card shows them how to add it.",
  daily: "Today's limit for calls with {NAME} is used up.",
  busy: "Another call with a secret is still running. Try again when it ends.",
  unavailable: "{NAME} can't be used right now. Try again later.",
  failed: "The call to {HOST} failed: {REASON}.",
} as const;
export type SecretCallError = keyof typeof SECRET_CALL_ERRORS;

export type CallFailure = "timeout" | "could not connect" | "reply too large" | "could not read the reply";

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

export function utcMinute(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16).replace("T", " ");
}

export function sentence(error: SecretCallError, fill: { name?: string; sites?: string[]; header?: string; until?: number; host?: string; reason?: CallFailure } = {}): string {
  return SECRET_CALL_ERRORS[error]
    .replaceAll("{NAME}", fill.name ?? "")
    .replaceAll("{SITES}", (fill.sites ?? []).join(", "))
    .replaceAll("{HEADER}", fill.header ?? "")
    .replaceAll("{DATE}", fill.until === undefined ? "" : utcMinute(fill.until))
    .replaceAll("{HOST}", fill.host ?? "")
    .replaceAll("{REASON}", fill.reason ?? "");
}

export const refusal = (error: SecretCallError, fill: Parameters<typeof sentence>[1] = {}) => toolText(sentence(error, fill), true);

/** The name Main gave, if it is a secret name at all. */
export function secretName(args: Record<string, unknown>): string | undefined {
  return typeof args.name === "string" && SECRET_NAME.test(args.name) ? args.name : undefined;
}

const mentionsPlaceholder = (text: string) => text.includes(PLACEHOLDER) || decodeLoosely(text).includes(PLACEHOLDER);

function decodeLoosely(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** Checks Main's arguments against the approved secret. Returns the call, or the refusal to send back. */
export function prepareCall(args: Record<string, unknown>, secret: ApprovedSecret): PreparedCall | { refused: SecretCallError } {
  const allowed = new Set(["name", "method", "url", "headers", "body"]);
  if (Object.keys(args).some(key => !allowed.has(key))) return { refused: "invalid" };
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
    const seen = new Set<string>();
    for (const [name, value] of entries) {
      if (mentionsPlaceholder(name)) return { refused: "placeholder" };
      const lower = name.toLowerCase();
      if (!HEADER_NAME.test(name) || RESERVED_HEADERS.has(lower) || seen.has(lower)) return { refused: "invalid" };
      if (typeof value !== "string" || value.length > MAX_HEADER_VALUE_CHARS || /[\r\n\0]/.test(value)) return { refused: "invalid" };
      seen.add(lower);
      if (value.includes(PLACEHOLDER) || mentionsPlaceholder(value)) {
        // Only in the service's own header, and written plainly there exactly once.
        if (lower !== secret.header || value.split(PLACEHOLDER).length !== 2) return { refused: "placeholder" };
        placed = true;
      }
      headers.push([name, value]);
    }
  }
  if (!placed) return { refused: "placeholder" };
  return { secret, method: method as Method, url, headers, body };
}

export type CallResult =
  | { ok: true; text: string }
  | { ok: false; reason: CallFailure | "value" };

function failureOf(reason: PageFailure): CallFailure {
  if (reason === "timeout") return "timeout";
  if (reason === "type" || reason === "protocol") return "could not read the reply";
  return "could not connect";
}

/**
 * Makes the call with the value in place and returns the reply as tool text: `{status, contentType, body, truncated}`
 * with the value hidden everywhere it is returned. Never throws.
 */
export async function sendCall(call: PreparedCall, value: string, deps: GuardDeps, limits = { totalMs: CALL_MS, maxBodyBytes: MAX_REPLY_BYTES }): Promise<CallResult> {
  // A value that could break the request's framing is never sent.
  if (value === "" || /[\r\n\0]/.test(value)) return { ok: false, reason: "value" };
  const hide = redactor(value);
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
    if (answers === TIMED_OUT) return { ok: false, reason: "timeout" };
    // Every answer must be public, as for pages: a name with one internal address is refused outright.
    if (!answers || answers.length === 0 || answers.some(blockedAddress)) return { ok: false, reason: "could not connect" };
    const pending = deps.connect(answers[0]!, 443, true, host).catch(() => undefined);
    const opened = await Promise.race([pending, deadline.promise]);
    if (opened === TIMED_OUT) {
      void pending.then(late => late?.destroy());
      return { ok: false, reason: "timeout" };
    }
    if (!opened) return { ok: false, reason: "could not connect" };
    open = opened;
    const result = await exchange(
      opened, request, { maxRedirects: 0, maxBodyBytes: limits.maxBodyBytes, maxHeaderBytes: 16 * 1024, totalMs: limits.totalMs }, deadline.promise,
      status => status < 300 || status >= 400,
    ).catch((): PageFailure => "network");
    if (typeof result === "string") return { ok: false, reason: failureOf(result) };
    if (result.truncated) return { ok: false, reason: "reply too large" };
    const status = result.head.status;
    const contentType = result.head.headers.get("content-type") ?? "";
    const media = contentType.split(";")[0]!.trim().toLowerCase();
    const text = TEXT_TYPE.test(media) ? new TextDecoder().decode(result.body) : "";
    const shown = redactThenTruncate(text, hide, MAX_REPLY_CHARS, false);
    return {
      ok: true,
      text: JSON.stringify({ status, contentType: hide.redact(contentType).slice(0, 200), body: shown.text, truncated: shown.truncated }),
    };
  } finally {
    clearTimeout(timer);
    open?.destroy();
  }
}
