import { Router } from "express";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { TinyCloudNode } from "@tinycloud/node-sdk";
import * as serverPackage from "@tinyboilerplate/server";
import {
  LEDGER_UNAVAILABLE,
  type AcknowledgeInput,
  type AcknowledgeResult,
  type ClearResult,
  type DeadItem,
  type EnqueueInput,
  type EnqueueResult,
  type PendingItem,
  type PendingKind,
} from "../services/connector-queue.js";
// Value import into a module `connector-drain.ts` imports from — but only with `import type`, so
// the cycle is erased at compile time. Shared on purpose: a second copy of the tombstone rule is
// a second thing to forget to update.
import { isTombstoned } from "../services/connector-drain.js";
import type { IngestModeLookup } from "../services/ingest-mode.js";
import {
  deriveWebhookSecret,
  isValidMeetingId,
  isValidSource,
  isValidToken,
  keyedLogHash,
  normalizeWebhookAddress,
  recordSignatureKeyUse,
  redactedErrorMessage,
  verifyWebhookDelivery,
  type WebhookConfigRecord,
  type WebhookTokenRecord,
} from "../services/webhook-tokens.js";
import { SIGNATURE_HEADER } from "../services/webhook-verify.js";

const { assertKvResult, withSessionRefresh } = serverPackage;
const { isKvMissingKeyResult } = serverPackage as typeof serverPackage & {
  isKvMissingKeyResult: (result: unknown, key: string) => boolean;
};

/**
 * The PUBLIC connector webhook route (§4.1-§4.6).
 *
 * `POST /api/connectors/webhooks/:source/:token`, mounted in `index.ts`'s raw-body window —
 * in front of `express.json()`, CSRF and `applyRateLimiters`. Three consequences drive
 * everything in this file:
 *
 *  1. It is UNAUTHENTICATED. Every rejection is the same generic 401 so the route is not an
 *     enumeration oracle, and no input may leave a request unanswered or throw out of the
 *     handler (§4.3 — listen's `Buffer.from(req.body ?? "")` is a live availability bug there).
 *  2. It owns its own limiter chain, because the global one does not run in front of it.
 *  3. It touches the shared single-writer node, so an unauthenticated miss must be cheap:
 *     the token format check runs before any KV call, and the token->address lookup sits
 *     behind W1's mandatory positive+negative in-process cache.
 */

// ── Registry ─────────────────────────────────────────────────────────

/**
 * The sources this mount will answer for. Registry-parameterized so Granola/Meet slot in
 * without a second mount (§4.1); membership is checked before any KV call, and a miss is the
 * same generic 401 as everything else.
 */
export const CONNECTOR_REGISTRY: ReadonlySet<string> = new Set(["fireflies"]);

/** §4.5. `meeting.summarized` enqueues as a distinct item kind. */
export const HANDLED_EVENTS: ReadonlyMap<string, PendingKind> = new Map<
  string,
  PendingKind
>([
  ["Transcription completed", "transcript"],
  ["meeting.transcribed", "transcript"],
  ["meeting.summarized", "summary"],
]);

/**
 * §4.5/§6.2: `timestamp` rides inside the HMAC'd body, so a generous +/-24 h bound is free and
 * closes indefinite replay of a captured delivery. Outside it is `400 stale_delivery` —
 * deliberately NOT a 5xx, because a retry cannot fix it and we must not invite one.
 */
export const FRESHNESS_WINDOW_MS = 24 * 60 * 60 * 1000;

// ── Limiter chain (§4.4) ─────────────────────────────────────────────
//
// [middleware]  IP-only pre-limiter: MEASURES the XFF hop count, rejects nothing
//      ->  express.raw (64kb, inflate:false)
// [handler]  token format check  -> [scanner path] IP + global bucket CHECK, then increment
//      ->  token->address lookup (cached) -> [unknown] same scanner path
//      ->  (ip, token) failure bucket CHECK — registered tokens only
//      ->  HMAC verify  ->  [on failure] manual (ip, token) AND IP failure increment
//      ->  [on success] manual per-token counter increment  ->  enqueue
//
// The IP bucket is CONSULTED only on the scanner paths (format-fail / unknown token), never in
// front of a request that resolved to a registered token. At middleware position its rejection
// hit every request from an IP whose bucket only scanner traffic had filled, and `req.ip` under
// `trust proxy 1` is the client-written last XFF entry — so an unauthenticated attacker could
// pick any victim IP (Fireflies' shared egress range) and suppress the whole cohort's signed
// deliveries. Both failure classes increment both IP-keyed buckets, so registered and
// unregistered tokens are indistinguishable by accounting as well as by status and body.
//
// The failure bucket CANNOT be a pre-handler middleware: it is keyed on (ip, token) for
// REGISTERED tokens, and registration status is what the lookup produces. At middleware
// position it could only key on the raw, unvalidated `req.params.token` (attacker-chosen path
// input as a store key, evaluated before the traversal guard) or fall back to IP-only for
// everything — the cross-tenant bucket that must not ship, since every legitimate delivery for
// every user arrives from Fireflies' small shared egress range and stale pasted secrets make
// Fireflies emit failing requests routinely.

export interface ConnectorWebhookLimiterOptions {
  windowMs?: number;
  /** IP-only pre-limiter — large. Counts format-fail / unknown-token requests only. */
  ipLimit?: number;
  /** (ip, token) failures for a REGISTERED token. */
  tokenFailureLimit?: number;
  /** Verified deliveries per token. Bursts are real: Fireflies fires a backlog at once. */
  tokenSuccessLimit?: number;
  /** IP-INDEPENDENT ceiling, see `globalFailureLimit` below. */
  globalFailureLimit?: number;
  /** LRU cap per bucket. Evictions are logged — no silent caps. */
  maxKeys?: number;
  now?: () => number;
}

const DEFAULT_WINDOW_MS = 5 * 60_000;
const DEFAULT_IP_LIMIT = 300;
const DEFAULT_TOKEN_FAILURE_LIMIT = 20;
const DEFAULT_TOKEN_SUCCESS_LIMIT = 60;
const DEFAULT_GLOBAL_FAILURE_LIMIT = 5_000;
const DEFAULT_MAX_KEYS = 10_000;
const MAX_LOGGED_HOP_COUNTS = 16;

interface Window {
  count: number;
  resetAt: number;
}

/** Fixed-window counter with an LRU cap. Evictions are logged (§4.4: no silent caps). */
class FixedWindowCounter {
  private readonly windows = new Map<string, Window>();

  constructor(
    private readonly label: string,
    private readonly windowMs: number,
    private readonly limit: number,
    private readonly maxKeys: number,
    private readonly now: () => number,
  ) {}

  /** Live key count — the observable §4.4 demands: unknown tokens must create ZERO entries. */
  size(): number {
    return this.windows.size;
  }

  isLimited(key: string): boolean {
    const window = this.windows.get(key);
    if (window === undefined) return false;
    if (window.resetAt <= this.now()) {
      this.windows.delete(key);
      return false;
    }
    return window.count >= this.limit;
  }

  /** Increment and report whether the key is now over its limit. */
  increment(key: string): boolean {
    const now = this.now();
    let window = this.windows.get(key);
    if (window === undefined || window.resetAt <= now) {
      this.evictIfFull(key);
      window = { count: 0, resetAt: now + this.windowMs };
    } else {
      // Refresh LRU position.
      this.windows.delete(key);
    }
    window.count += 1;
    this.windows.set(key, window);
    return window.count > this.limit;
  }

  reset(): void {
    this.windows.clear();
    this.evictionsThisWindow = 0;
    this.evictionWindowEndsAt = 0;
  }

  private evictionsThisWindow = 0;
  private evictionWindowEndsAt = 0;

  private evictIfFull(key: string): void {
    if (this.windows.size < this.maxKeys || this.windows.has(key)) return;
    const oldest = this.windows.keys().next();
    if (oldest.done) return;
    this.windows.delete(oldest.value);
    this.logEviction();
  }

  /**
   * §4.4 wants no silent caps; it does not want one public log line per request. Once the cap
   * is reached EVERY new key evicts, so an unauthenticated caller rotating `X-Forwarded-For`
   * would otherwise choose the volume of a `public_logs=true` stream. First eviction of each
   * window, then the window's total — the same treatment the cohort/hop-count logs get.
   */
  private logEviction(): void {
    const now = this.now();
    if (now >= this.evictionWindowEndsAt) {
      if (this.evictionsThisWindow > 1) {
        logWebhook(
          `op=limiter-evict bucket=${this.label} reason=cap cap=${this.maxKeys} ` +
            `evicted_last_window=${this.evictionsThisWindow}`,
        );
      }
      this.evictionsThisWindow = 1;
      this.evictionWindowEndsAt = now + this.windowMs;
      logWebhook(
        `op=limiter-evict bucket=${this.label} reason=cap cap=${this.maxKeys}`,
      );
      return;
    }
    this.evictionsThisWindow += 1;
  }
}

export interface ConnectorWebhookLimiterStats {
  /** Distinct IPs in the pre-limiter bucket. */
  ipKeys: number;
  /** Distinct (ip, token) failure buckets. Malformed/unknown tokens must never create one. */
  tokenFailureKeys: number;
  /** Distinct per-token success buckets. Same rule. */
  tokenSuccessKeys: number;
  globalFailures: number;
}

/**
 * The route's own limiter chain. One instance per mount; the handler holds a reference so the
 * `(ip, token)` and per-token buckets can be checked and incremented BY HAND at the exact
 * points §4.4 specifies.
 */
export class ConnectorWebhookLimiters {
  private readonly ipBucket: FixedWindowCounter;
  private readonly tokenFailureBucket: FixedWindowCounter;
  private readonly tokenSuccessBucket: FixedWindowCounter;
  private readonly globalFailureLimit: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  private globalFailures: Window;
  private globalTripLogged = false;
  private readonly loggedHopCounts = new Set<number>();
  private readonly deliveriesRateLimited = new Map<string, number>();

  constructor(options: ConnectorWebhookLimiterOptions = {}) {
    this.windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
    this.now = options.now ?? (() => Date.now());
    const maxKeys = options.maxKeys ?? DEFAULT_MAX_KEYS;
    this.ipBucket = new FixedWindowCounter(
      "ip",
      this.windowMs,
      options.ipLimit ?? DEFAULT_IP_LIMIT,
      maxKeys,
      this.now,
    );
    this.tokenFailureBucket = new FixedWindowCounter(
      "ip-token",
      this.windowMs,
      options.tokenFailureLimit ?? DEFAULT_TOKEN_FAILURE_LIMIT,
      maxKeys,
      this.now,
    );
    this.tokenSuccessBucket = new FixedWindowCounter(
      "token",
      this.windowMs,
      options.tokenSuccessLimit ?? DEFAULT_TOKEN_SUCCESS_LIMIT,
      maxKeys,
      this.now,
    );
    this.globalFailureLimit =
      options.globalFailureLimit ?? DEFAULT_GLOBAL_FAILURE_LIMIT;
    this.globalFailures = { count: 0, resetAt: this.now() + this.windowMs };
  }

  /**
   * Middleware position. It MEASURES the XFF hop count (§4.4's W3 measurement) and nothing else.
   *
   * **It no longer rejects, and that is the fix, not an omission.** It used to 429 whenever the
   * IP bucket was already tripped. But the bucket is only ever INCREMENTED by format-fail /
   * unknown-token requests, while at this position the rejection applied to EVERY request from
   * that IP — including a correctly signed delivery for a registered token. §4.4's note that "if
   * XFF is spoofable the IP bucket is untrippable, and if it is not, an IP-only bucket is
   * cross-tenant" is false in the dangerous direction, and a code-execution audit falsified it:
   * under `trust proxy 1` the LAST `X-Forwarded-For` entry wins and the client writes it, so a
   * spoofable XFF does not make the bucket untrippable — it makes it trippable against an
   * ARBITRARY victim IP. Every legitimate Fireflies delivery for every user arrives from
   * Fireflies' small shared egress range, so an unauthenticated attacker with no token and no
   * secret set XFF to that range, sent a handful of malformed POSTs, and 429'd the entire
   * cohort's correctly-signed deliveries for the rest of the window — the exact T12/§4.4 outcome
   * the design says must not ship.
   *
   * So the IP bucket keeps its keying and its counting and gets the exemption
   * `scannerFloodTripped()` already implements for the global bucket: it is CONSULTED in the
   * handler, on the scanner paths only, where a request has already resolved to no registered
   * token. The format-fail path still short-circuits before any KV call, so the
   * node-amplification bound is unchanged; what changed is that a registered token can no longer
   * be dropped by a bucket it never incremented.
   */
  readonly ipPreLimiter: RequestHandler = (
    req: Request,
    res: Response,
    next: NextFunction,
  ) => {
    this.measureForwardedHops(req);
    next();
  };

  /**
   * The IP bucket, read on the scanner paths ONLY — the position the pre-limiter used to occupy,
   * minus the cross-tenant blast radius, because a request reaching this check has already been
   * established to implicate no registered token. Consulted BEFORE counting, so an
   * already-tripped bucket short-circuits without growing, exactly as the middleware did.
   */
  scannerIpLimited(req: Request): boolean {
    return this.ipBucket.isLimited(clientIp(req));
  }

  /**
   * §4.4's IP-INDEPENDENT backstop, also read on the scanner paths only: a request bearing a
   * REGISTERED token is never dropped by it. It survives an unverifiable `trust proxy` hop count,
   * since a rotated XFF cannot uncap it.
   */
  scannerFloodTripped(): boolean {
    return this.globalTripped();
  }

  /**
   * A request that failed §4.1's format check or resolved to no registered token. These are
   * the scanner case: no tenant is implicated, so IP-only keying costs no cross-tenant blast
   * radius, and no per-token state is created.
   */
  countScannerFailure(req: Request): void {
    this.ipBucket.increment(clientIp(req));
    this.countGlobalFailure();
  }

  /** Registered token, so the bucket can be tenant-scoped: a stale secret throttles its owner only. */
  isTokenFailureLimited(req: Request, token: string): boolean {
    return this.tokenFailureBucket.isLimited(failureKey(req, token));
  }

  countTokenFailure(req: Request, token: string): void {
    this.tokenFailureBucket.increment(failureKey(req, token));
    // ALSO into the IP bucket, so the two failure classes are accounted IDENTICALLY.
    //
    // T8/§4.4 rest on "unknown token and bad signature return the identical 401", and they do —
    // but the accounting used to differ, and that was a deterministic three-request oracle: prime
    // the IP bucket to one below its limit, send the candidate token, send one more junk request.
    // A 429 meant the candidate was UNREGISTERED (it had incremented the bucket); a 401 meant it
    // was REGISTERED. Anyone holding a token from a leaked URL or a screenshot could confirm it
    // live, which is exactly T12's precondition. Counting both here costs nothing now that the IP
    // bucket is consulted on the scanner paths only — a registered token's request can no longer
    // be REJECTED by it, so the increment carries no cross-tenant blast radius.
    this.ipBucket.increment(clientIp(req));
    this.countGlobalFailure();
  }

  /**
   * The per-token bucket counts ONLY deliveries that actually verified — never as middleware.
   * The token is not a secret in practice (it rides in a URL the user pastes into Fireflies),
   * so a middleware-position token bucket would let anyone holding just the token 429 that
   * user's real deliveries with 60 unsigned requests: targeted suppression, no secret needed
   * (T12). Returns false when the delivery must be answered 429.
   */
  consumeTokenSuccess(token: string, address: string): boolean {
    const exceeded = this.tokenSuccessBucket.increment(token);
    if (exceeded) {
      // 429s must be visible, not silent: §4.7 does not rely on provider retries, so a
      // dropped notification would otherwise be indistinguishable from nothing happening.
      this.deliveriesRateLimited.set(
        address.toLowerCase(),
        this.now() + this.windowMs,
      );
      return false;
    }
    return true;
  }

  /** Read by the authenticated `GET …/webhooks/pending` companion (W3b) for the card state. */
  deliveriesAreRateLimited(address: string): boolean {
    const until = this.deliveriesRateLimited.get(address.toLowerCase());
    if (until === undefined) return false;
    if (until <= this.now()) {
      this.deliveriesRateLimited.delete(address.toLowerCase());
      return false;
    }
    return true;
  }

  stats(): ConnectorWebhookLimiterStats {
    return {
      ipKeys: this.ipBucket.size(),
      tokenFailureKeys: this.tokenFailureBucket.size(),
      tokenSuccessKeys: this.tokenSuccessBucket.size(),
      globalFailures:
        this.globalFailures.resetAt <= this.now()
          ? 0
          : this.globalFailures.count,
    };
  }

  reset(): void {
    this.ipBucket.reset();
    this.tokenFailureBucket.reset();
    this.tokenSuccessBucket.reset();
    this.globalFailures = { count: 0, resetAt: this.now() + this.windowMs };
    this.globalTripLogged = false;
    this.deliveriesRateLimited.clear();
    this.loggedHopCounts.clear();
  }

  /**
   * The IP-INDEPENDENT ceiling (§4.4's explicit fallback).
   *
   * `app.set("trust proxy", 1)` means "trust exactly one hop", so `req.ip` is the LAST
   * `X-Forwarded-For` entry — and nothing verifies that the Phala CVM ingress is exactly one
   * hop and rewrites XFF. §4.4 claims the two failure modes are mutually exclusive ("if XFF is
   * spoofable the IP bucket is untrippable, and if it is not, an IP-only bucket is
   * cross-tenant"); **that is FALSE**, and it is false in the dangerous direction: a spoofable
   * XFF makes the IP bucket trippable against an ARBITRARY chosen victim IP, which is strictly
   * worse than untrippable. Both properties therefore have to be defended at once, and they are:
   * this bucket is IP-INDEPENDENT so a rotated XFF cannot uncap it, and BOTH IP-keyed buckets are
   * consulted on the scanner paths only so neither can drop a registered token's signed delivery.
   *
   * It counts only FAILURES (a verified delivery never touches it) and its limit is far above
   * anything legitimate traffic produces. When it trips it still suppresses SCANNER traffic
   * globally for the rest of the window — never a registered token — and the trip is logged
   * loudly rather than absorbed silently. The hop count still cannot be measured without a
   * deploy: read `op=xff-hops` off a canary before enabling this in production.
   */
  private countGlobalFailure(): void {
    const now = this.now();
    if (this.globalFailures.resetAt <= now) {
      this.globalFailures = { count: 0, resetAt: now + this.windowMs };
      this.globalTripLogged = false;
    }
    this.globalFailures.count += 1;
    if (
      this.globalFailures.count >= this.globalFailureLimit &&
      !this.globalTripLogged
    ) {
      this.globalTripLogged = true;
      logWebhookWarn(
        `op=global-failure-trip limit=${this.globalFailureLimit} window_ms=${this.windowMs}`,
      );
    }
  }

  private globalTripped(): boolean {
    if (this.globalFailures.resetAt <= this.now()) return false;
    return this.globalFailures.count >= this.globalFailureLimit;
  }

  /**
   * §4.4's measurement, in the only form a route can take it: the NUMBER of `X-Forwarded-For`
   * hops, logged on first sight of each distinct value. The addresses themselves are never
   * logged (§6.3). `hops=1` on the live CVM confirms `trust proxy 1`; anything else means the
   * value is wrong and `req.ip` is attacker-controlled.
   */
  private measureForwardedHops(req: Request): void {
    const raw = req.headers["x-forwarded-for"];
    const value = Array.isArray(raw)
      ? raw.join(",")
      : typeof raw === "string"
        ? raw
        : "";
    const hops = value
      .split(",")
      .filter((entry) => entry.trim().length > 0).length;
    if (this.loggedHopCounts.has(hops)) return;
    if (this.loggedHopCounts.size >= MAX_LOGGED_HOP_COUNTS) return;
    this.loggedHopCounts.add(hops);
    logWebhook(`op=xff-hops hops=${hops} trust_proxy=1`);
  }
}

function failureKey(req: Request, token: string): string {
  return `${clientIp(req)}|${token}`;
}

function clientIp(req: Request): string {
  return req.ip ?? req.socket?.remoteAddress ?? "unknown";
}

// ── Logging (§6.3) ───────────────────────────────────────────────────

/**
 * `public_logs=true` on the CVM, so: ids only, never payload content, never key material,
 * never a full address, and never a raw token (`token=<first8>` is a stable per-user key AND a
 * free live-token confirmation oracle — it is the defect, not the mitigation). Attacker-
 * supplied fields are hashed or stripped before they reach `console.log`: Express decodes
 * `%0A` in a path param, so an unsanitized field forges lines into the forensic record.
 *
 * **`tid=` appears ONLY after the signature has verified**, and T11 is not closed without that
 * restriction. The keyed hash removed the no-request-needed half of the oracle; it did not
 * remove the confirmation. The deploy runs `phala deploy --public-logs`, so an attacker holding
 * a candidate token from a leaked URL or a screenshot could send ONE request, read their own
 * `tid=` off the public stream (they cannot compute it — the salt is secret — but the route
 * printed it for them), then grep that stream for the same `tid=` with `result=queued`. That
 * both confirms the token is live and yields the owner's whole delivery history (`mid=` hashes,
 * kinds, timestamps). A caller that reaches the post-verify lines has proved possession of the
 * derived secret, so its own `tid=` tells it nothing it did not already know. Pre-verify lines
 * keep `source=`, `reason=` and the `sig=` hash, which is what failure triage actually reads.
 */
function hashedField(value: string): string {
  try {
    return keyedLogHash(value);
  } catch {
    // LOG_HASH_SALT unset (flag-off / test contexts): drop the field rather than fake it.
    return "unavailable";
  }
}

function safeField(value: unknown, maxLength = 48): string {
  if (typeof value !== "string" || value.length === 0) return "-";
  const stripped = value.replace(/[^A-Za-z0-9._-]/g, "");
  if (stripped.length === 0) return "-";
  return stripped.slice(0, maxLength);
}

function logWebhook(fields: string): void {
  console.log(`[connector-webhook] ${fields} t=${new Date().toISOString()}`);
}

function logWebhookWarn(fields: string): void {
  console.warn(`[connector-webhook] ${fields} t=${new Date().toISOString()}`);
}

// ── Handler ──────────────────────────────────────────────────────────

/** The slice of `WebhookTokenService` this route needs (§4.1). */
export interface WebhookTokenLookup {
  lookup(token: unknown): Promise<WebhookTokenRecord | null>;
}

/** The slice of `ConnectorQueue` this route needs (§5.1). */
export interface WebhookEnqueuer {
  enqueue(
    source: string,
    address: string,
    input: EnqueueInput,
  ): Promise<EnqueueResult>;
}

export interface ConnectorWebhookHandlerOptions {
  tokens: WebhookTokenLookup;
  queue: WebhookEnqueuer;
  limiters: ConnectorWebhookLimiters;
  registry?: ReadonlySet<string>;
  now?: () => number;
  /**
   * Fire-and-forget post-ack hook, invoked AFTER the response is written (§4.6's fast-ack
   * discipline: the 202 never waits on a delegation activation or a write to the user's space).
   *
   * UNWIRED UNDER OPTION C, deliberately (index.ts is pinned against it). It used to kick a
   * drain, which under C meant a full pass — config, disabled marker, queue and purge-ledger
   * reads — to surface ids to nobody, since the browser is the writer and nothing is listening
   * between visits. Enqueueing the id is the entire server-side job; processing happens on the
   * user's next authenticated visit. The seam stays for an Option-A writer.
   */
  onDelivery?: (input: {
    source: string;
    address: string;
  }) => void | Promise<void>;
}

interface NormalizedPayload {
  event: unknown;
  meetingId: unknown;
  timestamp: unknown;
}

function normalizePayload(raw: Record<string, unknown>): NormalizedPayload {
  return {
    event: raw.eventType ?? raw.event,
    meetingId: raw.meetingId ?? raw.meeting_id,
    timestamp: raw.timestamp ?? null,
  };
}

/**
 * §4.5's freshness window, epoch forms included. `Date.parse(String(1700000000))` is **NaN** —
 * and `NaN` used to mean "skip the check", so every numeric timestamp silently disabled the
 * window that T1's replay residual leans on. Numbers are parsed as numbers: <= 1e11 is epoch
 * SECONDS (1e11 seconds is year 5138; 1e11 ms is 1973, and no provider stamps a 1973 delivery),
 * anything larger is epoch millis. `Date.parse` is reached only for a non-numeric string.
 *
 * Returns null when no instant can be established — the caller treats that as stale.
 */
export function parseDeliveryTimestamp(value: unknown): number | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) return null;
    return value <= 1e11 ? value * 1000 : value;
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  if (/^\d+$/.test(trimmed)) return parseDeliveryTimestamp(Number(trimmed));
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * §4.4's accounting, for the requests that never reach the handler.
 *
 * The public mount sits AHEAD of `applyRateLimiters` and `ipPreLimiter` only measures XFF hops,
 * so every counter increment lived inside the handler — and a request that dies in
 * `express.raw` (over the 64 kb cap, or `Content-Encoding: gzip` against `inflate:false`) never
 * gets there. A code-executing audit measured the hole: 100 unauthenticated requests carrying
 * ~3.4 MB produced `{ipKeys:0, tokenFailureKeys:0, globalFailures:0}` — including §4.4's
 * IP-INDEPENDENT ceiling, which exists precisely because a rotated XFF can uncap the others.
 *
 * Registered as 4-arity error middleware immediately after `express.raw` on this mount ONLY, so
 * a parser reject lands in the same buckets as a format-fail. It answers the generic 401 on a
 * tripped bucket for the same reason every other scanner path does — a bucket's job is to stop
 * work, not to name itself — and otherwise re-throws so the response stays byte-identical to
 * today's (413 / 415). Per-request cost was already bounded (body-parser stops reading at the
 * cap, `inflate:false` prevents decompression work); what was missing was the accounting.
 *
 * Not covered: a non-POST method on this path, which Express 404s before any of this runs.
 */
export function createConnectorWebhookParserErrorHandler(
  limiters: ConnectorWebhookLimiters,
): (error: unknown, req: Request, res: Response, next: NextFunction) => void {
  return (
    error: unknown,
    req: Request,
    res: Response,
    next: NextFunction,
  ): void => {
    if (res.headersSent) {
      next(error);
      return;
    }
    const generic401 = (bucket: string): void => {
      logWebhook(
        `recv source=${safeField(req.params.source)} result=invalid_signature ` +
          `reason=limited bucket=${bucket}`,
      );
      res.status(401).json({ error: "invalid_signature" });
    };

    // Consulted BEFORE counting, exactly as the handler's scanner paths do, so an already-tripped
    // bucket short-circuits without growing.
    if (limiters.scannerIpLimited(req)) {
      generic401("ip");
      return;
    }
    limiters.countScannerFailure(req);
    if (limiters.scannerFloodTripped()) {
      generic401("global");
      return;
    }
    logWebhook(
      `recv source=${safeField(req.params.source)} result=parser_reject ` +
        `reason=${safeField((error as { type?: unknown } | null)?.type)}`,
    );
    next(error);
  };
}

// ── W9: the Host-header allowlist (plan §8.1 W9 / §10; findings §6 control 6) ──
//
// Control 6 is called out as becoming LOAD-BEARING the moment the server fetches on webhooks.
// Under Option C an off-target delivery cost one enqueue; for a cohort address the same delivery
// now costs a credentialed upstream fetch and an encrypted server-side content row. So a request
// that did not arrive at the hostname we minted into the user's provider dashboard is rejected at
// the cheapest possible point — ahead of the pre-limiter, ahead of `express.raw`, ahead of any
// bucket keyed on request content, and long ahead of any KV call.
//
// What this is NOT: an authentication boundary. The HMAC is.
// `docs/connector-webhooks-trust-proxy.md` records the ingress hop count as UNDETERMINED, so a
// forwarded host is only as trustworthy as the proxy in front of it. This control removes
// untargeted surface — raw-IP probing, a stale domain still pointed at the CVM, a rebinding
// attempt — and nothing in this file claims more than that.

/** Comma-separated hosts. Unset ⇒ derive from the pinned public origin (one source of truth). */
export const WEBHOOK_HOST_ALLOWLIST_ENV = "CONNECTOR_WEBHOOK_HOST_ALLOWLIST";

/**
 * The ONE documented escape hatch, for an ingress that rewrites both `Host` and
 * `X-Forwarded-Host` to something internal. Explicit and loud: a value that merely *looked* wrong
 * silently disabling the control is the fallback-that-hides-an-error this build refuses.
 */
export const WEBHOOK_HOST_ALLOWLIST_OFF = "*";

/** No `/`, no whitespace, no CR/LF: the value is an attacker-controlled header. */
const HOST_VALUE_PATTERN = /^[A-Za-z0-9._-]+(?::\d{1,5})?$/;

/**
 * Lowercase, and drop an explicit default port so `example.com` and `example.com:443` are the same
 * host. Returns null for anything that is not a bare host[:port] — a header carrying a path, a
 * space or a CRLF is rejected rather than sanitized into something that might match.
 */
export function normalizeWebhookHost(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || !HOST_VALUE_PATTERN.test(trimmed)) return null;
  return trimmed.toLowerCase().replace(/:(?:80|443)$/, "");
}

/**
 * The allowlist, in precedence order:
 *
 *  1. `CONNECTOR_WEBHOOK_HOST_ALLOWLIST` — explicit, comma-separated (or `*` to disable).
 *  2. the host of `CONNECTOR_WEBHOOK_PUBLIC_ORIGIN` — the origin we already pin into every minted
 *     callback URL, so the host we answer on and the host we hand the provider cannot drift.
 *  3. `null` — no enforcement. Local QA, where the callback origin is request-derived anyway.
 *
 * `null` and "empty set" are deliberately different: an empty set would reject every delivery, so
 * a config omission must never produce one. A PRESENT but entirely unusable explicit list throws
 * here, at construction, rather than at the first delivery — the same posture
 * `validatePublicOrigin` takes.
 */
export function resolveWebhookHostAllowlist(
  env: NodeJS.ProcessEnv = process.env,
): ReadonlySet<string> | null {
  const explicit = env[WEBHOOK_HOST_ALLOWLIST_ENV];
  if (typeof explicit === "string" && explicit.trim().length > 0) {
    if (explicit.trim() === WEBHOOK_HOST_ALLOWLIST_OFF) {
      console.warn(
        `[connector-webhook] op=host-allowlist result=disabled reason=explicit_off ` +
          `t=${new Date().toISOString()}`,
      );
      return null;
    }
    const hosts = explicit
      .split(",")
      .map((entry) => normalizeWebhookHost(entry))
      .filter((entry): entry is string => entry !== null);
    if (hosts.length === 0) {
      throw new Error(
        `${WEBHOOK_HOST_ALLOWLIST_ENV} contains no usable host (use "${WEBHOOK_HOST_ALLOWLIST_OFF}" to disable)`,
      );
    }
    return new Set(hosts);
  }

  const origin = env.CONNECTOR_WEBHOOK_PUBLIC_ORIGIN;
  if (typeof origin !== "string" || origin.trim().length === 0) return null;
  let host: string | null;
  try {
    host = normalizeWebhookHost(new URL(origin.trim()).host);
  } catch {
    // A malformed origin is already a hard error where it is USED (validatePublicOrigin); it must
    // not additionally become a one-entry allowlist of something that is not a host.
    host = null;
  }
  return host === null ? null : new Set([host]);
}

export interface ConnectorWebhookHostGuardOptions {
  allowlist: ReadonlySet<string> | null;
  limiters: ConnectorWebhookLimiters;
}

function forwardedOrDirectHost(req: Request): string | undefined {
  const raw = req.headers["x-forwarded-host"] ?? req.headers.host;
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string") return undefined;
  // Only the FIRST entry of a comma list: a chain whose later hop happens to be allowed must not
  // launder the first one, which is the value that actually addressed us.
  return value.split(",")[0];
}

/**
 * The guard middleware. Rejection is the SAME generic 401 every other pre-verify path returns — a
 * host-shaped oracle is still an oracle — and it lands in the same scanner buckets a format-fail
 * does, because §4.4's own lesson is that a rejection reaching no bucket is free traffic. The
 * offending host is never echoed: it is attacker-chosen and the CVM runs `public_logs=true`.
 */
export function createConnectorWebhookHostGuard(
  options: ConnectorWebhookHostGuardOptions,
): RequestHandler {
  const { allowlist, limiters } = options;
  if (allowlist === null) {
    // A pure pass-through, built once: the unconfigured path costs one closure call per delivery.
    return (_req: Request, _res: Response, next: NextFunction) => next();
  }

  return (req: Request, res: Response, next: NextFunction): void => {
    const host = normalizeWebhookHost(forwardedOrDirectHost(req));
    if (host !== null && allowlist.has(host)) {
      next();
      return;
    }

    // Consulted BEFORE counting, exactly as the parser-error handler and the handler's own scanner
    // paths do, so an already-tripped bucket short-circuits without growing.
    const bucket = limiters.scannerIpLimited(req) ? "ip" : null;
    if (bucket === null) limiters.countScannerFailure(req);
    logWebhook(
      `recv source=${safeField(req.params.source)} result=invalid_signature reason=host` +
        (bucket === null ? "" : ` bucket=${bucket}`),
    );
    if (!res.headersSent) res.status(401).json({ error: "invalid_signature" });
  };
}

export function createConnectorWebhookHandler(
  options: ConnectorWebhookHandlerOptions,
): RequestHandler {
  const { tokens, queue, limiters } = options;
  const registry = options.registry ?? CONNECTOR_REGISTRY;
  const now = options.now ?? (() => Date.now());

  return async (req: Request, res: Response): Promise<void> => {
    // §4.3 requirement 1: nothing below may leave the request unanswered or throw out of the
    // handler. Express 4 does not await handler promises, so an escaping rejection would hang
    // the socket and — on Bun — take the process with it, from an unauthenticated route.
    const respond = (status: number, body: unknown): void => {
      if (!res.headersSent) res.status(status).json(body);
    };
    const generic401 = (): void => respond(401, { error: "invalid_signature" });

    const source = req.params.source ?? "";
    const token = req.params.token ?? "";

    try {
      // 1. Format checks, BEFORE any KV call (§4.1). Express percent-decodes route params, so
      //    `/fireflies/..%2F..%2Fdelegations%2F0xabc` arrives as `../../delegations/0xabc`;
      //    both validators reject `/`, `\` and `.` by construction. The traversal guard and the
      //    node-amplification guard are the same guard.
      if (
        !isValidSource(source) ||
        !registry.has(source) ||
        !isValidToken(token)
      ) {
        // The GENERIC 401 on BOTH suppression arms, never §4.6's 429 row — see the note on the
        // (ip, token) bucket below. A 429 here diverges from the 401 the registered-token path
        // returns, and that divergence IS the live-token oracle §4.4/T8 say must not exist:
        // prime this bucket once (it short-circuits WITHOUT incrementing, so it stays tripped),
        // then one request per candidate token answers 429 for unknown and 401 for REGISTERED.
        // The prior fix equalised the ACCOUNTING; the response still gave the answer away.
        // Consulting the IP bucket on the registered path instead would restore exactly the
        // cross-tenant blast radius the pre-limiter fix removed. The short-circuit (no work, no
        // increment) is kept — a bucket's job is to stop work, not to name itself. The log line
        // still records which bucket fired.
        if (limiters.scannerIpLimited(req)) {
          logWebhook(
            `recv source=${safeField(source)} result=invalid_signature reason=limited bucket=ip`,
          );
          generic401();
          return;
        }
        limiters.countScannerFailure(req);
        if (limiters.scannerFloodTripped()) {
          logWebhook(
            `recv source=${safeField(source)} result=invalid_signature reason=limited bucket=global`,
          );
          generic401();
          return;
        }
        logWebhook(
          `recv sig=${hashedField(signatureValue(req))} ` +
            `source=${safeField(source)} result=invalid_signature reason=format`,
        );
        generic401();
        return;
      }

      // 2. Body coercion. NEVER `Buffer.from(req.body ?? "")`: `express.raw` sets
      //    `req.body = {}` before its type guard and returns unparsed whenever the
      //    `Content-Type` is not `application/json` (or there is no body), so `?? ""` never
      //    fires and `Buffer.from({})` THROWS. An empty Buffer never verifies and falls
      //    through to the generic 401 — no throw, no oracle (§4.3).
      const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);

      // 3. token -> address, behind W1's mandatory positive+negative in-process cache.
      let record: WebhookTokenRecord | null;
      try {
        record = await tokens.lookup(token);
      } catch (error) {
        // An error is not a miss. Token-independent by construction, so it is not an oracle.
        logWebhookWarn(`op=lookup-error source=${safeField(source)}`);
        console.warn(
          "[connector-webhook] token lookup failed:",
          redactedErrorMessage(error),
        );
        respond(503, { error: "unavailable" });
        return;
      }

      if (record === null || record.source !== source) {
        // Unknown token: the scanner case. Same body and status as a bad signature — including
        // when either scanner bucket is tripped, which is where the two used to diverge.
        if (limiters.scannerIpLimited(req)) {
          logWebhook(
            `recv source=${safeField(source)} result=invalid_signature reason=limited bucket=ip`,
          );
          generic401();
          return;
        }
        limiters.countScannerFailure(req);
        if (limiters.scannerFloodTripped()) {
          logWebhook(
            `recv source=${safeField(source)} result=invalid_signature reason=limited bucket=global`,
          );
          generic401();
          return;
        }
        logWebhook(
          `recv sig=${hashedField(signatureValue(req))} ` +
            `source=${safeField(source)} result=invalid_signature reason=unknown_token`,
        );
        generic401();
        return;
      }

      // 4. (ip, token) failure bucket — registered tokens only, checked here because
      //    registration status does not exist before the lookup (§4.4).
      if (limiters.isTokenFailureLimited(req, token)) {
        logWebhook(
          `recv source=${safeField(source)} result=rate_limited bucket=ip-token`,
        );
        // The GENERIC 401, not §4.6's 429 row. This bucket only ever throttles requests we
        // would have answered 401 anyway, and it exists only for REGISTERED tokens — so
        // answering 429 here is the one place §4.4's "unknown token and bad signature return
        // the identical 401" stops holding, and it turns the bucket into a live-token
        // confirmation oracle for anyone holding a token from a leaked URL or a screenshot
        // (21 unauthenticated requests, no secret). A bucket's job is to stop work, not to
        // tell the caller which bucket it hit. §4.6's 429 row still governs the per-token
        // SUCCESS bucket, which is the one the user's card surfaces.
        generic401();
        return;
      }

      // 5. HMAC verify. Never throws: a non-ASCII header is shape-rejected before any buffer
      //    work, so listen's `RangeError` (a 500 that doubles as an oracle) cannot happen.
      let verified: { verified: boolean; sigKey: "current" | "prev" | null };
      try {
        verified = verifyWebhookDelivery({
          rawBody,
          signatureHeader: req.headers[SIGNATURE_HEADER],
          source,
          token,
        });
      } catch (error) {
        // Only reachable on a misconfigured master, which §7.1's startup gate refuses to boot
        // with. Token-independent, so 503 (retry) rather than a 401 that would hide it.
        logWebhookWarn(`op=verify-error source=${safeField(source)}`);
        console.warn(
          "[connector-webhook] signature verification failed to run:",
          redactedErrorMessage(error),
        );
        respond(503, { error: "unavailable" });
        return;
      }

      if (!verified.verified) {
        limiters.countTokenFailure(req, token);
        logWebhook(
          `recv sig=${hashedField(signatureValue(req))} ` +
            `source=${safeField(source)} result=invalid_signature reason=signature`,
        );
        generic401();
        return;
      }

      recordSignatureKeyUse(record.address, verified.sigKey ?? "current");

      // 6. Per-token success bucket — incremented ONLY now, after the signature verified.
      if (!limiters.consumeTokenSuccess(token, record.address)) {
        logWebhook(
          `recv tid=${hashedField(token)} source=${safeField(source)} result=rate_limited ` +
            `bucket=token`,
        );
        respond(429, { error: "rate_limited" });
        return;
      }

      // 7. JSON.parse runs only AFTER the signature verifies (listen's flow is right here).
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawBody.toString("utf8"));
      } catch {
        logWebhook(
          `recv tid=${hashedField(token)} source=${source} result=invalid_json`,
        );
        respond(400, { error: "invalid_json" });
        return;
      }
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        Array.isArray(parsed)
      ) {
        logWebhook(
          `recv tid=${hashedField(token)} source=${source} result=invalid_json`,
        );
        respond(400, { error: "invalid_json" });
        return;
      }

      const normalized = normalizePayload(parsed as Record<string, unknown>);
      const eventName =
        typeof normalized.event === "string" ? normalized.event : "";
      const kind = HANDLED_EVENTS.get(eventName);
      if (kind === undefined) {
        // Answer 200 so Fireflies stops retrying an event we will never handle.
        logWebhook(
          `recv tid=${hashedField(token)} source=${source} event=${safeField(eventName)} ` +
            `result=ignored`,
        );
        // `safeField`, not a bare 128-char slice: this is the ONE attacker-chosen string that
        // leaves this route, and it should be bounded by the same allowlist as the one that
        // reaches the log — a 5,000-character `eventType` used to come back 128 characters wide.
        respond(200, { status: "ignored", event: safeField(eventName) });
        return;
      }

      if (
        typeof normalized.meetingId !== "string" ||
        normalized.meetingId.length === 0
      ) {
        logWebhook(
          `recv tid=${hashedField(token)} source=${source} event=${safeField(eventName)} ` +
            `result=missing_meeting_id`,
        );
        respond(400, { error: "missing_meeting_id" });
        return;
      }

      // The SAME strictness as `:token`, at the same place: the id becomes a queue element, a
      // user-space KV key segment, a SQL `source_id` and a purge-ledger entry (§4.5).
      if (!isValidMeetingId(normalized.meetingId)) {
        logWebhook(
          `recv tid=${hashedField(token)} source=${source} event=${safeField(eventName)} ` +
            `result=invalid_meeting_id`,
        );
        respond(400, { error: "invalid_meeting_id" });
        return;
      }
      const meetingId = normalized.meetingId;

      // §4.5's freshness window. Present-and-parses only: the legacy `{meetingId, eventType}`
      // shape carries no timestamp and is accepted without the check — a recorded, deliberate
      // consequence (those deliveries stay indefinitely replayable).
      let stamped: number | null = null;
      if (normalized.timestamp !== null && normalized.timestamp !== undefined) {
        stamped = parseDeliveryTimestamp(normalized.timestamp);
        // Unparseable is STALE, not absent. The absent-timestamp exemption is for the legacy
        // `{meetingId, eventType}` shape, which carries no field at all; a present field we
        // cannot read is a delivery whose freshness we cannot establish, and treating it as
        // exempt is how the control gets disabled by sending it as an object.
        if (
          stamped === null ||
          Math.abs(now() - stamped) > FRESHNESS_WINDOW_MS
        ) {
          logWebhook(
            `recv tid=${hashedField(token)} source=${source} event=${safeField(eventName)} ` +
              `mid=${hashedField(meetingId)} result=stale_delivery`,
          );
          // 400, never a 5xx: a retry cannot fix a stale delivery and we must not invite one.
          respond(400, { error: "stale_delivery" });
          return;
        }
      }

      // 8. Enqueue. The 202 is gated on this durable write and nothing else (§4.6).
      let result: EnqueueResult;
      try {
        result = await queue.enqueue(source, record.address, {
          meetingId,
          kind,
          receivedAt: new Date(now()).toISOString(),
          // Carried so §6.2's tombstone has an instant a replay cannot refresh (§5.1).
          ...(stamped !== null
            ? { sourceTimestamp: new Date(stamped).toISOString() }
            : {}),
        });
      } catch (error) {
        logWebhookWarn(
          `op=enqueue-error tid=${hashedField(token)} source=${source} mid=${hashedField(meetingId)}`,
        );
        console.warn(
          "[connector-webhook] enqueue failed:",
          redactedErrorMessage(error),
        );
        // The ONE case we ask for a retry.
        respond(503, { error: "unavailable" });
        return;
      }

      logWebhook(
        `recv tid=${hashedField(token)} sig=${hashedField(signatureValue(req))} ` +
          `source=${source} event=${safeField(eventName)} mid=${hashedField(meetingId)} ` +
          `kind=${kind} sig_key=${verified.sigKey ?? "current"} result=queued ` +
          `queue_result=${result.status} depth=${result.depth}`,
      );

      // Byte-identical to the happy path even when the cap dropped an item: on an
      // unauthenticated route a `dropped:n` field tells a token+secret holder exactly when a
      // victim's queue is saturated. The drop count goes to the log (above, and
      // `op=drop-oldest` from the queue) and to the authenticated `GET …/webhooks/pending`.
      respond(202, { status: "queued" });

      // Fast-ack: the drain kick is fire-and-forget, strictly after the response.
      if (options.onDelivery) {
        try {
          const kicked = options.onDelivery({
            source,
            address: record.address,
          });
          if (kicked && typeof (kicked as Promise<void>).catch === "function") {
            (kicked as Promise<void>).catch((error: unknown) => {
              console.warn(
                "[connector-webhook] drain kick failed:",
                redactedErrorMessage(error),
              );
            });
          }
        } catch (error) {
          console.warn(
            "[connector-webhook] drain kick failed:",
            redactedErrorMessage(error),
          );
        }
      }
    } catch (error) {
      // The backstop §4.3 requires: no path leaves the request unanswered. Token-independent
      // by construction (every token-dependent failure is handled above), so it is not an
      // oracle, and it is logged rather than swallowed.
      // No `tid=`: this backstop is reachable from before the signature verifies, and a `tid=`
      // an unverified caller can provoke is the T11 confirmation oracle (see `hashedField`).
      logWebhookWarn(`op=handler-error source=${safeField(source)}`);
      console.warn(
        "[connector-webhook] handler error:",
        redactedErrorMessage(error),
      );
      respond(503, { error: "unavailable" });
    }
  };
}

function signatureValue(req: Request): string {
  const header = req.headers[SIGNATURE_HEADER];
  if (Array.isArray(header)) return header.join(",");
  return typeof header === "string" ? header : "";
}

// ═══════════════════════════════════════════════════════════════════════
// AUTHENTICATED COMPANIONS (§3.6, §4.4, §4.8, §5.4, §6.2)
// ═══════════════════════════════════════════════════════════════════════
//
// `GET/POST/DELETE /config`, `GET /pending`, `POST /drain`, `POST/DELETE /purged`.
//
// These mount in the NORMAL window (index.ts `:194+`), behind the global JSON parser, CSRF,
// `authMiddleware` and their OWN rate-limit bucket — never `globalLimiter`'s 120/15min, which
// `/api/chat` shares (§4.4). They stay **one path segment deep**: a two-segment companion
// would be matched by the public `POST /:source/:token` mount in the raw window, arrive as a
// Buffer, and be keyed into a token bucket that has no token.
//
// The disabled marker and the purge ledger live here rather than in a service of their own
// because §2.3's file table is authoritative for this build and lists neither; both are state
// these routes own and the drain (W5) only reads.

/** §5.1-shaped, backend-own keys — auto-prefixed under `ops.tinychat.backend`, NOT `xyz.tinycloud.tinychat/…`. */
const DISABLED_KEY_PREFIX = "webhooks/disabled";
const PURGED_KEY_PREFIX = "webhooks/purged";
const CORRUPT_PURGED_KEY_PREFIX = "webhooks/corrupt/purged";

/** §6.2: `recentIds` is forensics only and stays capped; `purgedThrough` is what protects. */
export const PURGE_RECENT_ID_CAP = 200;

/** §4.8: one POST may contribute at most this many ids to `recentIds`; the overflow is LOGGED. */
export const PURGE_IDS_PER_REQUEST_CAP = 200;

/**
 * §4.8: `purgedThrough` is client-supplied, so a wildly future value would tombstone the
 * user's whole future. A generous clock-skew allowance, then a 400 — never a silent clamp.
 */
export const PURGE_FUTURE_SKEW_MS = 24 * 60 * 60 * 1000;

/**
 * §4.7 shape C: one `POST /ack` may settle at most this many identities. The pending queue is
 * capped at `PENDING_CAP` (200), so a batch larger than that cannot correspond to real work —
 * and an overflow is a 400 rather than a silent truncation, because a truncated ack would leave
 * the browser believing ids were settled that are still queued.
 */
export const ACK_ITEMS_PER_REQUEST_CAP = 200;

/** The kinds an acknowledgement may name — derived from the delivery map so it cannot drift. */
const ACK_KINDS: ReadonlySet<string> = new Set<string>(HANDLED_EVENTS.values());

function isAckKind(value: unknown): value is PendingKind {
  return typeof value === "string" && ACK_KINDS.has(value);
}

export function disabledMarkerKey(address: string): string {
  return `${DISABLED_KEY_PREFIX}/${normalizeWebhookAddress(address)}`;
}

export function purgeLedgerKey(source: string, address: string): string {
  if (!isValidSource(source)) throw new Error("Invalid webhook source");
  return `${PURGED_KEY_PREFIX}/${source}/${normalizeWebhookAddress(address)}`;
}

export function corruptPurgeLedgerKey(source: string, address: string): string {
  if (!isValidSource(source)) throw new Error("Invalid webhook source");
  return `${CORRUPT_PURGED_KEY_PREFIX}/${source}/${normalizeWebhookAddress(address)}`;
}

/**
 * §3.6 rule 3: the durable half of revocation. An in-process abort flag dies with a CVM
 * restart mid-revocation, so the teardown's FIRST durable act is this marker, and the drain
 * treats "delegation stored but no *enabled* config" as revoked.
 */
export interface DisabledMarker {
  revokedAt: string;
  source: string | null;
}

/** §6.2's ledger value. `purgedThrough` is authoritative; `recentIds` is attribution only. */
export interface PurgeLedger {
  purgedThrough: string;
  recentIds: string[];
  updatedAt: string;
}

/**
 * A ledger read is a three-way answer, not a value-or-null. §6.2 makes the ledger an
 * AUTHORIZATION input and requires the drain to FAIL CLOSED on an unreadable one: reading an
 * unparseable value as "empty" means "nothing was ever purged", the most dangerous available
 * interpretation. A thrown error and an unparseable value must therefore stay distinguishable
 * from a genuinely absent ledger all the way to the caller.
 */
export type PurgeLedgerRead =
  | { status: "absent" }
  | { status: "ok"; ledger: PurgeLedger }
  | { status: "unparseable"; raw: unknown };

/** The slice of the control store the companions (and, later, the drain) use. */
export interface ConnectorControl {
  readDisabled(address: string): Promise<DisabledMarker | null>;
  markDisabled(address: string, source: string | null): Promise<void>;
  clearDisabled(address: string): Promise<void>;
  readLedger(source: string, address: string): Promise<PurgeLedgerRead>;
  writeLedger(
    source: string,
    address: string,
    ledger: PurgeLedger,
  ): Promise<void>;
  clearLedger(source: string, address: string): Promise<void>;
  quarantineLedger(
    source: string,
    address: string,
    raw: unknown,
  ): Promise<void>;
}

function parseDisabledMarker(raw: unknown): DisabledMarker | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    return null;
  const value = raw as Record<string, unknown>;
  const revokedAt =
    typeof value.revokedAt === "string" &&
    Number.isFinite(Date.parse(value.revokedAt))
      ? value.revokedAt
      : null;
  if (revokedAt === null) return null;
  return {
    revokedAt,
    source: isValidSource(value.source) ? value.source : null,
  };
}

function parsePurgeLedger(raw: unknown): PurgeLedger | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    return null;
  const value = raw as Record<string, unknown>;
  if (
    typeof value.purgedThrough !== "string" ||
    !Number.isFinite(Date.parse(value.purgedThrough))
  ) {
    return null;
  }
  if (!Array.isArray(value.recentIds)) return null;
  // A single bad id does not invalidate the watermark, but it must not survive into the
  // ledger either — it would be compared against a `source_id` at drain time.
  const recentIds = value.recentIds.filter((id): id is string =>
    isValidMeetingId(id),
  );
  return {
    purgedThrough: value.purgedThrough,
    recentIds: recentIds.slice(-PURGE_RECENT_ID_CAP),
    updatedAt:
      typeof value.updatedAt === "string" &&
      Number.isFinite(Date.parse(value.updatedAt))
        ? value.updatedAt
        : value.purgedThrough,
  };
}

/**
 * Backend-KV state owned by the companions: the §3.6 disabled marker and the §6.2 purge
 * ledger. Every node call runs through one per-instance lane — TinyCloud drops concurrent
 * responses on a single space (§9.3).
 */
export class ConnectorControlStore implements ConnectorControl {
  private lane: Promise<unknown> = Promise.resolve();

  constructor(private readonly node: TinyCloudNode) {}

  async readDisabled(address: string): Promise<DisabledMarker | null> {
    return parseDisabledMarker(
      await this.run(() => this.readJson(disabledMarkerKey(address))),
    );
  }

  async markDisabled(address: string, source: string | null): Promise<void> {
    const marker: DisabledMarker = {
      revokedAt: new Date().toISOString(),
      source,
    };
    await this.run(() => this.writeJson(disabledMarkerKey(address), marker));
  }

  async clearDisabled(address: string): Promise<void> {
    await this.run(() => this.deleteKey(disabledMarkerKey(address)));
  }

  async readLedger(source: string, address: string): Promise<PurgeLedgerRead> {
    const raw = await this.run(() =>
      this.readJson(purgeLedgerKey(source, address)),
    );
    if (raw === null || raw === undefined) return { status: "absent" };
    const ledger = parsePurgeLedger(raw);
    if (ledger === null) return { status: "unparseable", raw };
    return { status: "ok", ledger };
  }

  async writeLedger(
    source: string,
    address: string,
    ledger: PurgeLedger,
  ): Promise<void> {
    await this.run(() =>
      this.writeJson(purgeLedgerKey(source, address), ledger),
    );
  }

  async clearLedger(source: string, address: string): Promise<void> {
    await this.run(() => this.deleteKey(purgeLedgerKey(source, address)));
  }

  /** §6.2 extends §5.3's quarantine to the ledger: preserve the raw value, never read it as empty. */
  async quarantineLedger(
    source: string,
    address: string,
    raw: unknown,
  ): Promise<void> {
    await this.run(() =>
      this.writeJson(corruptPurgeLedgerKey(source, address), raw),
    );
  }

  private async readJson(key: string): Promise<unknown> {
    // §9.3 read-side hardening: the SDK now resolves `{ok:false,error}` on a durable KV read
    // failure. Without `assertKvResult` here, a rejected read casts to `undefined` and the
    // caller sees `null` — which `readDisabled` treats as "not revoked" (fails §3.6 rule 5
    // OPEN) and `readLedger` returns as `{status:'absent'}` (fails the §6.2 tombstone OPEN —
    // "read an unreadable ledger as empty" is the exact reading the comment forbids). Mirror
    // the write path (writeJson below) and delegation-store.ts:61-64 — the assertion runs
    // INSIDE `withSessionRefresh` so a session-class Result still rides the single retry.
    const result = await withSessionRefresh(this.node, async () => {
      const r = await this.node.kv.get(key);
      if (isKvMissingKeyResult(r, key)) return null;
      return assertKvResult(r);
    });
    const response = (result as { data?: unknown } | null)?.data as
      | { data?: unknown }
      | null
      | undefined;
    if (response === null || response === undefined) return null;
    const raw = (response as { data?: unknown }).data ?? response;
    if (typeof raw !== "string") return raw ?? null;
    try {
      return JSON.parse(raw);
    } catch {
      // Carried out verbatim so the caller can quarantine it (§6.2) — never read as empty.
      return raw;
    }
  }

  private async writeJson(key: string, value: unknown): Promise<void> {
    // §9.3 durable-Result contract: the SDK resolves `{ok:false,error}` on a durable KV failure
    // instead of rejecting. Accepting that silently ships a companion 200 for a marker or ledger
    // write that never landed, and the drain trusts these writes as ground truth — so the shape
    // is re-thrown INSIDE `withSessionRefresh` (matches `connector-queue.ts` + `delegation-store.ts`),
    // where a session-class Result surfaces as a session-matching Error and the single-refresh
    // retry still applies.
    await withSessionRefresh(this.node, async () => {
      const result = await this.node.kv.put(key, value);
      assertKvResult(result);
    });
  }

  private async deleteKey(key: string): Promise<void> {
    await withSessionRefresh(this.node, async () => {
      const result = await this.node.kv.delete(key);
      if (isKvMissingKeyResult(result, key)) return;
      assertKvResult(result);
    });
  }

  /** §9.3 — storage calls are sequential across the whole instance, never concurrent. */
  private run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.lane.then(fn, fn);
    this.lane = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}

/**
 * §3.6 rule 3's in-process half: the running drain checks this between items and drops out.
 * Clearing the queue is not enough — the item currently in flight is the one that matters.
 * The durable marker above is what survives a restart; this is what stops the drain NOW.
 */
export class ConnectorDrainAbortFlags {
  private readonly aborted = new Set<string>();

  constructor(private readonly maxEntries = 10_000) {}

  abort(address: string): void {
    const key = normalizeWebhookAddress(address);
    if (this.aborted.size >= this.maxEntries && !this.aborted.has(key)) {
      const oldest = this.aborted.values().next();
      if (!oldest.done) {
        this.aborted.delete(oldest.value);
        // No silent caps. Safe to lose: the durable marker (§3.6 rule 3) is authoritative.
        logWebhookWarn(`op=abort-evict reason=cap cap=${this.maxEntries}`);
      }
    }
    this.aborted.add(key);
  }

  clear(address: string): void {
    this.aborted.delete(normalizeWebhookAddress(address));
  }

  isAborted(address: string): boolean {
    return this.aborted.has(normalizeWebhookAddress(address));
  }

  size(): number {
    return this.aborted.size;
  }
}

/** One per process — the drain (W5) and the teardown must see the same flags. */
export const connectorDrainAbort = new ConnectorDrainAbortFlags();

// ── Injected slices (each the minimum the companions need) ───────────

export interface WebhookConfigService {
  config(address: string): Promise<WebhookConfigRecord | null>;
  mint(
    address: string,
    source: string,
  ): Promise<{
    token: string;
    record: WebhookTokenRecord;
    rotatedFrom: string | null;
  }>;
  rotate(
    address: string,
    source: string,
  ): Promise<{
    token: string;
    record: WebhookTokenRecord;
    rotatedFrom: string | null;
  }>;
  revoke(address: string): Promise<void>;
}

export interface CompanionQueue {
  list(source: string, address: string): Promise<PendingItem[]>;
  dead(source: string, address: string): Promise<DeadItem[]>;
  /**
   * F010: returns what it deleted. The teardown reports that number verbatim rather than a
   * `list()` taken a round trip earlier — a count taken outside the clear's lock undercounts
   * anything enqueued in between and reads as "nothing was left behind" when something was.
   */
  clear(source: string, address: string): Promise<ClearResult>;
  /** §4.7 shape C: the browser's "I stored this exact id" settlement. See `POST /ack`. */
  acknowledge(
    source: string,
    address: string,
    acks: AcknowledgeInput[],
  ): Promise<AcknowledgeResult[]>;
}

export interface ConnectorCompanionOptions {
  tokens: WebhookConfigService;
  queue: CompanionQueue;
  control: ConnectorControl;
  /**
   * OPTION C: there is deliberately NO `delegations` collaborator here. The teardown used to
   * take `DelegationStore.remove` + `DelegationCache.evict` as steps 3 and 4 — the app's
   * unrelated chat delegation, removed because an optional connector was switched off. The
   * server holds no connector delegation to tear down, so the teardown touches none.
   */
  limiters: Pick<ConnectorWebhookLimiters, "deliveriesAreRateLimited">;
  abort?: ConnectorDrainAbortFlags;
  registry?: ReadonlySet<string>;
  now?: () => number;
  /**
   * `CONNECTOR_WEBHOOK_PUBLIC_ORIGIN` — the public HTTPS origin every minted callback URL must
   * carry. Omitted (local QA, tests) the host stays request-derived; see {@link deliveryUrl}.
   * A malformed value throws HERE, at construction, rather than minting dead webhooks.
   */
  publicOrigin?: string;
  /**
   * W1 — the per-address ingest mode (backend-ingest plan §5.3 "Changed"). ABSENT means every
   * address is Option C, which is also what the service answers with the flag dark; the option
   * exists so a harness can leave the collaborator out entirely and prove that.
   *
   * For a COHORT address the browser is no longer the queue's consumer — W3's fetch worker is,
   * and it is the SOLE one. So `POST /drain` runs no drain pass and surfaces nothing, `POST
   * /ack` is an idempotent no-op, and `GET /pending` surfaces nothing: two consumers settling
   * the same items is the double-drain race, and a browser that "acks" an item the worker has
   * not fetched deletes it. Non-cohort behaviour is byte-identical.
   *
   * A mode read that FAILS blocks the route (503) rather than falling back to the browser path —
   * see `IngestModeService`'s fail-closed note. Guessing "browser" is precisely the race.
   */
  modes?: IngestModeLookup;
  /**
   * §5.4 trigger 3 (user visit). When ABSENT the route answers 503 rather than a 200 that would
   * read as "nothing pending" — the silence §4.4 forbids. The production wiring in `index.ts`
   * always provides it (`connectorWebhooks.drain.kick`); only a test harness leaves it out.
   *
   * Its result is the SURFACING AUTHORITY (§12a R3): a hook that returns anything this route
   * cannot read as `{status:"ok", surfaced}` surfaces nothing. See {@link drainOutcome}.
   */
  drain?: (input: {
    source: string;
    address: string;
  }) => Promise<CompanionDrainOutcome | unknown>;
}

/**
 * State a handler has ALREADY read, handed to `pendingPayload` so the response is not paid for
 * a second time.
 *
 * `POST /ack` reads the config, the disabled marker, the purge ledger and the pending list to
 * decide what to settle, and `pendingPayload` then read all four again to build the answer: ten
 * node round trips for one call, five of them a pure duplicate. The companion bucket is 600
 * requests/15 min/IP and exempt from `globalLimiter`, so that doubling is an amplification
 * factor aimed at the single-writer node every tenant shares — the same class
 * `connector-drain.ts`'s `forcedMinIntervalMs` exists to close.
 *
 * Passing this is a claim the caller must have earned: the ledger's fail-closed arms
 * (unparseable / throwing) are the CALLER's to apply before it prefetches, because a prefetched
 * `ledger: null` is indistinguishable from "nothing was ever purged".
 */
interface PendingPrefetch {
  config: WebhookConfigRecord | null;
  marker: DisabledMarker | null;
  /** `null` means ABSENT, never "unreadable" — see above. */
  ledger: PurgeLedger | null;
  /** The pending list, already reflecting whatever the caller settled. */
  items?: PendingItem[];
}

/** The one registry entry today; a body may name any registered source explicitly. */
export const DEFAULT_CONNECTOR_SOURCE = "fireflies";

interface SessionUser {
  address: string;
}

function requireUser(req: Request, res: Response): SessionUser | null {
  const address = req.user?.address;
  if (typeof address !== "string") {
    res
      .status(401)
      .json({ error: "unauthenticated", message: "Authentication required" });
    return null;
  }
  return { address };
}

function bodyOf(req: Request): Record<string, unknown> {
  const body = req.body;
  if (
    typeof body !== "object" ||
    body === null ||
    Array.isArray(body) ||
    Buffer.isBuffer(body)
  ) {
    return {};
  }
  return body as Record<string, unknown>;
}

/**
 * The URL the user pastes into their Fireflies dashboard.
 *
 * This string is the whole delivery path: a wrong host or an `http://` scheme produces a webhook
 * that silently never delivers, with no server-side signal that anything is wrong. It used to be
 * derived entirely from the request — `req.get("host")`, which the client supplies, plus
 * `req.protocol`, which honours `X-Forwarded-Proto` under `trust proxy 1` — and pinned to
 * nothing. That is safe against *cross-user* mischief (the value is echoed to the authenticated
 * caller alone, so a spoofed Host misleads nobody but its sender) but it is not correct: the one
 * host that must appear here is the public HTTPS callback domain.
 *
 * So `CONNECTOR_WEBHOOK_PUBLIC_ORIGIN` pins it. When set, it is the origin, whatever the request
 * says; a malformed value fails at construction rather than minting dead webhooks (the same
 * fail-closed treatment `WEBHOOK_HMAC_MASTER` gets). When unset — local QA, the tests — the host
 * is still request-derived, but the scheme is forced to `https` for any routable host, because
 * Fireflies accepts no other and an `http://` callback (a plain hop behind the proxy, a spoofed
 * `X-Forwarded-Proto`) is never the right string to paste. LOOPBACK is the one exception: no
 * provider can reach `localhost`, so a loopback URL is a local harness's own delivery address
 * and forcing a scheme its server does not speak would only break it.
 *
 * The deploy-time verification that the pinned origin is the REAL public origin is a separate,
 * out-of-scope step; this is the code-level pin, not the probe.
 */
const HOST_PATTERN = /^[A-Za-z0-9.-]+(:\d{1,5})?$/;
/** `https://host[:port]`, no path, no trailing slash, no credentials or query. */
const PUBLIC_ORIGIN_PATTERN = /^https:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/;
/** Hosts no provider can deliver to, so their scheme is the local harness's business. */
const LOOPBACK_PATTERN = /^(localhost|127(\.\d{1,3}){3}|\[::1\])(:\d{1,5})?$/i;

/** Throws on a malformed pin — a typo here is a fleet of webhooks that never deliver. */
function validatePublicOrigin(origin: string | undefined): string | null {
  if (origin === undefined) return null;
  const trimmed = origin.trim();
  if (trimmed === "") return null;
  if (!PUBLIC_ORIGIN_PATTERN.test(trimmed)) {
    throw new Error(
      "CONNECTOR_WEBHOOK_PUBLIC_ORIGIN must be an https origin with no path, e.g. https://api.tinycloud.chat",
    );
  }
  return trimmed;
}

function deliveryUrl(
  req: Request,
  source: string,
  token: string,
  publicOrigin: string | null,
): string {
  const path = `/api/connectors/webhooks/${source}/${token}`;
  if (publicOrigin !== null) return `${publicOrigin}${path}`;
  const header = req.get("host") ?? "";
  const host = HOST_PATTERN.test(header) ? header : req.hostname;
  const scheme = LOOPBACK_PATTERN.test(host) ? req.protocol : "https";
  return `${scheme}://${host}${path}`;
}

interface ConfigPayload {
  enabled: boolean;
  disabledAt: string | null;
  source: string | null;
  url: string | null;
  /** Returned by the MINT/ROTATE response only; `null` on every poll. See `configPayload`. */
  secret: string | null;
  /** Whether a secret exists, so the card can render without ever re-reading the value. */
  hasSecret: boolean;
  createdAt: string | null;
}

/**
 * What the companion routes read back off a drain (§4.7 / §12a R3): `ConnectorDrainWorker`'s
 * `DrainResult` satisfies it structurally.
 */
export interface CompanionDrainOutcome {
  status: "ok" | "aborted";
  reason?: string;
  surfaced: string[];
}

/**
 * Normalize a drain hook's return value, FAILING CLOSED on anything it cannot read. A hook that
 * reports nothing is not evidence that surfacing is authorized — under B the drain's verdict is
 * the only thing standing between a tombstoned id and the client that would re-create it.
 */
function drainOutcome(raw: unknown): CompanionDrainOutcome {
  if (typeof raw !== "object" || raw === null) {
    return { status: "aborted", reason: "drain_unreported", surfaced: [] };
  }
  const value = raw as {
    status?: unknown;
    reason?: unknown;
    surfaced?: unknown;
  };
  if (value.status !== "ok") {
    return {
      status: "aborted",
      reason: typeof value.reason === "string" ? value.reason : "drain_aborted",
      surfaced: [],
    };
  }
  return {
    status: "ok",
    surfaced: Array.isArray(value.surfaced)
      ? value.surfaced.filter((id): id is string => isValidMeetingId(id))
      : [],
  };
}

function pendingView(item: PendingItem) {
  return {
    meetingId: item.meetingId,
    kind: item.kind,
    receivedAt: item.receivedAt,
    attempts: item.attempts,
    nextAttemptAt: item.nextAttemptAt,
    ...(item.lastError === undefined ? {} : { lastError: item.lastError }),
  };
}

/**
 * The authenticated companion router. Mounted at `/api/connectors/webhooks` behind
 * `authMiddleware` and the companion rate-limit bucket; every path below is ONE segment deep.
 */
export function createConnectorWebhookCompanionRouter(
  options: ConnectorCompanionOptions,
): Router {
  const { tokens, queue, control, limiters } = options;
  const registry = options.registry ?? CONNECTOR_REGISTRY;
  const abort = options.abort ?? connectorDrainAbort;
  const now = options.now ?? (() => Date.now());
  const publicOrigin = validatePublicOrigin(options.publicOrigin);
  const router = Router();

  /**
   * W1 — is this address's queue owned by the backend fetch worker? With no `modes`
   * collaborator, or with the flag dark, this is a pure `false` that costs the node nothing.
   * It REJECTS on an unreadable cohort; every caller lets that reach its 503 arm.
   */
  async function backendIngest(address: string): Promise<boolean> {
    if (!options.modes) return false;
    return (await options.modes.mode(address)) === "backend";
  }

  /** A body-supplied source is validated against the registry before any KV call. */
  function namedSourceIsInvalid(raw: unknown): boolean {
    if (raw === undefined || raw === null) return false;
    return !isValidSource(raw) || !registry.has(raw);
  }

  /**
   * §3.8/T11 describe the delivery secret as "shown once in the UI behind a reveal", so it is
   * returned by the MINT/ROTATE response and nowhere else. `GET /config` used to include it in
   * full on every poll, which made any session-scoped read — a stolen session, an XSS on the
   * frontend origin — yield the delivery secret; and because it is `HKDF(master, source:token)`
   * it cannot be rotated without rotating the token. The route is authenticated, CSRF'd and
   * behind the CORS allowlist, so this is a hardening gap rather than a live hole — but the
   * value has no reason to ride a poll. `hasSecret` is what the card actually needs.
   */
  function configPayload(
    req: Request,
    config: WebhookConfigRecord | null,
    marker: DisabledMarker | null,
    revealSecret = false,
  ): ConfigPayload {
    if (config === null) {
      return {
        enabled: false,
        disabledAt: marker?.revokedAt ?? null,
        source: null,
        url: null,
        secret: null,
        hasSecret: false,
        createdAt: null,
      };
    }
    return {
      // A marker standing over a surviving config is a crash artifact of the teardown, and
      // the drain classifies it as revoked (§3.6 rule 5). The card must agree.
      enabled: marker === null,
      disabledAt: marker?.revokedAt ?? null,
      source: config.source,
      url: deliveryUrl(req, config.source, config.token, publicOrigin),
      secret: revealSecret
        ? deriveWebhookSecret(config.source, config.token)
        : null,
      hasSecret: true,
      createdAt: config.createdAt,
    };
  }

  /**
   * §4.7 / §6.2 / §12a R3 — THE SURFACING GATE.
   *
   * Under ingest shape B the drain writes nothing; the id list it hands back is what turns a
   * delivery into a meeting, so **surfacing an id resurrects the meeting just as surely as a
   * write would**. Every rule the drain applies to writing therefore applies here to surfacing,
   * and it applies at the ROUTES, because these are the two places an id actually reaches a
   * client. Before this gate existed, `POST /drain` returned `queue.list()` regardless of the
   * drain's verdict — a drain that aborted with `ledger_unavailable` having dropped nothing still
   * answered 200 with every pending id — and `GET /pending` never read the ledger at all, so a
   * tombstoned id was handed straight to the client.
   *
   * Fail-closed at every step: a disabled marker, an unreadable or unparseable ledger, and an
   * aborted drain all surface NOTHING and report the reason as a card state.
   */
  async function pendingPayload(
    req: Request,
    address: string,
    drain?: CompanionDrainOutcome | null,
    prefetched?: PendingPrefetch,
  ) {
    const config =
      prefetched === undefined ? await tokens.config(address) : prefetched.config;
    const marker =
      prefetched === undefined
        ? await control.readDisabled(address)
        : prefetched.marker;
    const base = {
      enabled: config !== null && marker === null,
      disabledAt: marker?.revokedAt ?? null,
      source: config?.source ?? null,
      // §4.4: a tripped per-token bucket is a card state, never silence.
      deliveriesRateLimited: limiters.deliveriesAreRateLimited(address),
    };
    const surfaceNothing = (blocked: string | null) => ({
      ...base,
      count: 0,
      pending: [] as ReturnType<typeof pendingView>[],
      deadCount: 0,
      dead: [] as Array<ReturnType<typeof pendingView> & { deadAt: string }>,
      // Never silence: the card distinguishes "nothing pending" from "we refused to tell you".
      ...(blocked === null ? {} : { surfaceBlocked: blocked }),
    });

    if (config === null) return surfaceNothing(null);
    // §3.6 rules 4/5: the durable marker is authoritative. A teardown that crashed between step 1
    // (marker) and step 5 (queue drop) leaves this user's ids queued for an account that revoked.
    if (marker !== null) return surfaceNothing("revoked");

    // W1 — the cohort gate, at the SAME choke point every other surfacing rule uses. Surfacing
    // an id is what turns a delivery into a meeting, so an address whose queue the fetch worker
    // owns must not have ids handed to the browser from ANY of the three routes that reach this
    // helper. Told, not silenced: the reason rides back as a card state (W5 gives the cohort its
    // own meetings view; until then the card says "this is not yours to drain", not "empty").
    if (await backendIngest(address)) return surfaceNothing("backend_ingest");

    // §6.2: the ledger is an AUTHORIZATION input and FAILS CLOSED. An unparseable value read as
    // an empty ledger means "nothing was ever purged" — the most dangerous available reading.
    // Quarantine is a WRITE and belongs to the drain and the purge route, not to a GET.
    let ledger: PurgeLedger | null = null;
    if (prefetched !== undefined) {
      // The caller already made this read AND already applied its fail-closed
      // arm (an unparseable/throwing ledger never reaches a prefetched call).
      ledger = prefetched.ledger;
    } else {
      try {
        const read = await control.readLedger(config.source, address);
        if (read.status === "unparseable")
          return surfaceNothing(LEDGER_UNAVAILABLE);
        if (read.status === "ok") ledger = read.ledger;
      } catch (error) {
        console.warn(
          "[connector-webhook] purge ledger read failed:",
          redactedErrorMessage(error),
        );
        return surfaceNothing(LEDGER_UNAVAILABLE);
      }
    }

    // An aborted drain dropped nothing and authorized nothing — `revoked`, `ledger_unavailable`
    // and `delegation_unusable` all abort BEFORE the tombstone loop runs.
    if (drain != null && drain.status !== "ok") {
      return surfaceNothing(drain.reason ?? "drain_aborted");
    }

    // Sequential: TinyCloud drops concurrent responses on one space (§9.3).
    const items =
      prefetched?.items ?? (await queue.list(config.source, address));
    const dead = await queue.dead(config.source, address);
    // The same §6.1 step -1 rule the drain applies, on both lists: a purged id must not reach the
    // client through the dead-letter view either.
    const live = items.filter((item) => !isTombstoned(item, ledger));
    const liveDead = dead.filter((item) => !isTombstoned(item, ledger));
    // After a drain, surface only what THAT drain released. It stopped where it stopped (a
    // mid-pass revocation breaks out of the loop), so its own list is the authority.
    const released = drain == null ? null : new Set(drain.surfaced);
    const pending =
      released === null
        ? live
        : live.filter((item) => released.has(item.meetingId));

    return {
      ...base,
      count: pending.length,
      pending: pending.map(pendingView),
      deadCount: liveDead.length,
      // §5.3: the dead-letter is surfaced here so the user and the operator can see it.
      dead: liveDead.map((item) => ({
        ...pendingView(item),
        deadAt: item.deadAt,
      })),
    };
  }

  router.get("/config", async (req: Request, res: Response) => {
    const user = requireUser(req, res);
    if (!user) return;
    try {
      const config = await tokens.config(user.address);
      const marker = await control.readDisabled(user.address);
      res.json(configPayload(req, config, marker));
    } catch (error) {
      logWebhookWarn(
        `op=config-read result=error aid=${hashedField(user.address)}`,
      );
      console.warn(
        "[connector-webhook] config read failed:",
        redactedErrorMessage(error),
      );
      res.status(503).json({ error: "unavailable" });
    }
  });

  /**
   * Enable (and rotate). §3.6 rule 6: enable's FIRST durable action idempotently clears the
   * pending queue, the dead-letter and the abort flag for that `(source, address)`, so
   * re-enabling never replays the off-window — the teardown drops the queue LAST (correct for
   * crash-classification) and the user's Fireflies dashboard still holds the URL while the
   * teardown is in flight. It does NOT clear the purge ledger; only §4.8's DELETE does.
   */
  router.post("/config", async (req: Request, res: Response) => {
    const user = requireUser(req, res);
    if (!user) return;

    const body = bodyOf(req);
    if (namedSourceIsInvalid(body.source)) {
      res.status(400).json({ error: "unknown_source" });
      return;
    }
    const rotate = body.rotate === true;
    let source = DEFAULT_CONNECTOR_SOURCE;

    try {
      const existing = await tokens.config(user.address);
      const marker = await control.readDisabled(user.address);
      source = isValidSource(body.source)
        ? body.source
        : (existing?.source ?? DEFAULT_CONNECTOR_SOURCE);
      if (!registry.has(source)) {
        res.status(400).json({ error: "unknown_source" });
        return;
      }
      // "Enabling" is the transition, not every POST: a POST while already enabled must not
      // drop a queue full of this user's legitimately pending deliveries.
      const enabling = existing === null || marker !== null;
      // Registry-parameterized (§4.1): naming a different source is a re-mint, not a read.
      const switchingSource = existing !== null && existing.source !== source;

      if (enabling) {
        abort.clear(user.address);
        await queue.clear(source, user.address);
        await control.clearDisabled(user.address);
      } else if (switchingSource && existing !== null) {
        // F006: the switch rotates onto the NEW source, and every companion read follows
        // `config.source` — so without this the old source's pending items become invisible
        // and sit in KV until the 14-day TTL, spending write budget on a queue no drain can
        // reach. The OLD source is cleared, not the new one: this is not an enable transition
        // (the marker is not standing and the user's live queue for the source they are
        // switching TO, if any, is theirs to keep).
        await queue.clear(existing.source, user.address);
      }

      if (!enabling && !rotate && !switchingSource) {
        // Nothing was minted, so nothing is revealed: this arm is a poll in POST's clothing.
        res.json({
          status: "enabled",
          rotated: false,
          ...configPayload(req, existing, null),
        });
        return;
      }

      const minted =
        existing !== null
          ? await tokens.rotate(user.address, source)
          : await tokens.mint(user.address, source);
      const config: WebhookConfigRecord = {
        token: minted.token,
        source,
        createdAt: minted.record.createdAt,
      };
      logWebhook(
        `op=enable source=${source} aid=${hashedField(user.address)} ` +
          `rotated=${minted.rotatedFrom !== null} queue_cleared=${enabling} ` +
          `switched_from=${switchingSource ? (existing?.source ?? "-") : "-"}`,
      );
      res.json({
        status: "enabled",
        rotated: minted.rotatedFrom !== null,
        // The one response that carries the secret: this is the mint/rotate the user asked for.
        ...configPayload(req, config, null, true),
      });
    } catch (error) {
      logWebhookWarn(
        `op=enable result=error source=${source} aid=${hashedField(user.address)}`,
      );
      console.warn(
        "[connector-webhook] enable failed:",
        redactedErrorMessage(error),
      );
      res.status(503).json({ error: "unavailable" });
    }
  });

  /**
   * The SINGLE idempotent teardown (§3.6 rule 1), in the NORMATIVE ORDER:
   *
   *   (1) durable disabled marker → (2) config delete (+ token delete, token-cache evict)
   *   → (3) queue drop.
   *
   * The marker goes first so every crash point below it leaves a state the drain classifies as
   * REVOKED; the reverse order leaves an enabled config over torn-down state, which §3.7's
   * silent renewer reads as *expired* and repairs by re-minting. One call, not two, for the
   * same reason: a second client call that never happens leaves a half-disabled connector.
   *
   * OPTION C removed what were steps 3 and 4 — `delegations.remove` + `delegations.evict`.
   * Those tore down the app's GENERIC backend delegation, the one every authenticated TinyChat
   * write depends on, because an optional notification connector was switched off. The server
   * holds no connector delegation (it queues meeting ids; the browser fetches and writes), so
   * there is nothing here to revoke. Turning Fireflies webhooks off must not log a user out of
   * their own space — see `connector-delegation-independence.test.ts`.
   */
  router.delete("/config", async (req: Request, res: Response) => {
    const user = requireUser(req, res);
    if (!user) return;

    // In-process and free, so it goes first: it stops the drain that is running right now,
    // between items, rather than after it has written the rest of the queue.
    abort.abort(user.address);

    try {
      const existing = await tokens.config(user.address);
      // F006: EVERY registered source, always — not just the configured one. A queue left by
      // another source (a source switch that crashed between the rotate and its clear, or an
      // earlier stint on that source) is invisible to every companion read, because they all
      // follow `config.source`. Disconnect must mean disconnected. The configured source goes
      // first (it is the one with items), and it is included even if it has since left the
      // registry, so a config minted under an older registry is still torn down.
      const configured = existing?.source ?? null;
      const sources = [
        ...(configured !== null ? [configured] : []),
        ...[...registry].filter((source) => source !== configured),
      ];

      await control.markDisabled(user.address, configured); // (1)
      await tokens.revoke(user.address); // (2) config + token keys, and the token cache

      // (3) F010: the count comes from the clear itself. `list()`-then-`clear()` reported a
      // number taken one round trip before the delete, so anything enqueued in between was
      // dropped without being counted and `queueDropped` read as an exact total when it was a
      // lower bound. It also cost a second node read per source.
      let dropped = 0;
      for (const source of sources) {
        const { cleared } = await queue.clear(source, user.address);
        dropped += cleared;
      }

      logWebhook(
        `op=disable aid=${hashedField(user.address)} queue_dropped=${dropped} ` +
          `sources=${sources.join("|") || "-"}`,
      );
      res.json({ status: "disabled", queueDropped: dropped });
    } catch (error) {
      // The marker is written first, so a failure here has already classified the address as
      // revoked. 503 asks the client to retry the same idempotent call — it never asks it to
      // run a second, different one.
      logWebhookWarn(
        `op=disable result=error aid=${hashedField(user.address)}`,
      );
      console.warn(
        "[connector-webhook] teardown failed:",
        redactedErrorMessage(error),
      );
      res.status(503).json({ error: "teardown_incomplete" });
    }
  });

  router.get("/pending", async (req: Request, res: Response) => {
    const user = requireUser(req, res);
    if (!user) return;
    try {
      res.json(await pendingPayload(req, user.address));
    } catch (error) {
      logWebhookWarn(
        `op=pending result=error aid=${hashedField(user.address)}`,
      );
      console.warn(
        "[connector-webhook] pending read failed:",
        redactedErrorMessage(error),
      );
      res.status(503).json({ error: "unavailable" });
    }
  });

  /** §5.4 trigger 3 — the path that works when the *stored* delegation is dead but the user is here. */
  router.post("/drain", async (req: Request, res: Response) => {
    const user = requireUser(req, res);
    if (!user) return;

    try {
      const config = await tokens.config(user.address);
      const marker = await control.readDisabled(user.address);
      if (config === null || marker !== null) {
        // Nothing to drain for a disabled address, and a drain must never be the thing that
        // resurrects one: the marker is authoritative (§3.6 rule 4).
        res.json(await pendingPayload(req, user.address));
        return;
      }

      // W1: a cohort address's queue belongs to the fetch worker. No drain pass runs — not even
      // a read-only one — because a second consumer is the double-drain race §5.3 excludes, and
      // the ids go nowhere (`pendingPayload` applies the same gate).
      if (await backendIngest(user.address)) {
        logWebhook(
          `op=drain result=backend_ingest source=${config.source} ` +
            `aid=${hashedField(user.address)}`,
        );
        res.json(
          await pendingPayload(req, user.address, null, {
            config,
            marker,
            ledger: null,
          }),
        );
        return;
      }

      if (!options.drain) {
        logWebhookWarn(
          `op=drain result=unavailable aid=${hashedField(user.address)}`,
        );
        res.status(503).json({ error: "drain_unavailable" });
        return;
      }

      const outcome = drainOutcome(
        await options.drain({ source: config.source, address: user.address }),
      );
      // Under ingest shape B the drain writes NOTHING to the user's space (§4.7, binding): the
      // id list goes back to the browser, which writes through v1's engine (F5). So the drain's
      // OWN verdict is what governs what may be surfaced — never `queue.list()` regardless of it.
      res.json(await pendingPayload(req, user.address, outcome));
    } catch (error) {
      logWebhookWarn(`op=drain result=error aid=${hashedField(user.address)}`);
      console.warn(
        "[connector-webhook] drain kick failed:",
        redactedErrorMessage(error),
      );
      res.status(503).json({ error: "unavailable" });
    }
  });

  /**
   * §4.7 under OPTION C — the ACKNOWLEDGEMENT / SETTLEMENT companion.
   *
   * The browser is the writer: it fetches the exact queued id with the user's own Fireflies key,
   * writes SQL + KV into the user's own space, and only THEN calls this route to say the identity
   * is done. So the route's single input is a browser ASSERTION, and every rule below follows
   * from that:
   *
   *  - Ownership is derived from the SESSION and the stored config. A body `address` is ignored
   *    and a body `source` may only CONFIRM the configured one — otherwise an authenticated user
   *    could settle (i.e. silently drop) another user's queued deliveries.
   *  - Every id and kind is validated BEFORE anything is read or written. One bad element rejects
   *    the whole batch, exactly as `POST /purged` does: these ids are compared against queue
   *    identities and a `source_id`, and the same strictness applies wherever they enter.
   *  - Only the exact `(meetingId, kind)` identities named are removed. A `meeting.summarized`
   *    item is a DISTINCT identity from its transcript and survives its sibling's ack.
   *  - Acking an identity that is already gone is a SUCCESS. The browser stores the meeting and
   *    then acks; if the response is lost it retries, and a retry that 4xx'd (or, worse, re-queued)
   *    would leave the queue unable to drain without duplicating the meeting.
   *  - The §3.6 disabled marker and the §6.2 purge ledger are re-applied HERE. An ack is the last
   *    point at which revoked or tombstoned work could be re-classified as legitimately ingested,
   *    and both fail closed: nothing is settled and the card gets `surfaceBlocked`.
   *  - SUCCESSES ONLY, in this first version. A browser-reported terminal failure stays queued
   *    until the retry schedule or the 14-day TTL deals with it, because a `failed` ack would let
   *    the browser drive `attempts`/dead-lettering on its own queue — and its error string would
   *    have to become a log field, which §6.3 does not allow without a strict enum. `status` is
   *    therefore accepted only as the literal `"done"`; anything else is a 400 and no
   *    browser-supplied string is read, logged or stored.
   *
   * It mounts ONE segment deep, on the companion rate-limit bucket (§4.4) — never `globalLimiter`,
   * which `/api/chat` shares, and never the public route's token buckets.
   */
  router.post("/ack", async (req: Request, res: Response) => {
    const user = requireUser(req, res);
    if (!user) return;

    const body = bodyOf(req);
    if (namedSourceIsInvalid(body.source)) {
      res.status(400).json({ error: "unknown_source" });
      return;
    }

    const raw = body.items;
    if (
      !Array.isArray(raw) ||
      raw.length === 0 ||
      raw.length > ACK_ITEMS_PER_REQUEST_CAP
    ) {
      res.status(400).json({
        error: "invalid_body",
        message: `items must be a non-empty array of at most ${ACK_ITEMS_PER_REQUEST_CAP} entries`,
      });
      return;
    }

    // Validation is complete BEFORE the first node call: a rejected batch costs the shared
    // single-writer node nothing, and nothing is half-settled.
    const acks: AcknowledgeInput[] = [];
    const seen = new Set<string>();
    for (const entry of raw) {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        res.status(400).json({
          error: "invalid_body",
          message: "each item must be an object",
        });
        return;
      }
      const item = entry as Record<string, unknown>;
      if (!isValidMeetingId(item.meetingId)) {
        logWebhook(
          `op=ack result=invalid_meeting_id aid=${hashedField(user.address)}`,
        );
        res.status(400).json({ error: "invalid_meeting_id" });
        return;
      }
      if (!isAckKind(item.kind)) {
        res.status(400).json({ error: "invalid_kind" });
        return;
      }
      // The one accepted assertion. Note what is NOT read: no `error`, no `lastError`, no
      // `attempts` — a browser-supplied string never becomes an operational field (§6.3).
      if (item.status !== undefined && item.status !== "done") {
        res.status(400).json({ error: "unsupported_ack_status" });
        return;
      }
      const identity = `${item.kind}:${item.meetingId}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      acks.push({ meetingId: item.meetingId, kind: item.kind });
    }

    try {
      const config = await tokens.config(user.address);
      const marker = await control.readDisabled(user.address);

      // Every arm below hands `pendingPayload` the state THIS handler already read: the route
      // answers with the caller's own queue snapshot, and re-reading four keys to describe the
      // state we just acted on is the amplification {@link PendingPrefetch} exists to stop.
      const settled = async (
        acknowledged: number,
        alreadySettled: number,
        tombstoned: number,
        // `null` = "do not reuse my reads": the ledger arm below is the one case where what this
        // handler read is precisely what must NOT be trusted to build the answer.
        prefetched: PendingPrefetch | null,
      ) => {
        res.json({
          ...(await pendingPayload(req, user.address, null, prefetched ?? undefined)),
          status: "acknowledged",
          acknowledged,
          alreadySettled,
          tombstoned,
        });
      };

      if (config === null) {
        // Background sync was never enabled, or the teardown already dropped the queue. There is
        // nothing to settle and nothing to create — the idempotent no-op, not a 4xx.
        await settled(0, acks.length, 0, { config, marker, ledger: null });
        return;
      }

      // §3.6 rules 4/5: the durable marker is authoritative and an ack must not be the thing that
      // reads through it. The teardown drops the queue itself; settling against a revoked address
      // would classify work the user revoked as ingested.
      if (marker !== null) {
        logWebhook(
          `op=ack result=revoked source=${config.source} aid=${hashedField(user.address)}`,
        );
        // `pendingPayload` surfaces NOTHING for a standing marker, so no queue read is reached.
        await settled(0, 0, 0, { config, marker, ledger: null });
        return;
      }

      // W1: for a cohort address the fetch worker owns the `pending`→`fetched` transition and
      // the queue removal that used to be `/drain`+`/ack`'s job. A browser ack here would delete
      // an item the worker has not fetched yet, so it is accepted as an IDEMPOTENT NO-OP — a 4xx
      // would only make a stale client retry forever, and the browser has nothing to settle.
      if (await backendIngest(user.address)) {
        logWebhook(
          `op=ack result=backend_ingest source=${config.source} ` +
            `aid=${hashedField(user.address)} submitted=${acks.length}`,
        );
        await settled(0, acks.length, 0, { config, marker, ledger: null });
        return;
      }

      // Registry-parameterized: a body source may confirm the configured one, never redirect the
      // settlement at another connector's queue.
      if (isValidSource(body.source) && body.source !== config.source) {
        res.status(400).json({ error: "unknown_source" });
        return;
      }
      const source = config.source;

      // §6.2: the ledger is an AUTHORIZATION input and FAILS CLOSED here too. Reading an
      // unreadable ledger as empty would mean "nothing was ever purged", which is exactly how a
      // tombstoned identity gets settled as though it had been legitimately stored.
      let ledger: PurgeLedger | null = null;
      let ledgerBlocked = false;
      try {
        const read = await control.readLedger(source, user.address);
        if (read.status === "unparseable") ledgerBlocked = true;
        else if (read.status === "ok") ledger = read.ledger;
      } catch (error) {
        console.warn(
          "[connector-webhook] purge ledger read failed:",
          redactedErrorMessage(error),
        );
        ledgerBlocked = true;
      }
      if (ledgerBlocked) {
        logWebhook(
          `op=ack result=${LEDGER_UNAVAILABLE} source=${source} aid=${hashedField(user.address)}`,
        );
        // Nothing settled; the items stay queued for the retry that follows the ledger repair.
        // `pendingPayload` re-reads and reports `surfaceBlocked` for the card: an unreadable
        // ledger is the one input this handler must NOT pass on as though it had an answer.
        await settled(0, 0, 0, null);
        return;
      }

      // Sequential — TinyCloud drops concurrent responses on one space (§9.3).
      const queued = await queue.list(source, user.address);
      const byIdentity = new Map(
        queued.map((item) => [`${item.kind}:${item.meetingId}`, item] as const),
      );

      // §6.1 step -1, applied to SETTLEMENT: a tombstoned identity is not settled. The server
      // cannot un-write whatever the browser did, but it must not record purged work as ingested,
      // and the item is never surfaced again anyway — the TTL sweep is what finally clears it.
      //
      // Only identities the snapshot ACTUALLY HELD are settled. The snapshot is read outside
      // `acknowledge`'s per-address lock, so an identity absent from it has never been tested
      // against the purge ledger; pushing it through anyway removed it sight-unseen, which is the
      // one way a tombstoned item could leave the queue classified as ingested. Absent means
      // already settled — the ordinary lost-response retry — and whatever landed in the window
      // stays queued for the next pass or the TTL. It also means a batch with nothing to settle
      // (the retry, and the shape an abusive caller sends) never reaches the write lock at all.
      const settleable: AcknowledgeInput[] = [];
      let tombstoned = 0;
      let alreadyGone = 0;
      for (const ack of acks) {
        const item = byIdentity.get(`${ack.kind}:${ack.meetingId}`);
        if (item === undefined) {
          alreadyGone += 1;
          continue;
        }
        if (isTombstoned(item, ledger)) {
          tombstoned += 1;
          continue;
        }
        settleable.push(ack);
      }

      const results =
        settleable.length === 0
          ? []
          : await queue.acknowledge(source, user.address, settleable);
      const acknowledged = results.filter(
        (result) => result.disposition === "removed",
      ).length;
      // A `not-queued` result here is the same "it was already gone" answer, arrived at one lock
      // later (a TTL sweep between the list and the lock).
      const alreadySettled =
        alreadyGone +
        results.filter((result) => result.disposition === "not-queued").length;

      // What the queue holds NOW, derived from the snapshot this handler already read and the
      // identities it just removed — the last of `pendingPayload`'s four duplicate reads.
      const removedIdentities = new Set(
        results
          .filter((result) => result.disposition === "removed")
          .map((result) => `${result.kind}:${result.meetingId}`),
      );
      const remaining = queued.filter(
        (item) => !removedIdentities.has(`${item.kind}:${item.meetingId}`),
      );

      logWebhook(
        `op=ack source=${source} aid=${hashedField(user.address)} ` +
          `submitted=${acks.length} settled=${acknowledged} ` +
          `already=${alreadySettled} tombstoned=${tombstoned}`,
      );
      await settled(acknowledged, alreadySettled, tombstoned, {
        config,
        marker,
        ledger,
        items: remaining,
      });
    } catch (error) {
      logWebhookWarn(`op=ack result=error aid=${hashedField(user.address)}`);
      console.warn(
        "[connector-webhook] acknowledgement failed:",
        redactedErrorMessage(error),
      );
      // 503 asks for a retry of the SAME idempotent call — settling twice is safe by design.
      res.status(503).json({ error: "unavailable" });
    }
  });

  /**
   * §4.8 — the purge notification that writes §6.2's tombstone ledger.
   *
   * The ledger is an AUTHORIZATION input (it suppresses writes), so this route carries the
   * rigour of the delegation accept route, not of a telemetry beacon: a pre-inserted
   * `source_id` tombstones a meeting before it ever arrives. The address comes from the
   * session, never the body; every id goes through the shared `isValidMeetingId()`.
   */
  router.post("/purged", async (req: Request, res: Response) => {
    const user = requireUser(req, res);
    if (!user) return;

    const body = bodyOf(req);
    if (!isValidSource(body.source) || !registry.has(body.source)) {
      res.status(400).json({ error: "unknown_source" });
      return;
    }
    const source = body.source;

    const ids = body.ids;
    if (!Array.isArray(ids)) {
      res
        .status(400)
        .json({ error: "invalid_body", message: "ids must be an array" });
      return;
    }
    // Nothing is written unless EVERY element validates: a 60 kb id, a traversal segment or a
    // non-string anywhere in the array rejects the whole call (§4.8).
    for (const id of ids) {
      if (!isValidMeetingId(id)) {
        logWebhook(
          `op=purge result=invalid_meeting_id source=${source} aid=${hashedField(user.address)}`,
        );
        res.status(400).json({ error: "invalid_meeting_id" });
        return;
      }
    }

    // §4.8: `purgedThrough` defaults to now. That default is FAIL-CLOSED and it is broad — the
    // watermark tombstones by time, so a purge of one meeting suppresses every delivery whose
    // provider stamp predates the request instant, not just the submitted ids. That is the
    // §6.2 reading ("we will not re-add a meeting you delete") and it is deliberate, but it is
    // invisible from the response, so callers that mean "these ids and no more history" must
    // send the newest stamp among them (§6.2's "max receivedAt at purge time"). Logged either
    // way so an operator can tell a targeted purge from a whole-history one.
    const requestedThrough = body.purgedThrough;
    const defaultedThrough =
      requestedThrough === undefined || requestedThrough === null;
    let purgedThroughMs = now();
    if (requestedThrough !== undefined && requestedThrough !== null) {
      const parsed =
        typeof requestedThrough === "string"
          ? Date.parse(requestedThrough)
          : Number.NaN;
      if (!Number.isFinite(parsed) || parsed > now() + PURGE_FUTURE_SKEW_MS) {
        res.status(400).json({ error: "invalid_purged_through" });
        return;
      }
      purgedThroughMs = parsed;
    }

    try {
      const config = await tokens.config(user.address);
      const marker = await control.readDisabled(user.address);
      if (config === null && marker === null) {
        // Background sync was never enabled for this address — an idempotent no-op, not a
        // reason to grow backend KV from an authenticated client.
        //
        // F007, deliberately: the guard stops HERE and does NOT extend to a REVOKED address
        // (config deleted, marker standing). That address is the second half of
        // disconnect-with-delete — the browser tears the connector down first so nothing can
        // arrive mid-delete, then reports the ids it purged — and refusing its tombstone is
        // fail-OPEN, because re-enable clears the queue but never the ledger (only
        // `DELETE /purged` does), so a dropped tombstone is a meeting that returns on
        // reconnect. The KV-growth concern does not reach it either: a marker exists only for
        // an address that enabled at least once. Pinned by connector-companions.test.ts's
        // "a REVOKED address (config gone, marker standing) still records its purge".
        logWebhook(
          `op=purge result=noop source=${source} aid=${hashedField(user.address)}`,
        );
        res.status(204).end();
        return;
      }

      const read = await control.readLedger(source, user.address);
      if (read.status === "unparseable") {
        // §6.2: quarantine, never read as empty. This POST carries the user's real purge, so
        // the watermark it writes is theirs — not a silently-restarted empty ledger.
        await control.quarantineLedger(source, user.address, read.raw);
        logWebhookWarn(
          `op=ledger-quarantine source=${source} aid=${hashedField(user.address)} ` +
            `moved_to=${CORRUPT_PURGED_KEY_PREFIX}/${source}`,
        );
      }
      const existing = read.status === "ok" ? read.ledger : null;

      // §4.8: monotonic. A POST carrying an older value never moves the watermark backwards.
      const existingMs =
        existing === null
          ? Number.NEGATIVE_INFINITY
          : Date.parse(existing.purgedThrough);
      const nextThroughMs = Math.max(existingMs, purgedThroughMs);

      // §4.8: the per-request cap bounds `recentIds` (forensics) and NOTHING ELSE. The
      // watermark above tombstones a purge of any size, so a 500-id purge leaves nothing
      // resurrectable even though only the newest 200 ids are retained for attribution.
      const dropped = Math.max(0, ids.length - PURGE_IDS_PER_REQUEST_CAP);
      const contributed =
        dropped > 0 ? ids.slice(-PURGE_IDS_PER_REQUEST_CAP) : ids;
      if (dropped > 0) {
        // No silent caps.
        logWebhookWarn(
          `op=purge-overflow source=${source} aid=${hashedField(user.address)} ` +
            `submitted=${ids.length} stored=${contributed.length} dropped=${dropped}`,
        );
      }

      const merged = [...(existing?.recentIds ?? []), ...contributed];
      const recentIds = [...new Set(merged)].slice(-PURGE_RECENT_ID_CAP);
      const updatedAt = new Date(now()).toISOString();
      await control.writeLedger(source, user.address, {
        purgedThrough: new Date(nextThroughMs).toISOString(),
        recentIds,
        updatedAt,
      });

      // §6.2: purge drops the pending queue for that source, exactly as the teardown does.
      await queue.clear(source, user.address);

      logWebhook(
        `op=purge source=${source} aid=${hashedField(user.address)} ids=${ids.length} ` +
          `stored=${recentIds.length} through=${new Date(nextThroughMs).toISOString()} ` +
          `through_source=${defaultedThrough ? "default_now" : "client"}`,
      );

      if (dropped > 0) {
        res
          .status(200)
          .json({ status: "accepted", stored: contributed.length, dropped });
        return;
      }
      res.status(204).end();
    } catch (error) {
      logWebhookWarn(
        `op=purge result=error source=${source} aid=${hashedField(user.address)}`,
      );
      console.warn(
        "[connector-webhook] purge ledger write failed:",
        redactedErrorMessage(error),
      );
      res.status(503).json({ error: "unavailable" });
    }
  });

  /**
   * §4.8's CLEAR verb — the "explicit user-initiated re-sync" §6.1 step -1 and §6.2 both
   * reference. It resets `purgedThrough` AND `recentIds`, is fired by the reconnect / re-sync
   * flow (F3) and by nothing else: never automatically on drain, never on enable.
   */
  router.delete("/purged", async (req: Request, res: Response) => {
    const user = requireUser(req, res);
    if (!user) return;

    const body = bodyOf(req);
    if (!isValidSource(body.source) || !registry.has(body.source)) {
      res.status(400).json({ error: "unknown_source" });
      return;
    }
    const source = body.source;

    try {
      await control.clearLedger(source, user.address);
      logWebhook(
        `op=ledger-clear source=${source} aid=${hashedField(user.address)}`,
      );
      res.status(204).end();
    } catch (error) {
      logWebhookWarn(
        `op=ledger-clear result=error source=${source} aid=${hashedField(user.address)}`,
      );
      console.warn(
        "[connector-webhook] purge ledger clear failed:",
        redactedErrorMessage(error),
      );
      res.status(503).json({ error: "unavailable" });
    }
  });

  return router;
}
