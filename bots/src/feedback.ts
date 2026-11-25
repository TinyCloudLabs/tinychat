// Main's feedback to the TinyCloud team (`propose_action` with kind `send_feedback`). The gateway builds the exact
// report body once, when Main proposes it; the owner's card shows that body field by field and the binding covers
// its bytes. After the owner's tap the gateway checks the body again, spends the approval and makes one POST to the
// pinned feedback origin. Nothing identifies the owner: `agent` is a fixed name and `area` is always "other". Fields
// that look like a secret or a personal identifier are refused, never rewritten, so the card is always what is sent.
// The reply's attach token is never kept; only a report id of the service's ULID form is.

import { plainMessage } from "./actions";
import { isRecord } from "./guards";
import { MAIN_BOT_NAME } from "./owner";

export const FEEDBACK_TYPES = ["bug", "friction", "improvement"] as const;
export type FeedbackType = (typeof FEEDBACK_TYPES)[number];
/** The fixed `agent` value: what the team sees of the sender. */
export const FEEDBACK_AGENT = `TinyCloud One bot (${MAIN_BOT_NAME})`;
export const FEEDBACK_AREA = "other";
export const MAX_FEEDBACK_TITLE = 120;
export const MAX_FEEDBACK_FIELD = 800;
/** Half the service's 16 KB cap. */
export const MAX_FEEDBACK_BYTES = 8 * 1024;
/** Per owner: one open feedback proposal, one per 10 minutes, three per UTC day. */
export const MAX_OPEN_FEEDBACK = 1;
export const FEEDBACK_GAP_MS = 10 * 60_000;
export const MAX_FEEDBACK_PER_DAY = 3;
/** Across all bots: kept below the service's 10 a minute per client, since the bots likely share one address. */
export const MAX_FEEDBACK_POSTS_PER_MINUTE = 5;
export const FEEDBACK_TIMEOUT_MS = 15_000;
const MAX_REPLY_BYTES = 4 * 1024;
const FEEDBACK_USER_AGENT = "tinycloud-bots-feedback/1";
/** The service's report ids (ULID). Any other id is dropped. */
const REPORT_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const ERROR_CODE = /^[a-z_]{1,64}$/;

/** What became of one send. `refused`: the gateway would not send it (held, spent, changed or over the global cap is `busy`). */
export const FEEDBACK_OUTCOMES = ["filed", "rate_limited", "busy", "rejected", "unknown", "refused"] as const;
export type FeedbackOutcome = (typeof FEEDBACK_OUTCOMES)[number];

export interface FeedbackSent {
  outcome: FeedbackOutcome;
  /** Only for `filed`, and only of the ULID form. */
  reportId?: string;
  /** Only for `rejected`, and only of the form `^[a-z_]{1,64}$`. */
  code?: string;
}

/** Fixed sentences for the model when a feedback proposal is refused. */
export const FEEDBACK_ERRORS = {
  secret: "Refused: a field looks like it holds a secret or a personal identifier (an email, key, token, address or home path). Replace each with a placeholder such as <token> or <email> and propose the report with those.",
  security: "Refused: security reports can't be sent from here. Tell the owner to report it through their own channel to the TinyCloud team.",
  gap: "Refused: one feedback report per 10 minutes. Wait before proposing another.",
  daily: "Refused: three feedback reports a day is the limit. Try tomorrow.",
  held: "Refused: this chat holds the owner's private data, so feedback can't be sent from it.",
  ownerTurn: "Refused: feedback can be proposed only when the owner asked in this turn.",
  invalid: `Refused: the report isn't in the right shape. It needs a type (bug, friction or improvement), a title of 1 to ${MAX_FEEDBACK_TITLE} characters on one line, and what you tried, what happened and what you expected, each 1 to ${MAX_FEEDBACK_FIELD} characters. Nothing else goes in it.`,
  final: "Refused: the owner has decided on this report. Don't propose it a second time.",
} as const;

/** What Main is told once the owner's tap has been acted on. Never a field of the report. */
export const FEEDBACK_REPLIES = {
  filed: (reportId?: string) => reportId && REPORT_ID.test(reportId)
    ? `The owner approved it and the report was sent. Report id: ${reportId}.`
    : "The owner approved it and the report was sent.",
  rate_limited: "The feedback service is rate limiting reports. Nothing was sent. Wait a few minutes before proposing it.",
  busy: "The feedback service is busy. Nothing was sent. Tell the owner and don't retry in this conversation.",
  rejected: (code?: string) => code && ERROR_CODE.test(code)
    ? `The feedback service rejected the report (${code}). Nothing was sent. Don't resend it as is.`
    : "The feedback service rejected the report. Nothing was sent. Don't resend it as is.",
  unknown: "The send didn't finish, so the report may or may not have been sent. Don't propose it a second time; the team could get two copies.",
  refused: "The report was not sent: the approval was spent or the chat is holding the owner's data.",
} as const;

export function feedbackReply(sent: FeedbackSent): string {
  switch (sent.outcome) {
    case "filed": return FEEDBACK_REPLIES.filed(sent.reportId);
    case "rejected": return FEEDBACK_REPLIES.rejected(sent.code);
    default: return FEEDBACK_REPLIES[sent.outcome];
  }
}

const userPath = /(?:\/(?:home|Users)\/|[A-Za-z]:\\Users\\)(?!(?:Shared|Public)(?:[/\\\s'"`]|$))[^/\\\s'"`]+/i;
const ipv4 = /(?<![0-9.])(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)(?![0-9.])/g;

/**
 * Identifiers and likely secrets, after frontend/src/lib/reportBug/redact.ts: an email, a DID or space id, a `0x`
 * address, a JWT, a Bearer or Basic credential, a PEM header, an IPv4 address (not loopback), a run of 32 or more hex
 * or base64 characters with a digit in it, a known API key prefix, `secret = value` or a home directory.
 */
const SECRET_PATTERNS: readonly RegExp[] = [
  /(?<![\p{L}\p{N}._%+-])[\p{L}\p{N}._%+-]{1,64}@[\p{L}\p{N}-]{1,63}(?:\.[\p{L}\p{N}-]{1,63}){0,8}\.\p{L}{2,24}(?![\p{L}\p{N}])/u,
  /(?<![A-Za-z0-9])did:[a-z0-9]{1,16}:[A-Za-z0-9:._%-]+/,
  /(?<![A-Za-z0-9])tinycloud:[a-z0-9]{1,16}:[A-Za-z0-9:._%-]+/,
  /(?<![0-9a-zA-Z])0x[0-9a-fA-F]{40}(?![0-9a-zA-Z])/,
  /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{2,}/,
  /(?<![A-Za-z0-9])(?:bearer|basic)[ \t]+[A-Za-z0-9._~+/-]{8,}/i,
  /-----BEGIN [A-Z0-9 ]{1,40}-----/,
  /(?<![0-9a-fA-F])(?:0x)?[0-9a-fA-F]{32,}(?![0-9a-fA-F])/,
  /(?<![A-Za-z0-9])(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{10,}/,
  /(?<![A-Za-z0-9])sk-(?:ant-|proj-|svcacct-|or-)?[A-Za-z0-9_-]{16,}/,
  /(?<![A-Za-z0-9])(?:sk|tk)_[A-Za-z0-9_-]{8,}/,
  /(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|(?<![A-Za-z0-9])glpat-[A-Za-z0-9_-]{20,}/,
  /(?<![A-Za-z0-9])(?:xox[abposr]|xapp)-[A-Za-z0-9-]{10,}/,
  /(?<![A-Za-z0-9])(?:AKIA|ASIA)[0-9A-Z]{16}(?![0-9A-Z])/,
  /(?<![A-Za-z0-9])AIza[0-9A-Za-z_-]{35}/,
  /(?<![A-Za-z0-9])[A-Za-z0-9_.-]{0,40}(?:api[ _-]?key|secret|token|passw(?:or)?d|passphrase|pwd|private[ _-]?key|credential|access[ _-]?key)s?["']?[ \t]*[:=][ \t]*["']?[^\s"'<>,;]{6,}/i,
  userPath,
];

/** A run of 32 or more base64 characters is a secret when it holds a digit; a long path of plain words is not. */
const BASE64_RUN = /[A-Za-z0-9+/_=-]{32,}/g;

/** Whether the text holds something that looks like a secret or a personal identifier. */
export function looksSecret(text: string): boolean {
  if (SECRET_PATTERNS.some(pattern => pattern.test(text))) return true;
  for (const match of text.matchAll(ipv4)) if (!match[0].startsWith("127.") && match[0] !== "0.0.0.0") return true;
  for (const match of text.matchAll(BASE64_RUN)) if (/[0-9]/.test(match[0])) return true;
  return false;
}

/** The report's fields in the service's order. `kind` is the model's `type`. */
export interface FeedbackReport {
  area: typeof FEEDBACK_AREA;
  kind: FeedbackType;
  title: string;
  tried: string;
  happened: string;
  expected: string;
  agent: typeof FEEDBACK_AGENT;
}

const REPORT_KEYS = ["area", "kind", "title", "tried", "happened", "expected", "agent"] as const;
const MODEL_KEYS = ["type", "title", "tried", "happened", "expected"];

export type FeedbackRefusal = "invalid" | "security" | "secret";

/** The exact body for a report: fixed key order, fixed `area` and `agent`. */
export function feedbackBody(report: Omit<FeedbackReport, "area" | "agent">): string {
  const { kind, title, tried, happened, expected } = report;
  return JSON.stringify({ area: FEEDBACK_AREA, kind, title, tried, happened, expected, agent: FEEDBACK_AGENT });
}

function cleanFields(input: Record<string, unknown>): Omit<FeedbackReport, "area" | "agent" | "kind"> | undefined {
  const title = plainMessage(input.title, MAX_FEEDBACK_TITLE);
  const tried = plainMessage(input.tried, MAX_FEEDBACK_FIELD);
  const happened = plainMessage(input.happened, MAX_FEEDBACK_FIELD);
  const expected = plainMessage(input.expected, MAX_FEEDBACK_FIELD);
  if (title === undefined || title.includes("\n") || tried === undefined || happened === undefined || expected === undefined) return undefined;
  return { title, tried, happened, expected };
}

/**
 * The model's `report` as the exact body to send, or why it is refused. Fields are cleaned as plain text
 * (plainMessage); a field that still looks like a secret is refused, never rewritten.
 */
export function proposedFeedback(input: unknown): { body: string } | { error: FeedbackRefusal } {
  if (!isRecord(input) || Object.keys(input).some(key => !MODEL_KEYS.includes(key))) return { error: "invalid" };
  if (input.type === "security") return { error: "security" };
  const kind = FEEDBACK_TYPES.find(type => type === input.type);
  const fields = cleanFields(input);
  if (!kind || !fields) return { error: "invalid" };
  if (Object.values(fields).some(looksSecret)) return { error: "secret" };
  const body = feedbackBody({ kind, ...fields });
  return Buffer.byteLength(body) <= MAX_FEEDBACK_BYTES ? { body } : { error: "invalid" };
}

/**
 * A stored body read back: the report when it is exactly what `feedbackBody` makes from clean fields within the
 * limits and with nothing that looks like a secret; otherwise undefined. Checked at collection and again at send.
 */
export function storedFeedback(body: unknown): FeedbackReport | undefined {
  if (typeof body !== "string" || Buffer.byteLength(body) > MAX_FEEDBACK_BYTES) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (!isRecord(value) || Object.keys(value).join(",") !== REPORT_KEYS.join(",")) return undefined;
  if (value.area !== FEEDBACK_AREA || value.agent !== FEEDBACK_AGENT) return undefined;
  const kind = FEEDBACK_TYPES.find(type => type === value.kind);
  const fields = cleanFields(value);
  if (!kind || !fields || Object.values(fields).some(looksSecret)) return undefined;
  const report: FeedbackReport = { area: FEEDBACK_AREA, kind, ...fields, agent: FEEDBACK_AGENT };
  return feedbackBody(report) === body ? report : undefined;
}

/** Reads at most `max` bytes of the reply, then lets the rest go. */
async function readCapped(response: Response, max: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < max) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.byteLength;
    }
  } finally {
    void reader.cancel().catch(() => {});
  }
  return new TextDecoder().decode(Buffer.concat(chunks).subarray(0, max));
}

/**
 * One POST of the body to `${origin}/reports`: no redirect, a 15 s deadline, only `content-type` and a fixed
 * User-Agent of our own, and at most 4 KB of the reply read. Nothing is retried. Of a 2xx reply only `id` is kept.
 */
export async function postFeedback(origin: string, body: string, timeoutMs = FEEDBACK_TIMEOUT_MS): Promise<FeedbackSent & { status?: number }> {
  const signal = AbortSignal.timeout(timeoutMs);
  let response: Response;
  try {
    response = await fetch(`${origin}/reports`, {
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/json", "user-agent": FEEDBACK_USER_AGENT },
      body,
      signal,
    });
  } catch {
    return { outcome: "unknown" };
  }
  const status = response.status;
  let reply: unknown;
  try {
    reply = JSON.parse(await readCapped(response, MAX_REPLY_BYTES));
  } catch {
    reply = undefined;
  }
  if (status >= 200 && status < 300) {
    const id = isRecord(reply) && typeof reply.id === "string" && REPORT_ID.test(reply.id) ? reply.id : undefined;
    return { outcome: "filed", status, ...(id ? { reportId: id } : {}) };
  }
  if (status === 429) return { outcome: "rate_limited", status };
  if (status === 503) return { outcome: "busy", status };
  if (status >= 400 && status < 500) {
    const error = isRecord(reply) && isRecord(reply.error) ? reply.error.code : undefined;
    return { outcome: "rejected", status, ...(typeof error === "string" && ERROR_CODE.test(error) ? { code: error } : {}) };
  }
  return { outcome: "unknown", status };
}

/** A send outcome as the supervisor stores it, or undefined when the shape is wrong. */
export function parseFeedbackSent(input: unknown): FeedbackSent | undefined {
  if (!isRecord(input)) return undefined;
  const outcome = FEEDBACK_OUTCOMES.find(known => known === input.outcome);
  if (!outcome) return undefined;
  const reportId = outcome === "filed" && typeof input.reportId === "string" && REPORT_ID.test(input.reportId) ? input.reportId : undefined;
  const code = outcome === "rejected" && typeof input.code === "string" && ERROR_CODE.test(input.code) ? input.code : undefined;
  return { outcome, ...(reportId ? { reportId } : {}), ...(code ? { code } : {}) };
}
