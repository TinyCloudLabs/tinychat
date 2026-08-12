import {
  sanitizeErrorCode,
  type ConnectorQueue,
  type PendingItem,
  type PendingKind,
  type SettleOutcome,
  type SettleResult,
} from "./connector-queue.js";
import type { CredentialSecret } from "./credential-store.js";
import type { IngestMode } from "./ingest-mode.js";
import {
  registerFetchWorkerNudge,
  type FetchWorkerNudge,
  type FetchWorkerNudgeInput,
} from "./ingest-nudge.js";
import { keyedLogHash, normalizeWebhookAddress } from "./webhook-tokens.js";

/**
 * W3 — the FETCH WORKER (backend-ingest plan §8.1 W3; §8.2 delta items 1, 2, 4, 5, 7, 8, 10;
 * §9 anti-patterns 1, 2, 4, 6).
 *
 * For a COHORT address the browser is no longer the queue's consumer — this is. It claims
 * `pending` items, refetches each meeting BY ID with that user's own credential, hands the
 * content to the (W4) server-side store, and only then removes the item from the queue.
 *
 * The five properties everything here is arranged around:
 *
 *  1. **Per-delivery tenant resolution (delta 1 / AP 1).** There is no module-scope "current
 *     user", "latest address" or "latest secret". A lane is a `(source, address)` pair passed
 *     down every call, the credential is retrieved per lane with that address, and the content
 *     upsert carries it. The Listen failure — the last user to configure receives everyone's
 *     data — has no variable to live in.
 *  2. **Capture-before-ack (delta 7 / AP 2).** Nothing in this module runs inside the delivery
 *     window. The 202 waits on the durable enqueue and nothing else; the worker learns about a
 *     delivery through W1's post-ack nudge or its own timer sweep, and an item that was enqueued
 *     before a crash is picked up by the next sweep after restart.
 *  3. **Backpressure on a SHARED upstream (delta 2, 8 / AP 6).** One user's items are strictly
 *     serial and spaced ≥800 ms (the browser drain's own pacing precedent); users run in
 *     parallel LANES so a 50-item backlog cannot starve anyone; a global semaphore caps
 *     concurrent Fireflies calls; a 429 pauses only the throttled user's lane, for exactly the
 *     `Retry-After` it asked for, and burns no attempt.
 *  4. **The shipped retry physics, reused (delta 4 / AP 4).** Attempts, backoff, jitter, TTL and
 *     the dead-letter all belong to `ConnectorQueue`. This module classifies a failure into a
 *     SHORT, FIXED code and hands it to `settle`; it owns no second schedule and invents no
 *     second jitter. A provider's own error text never becomes that code.
 *  5. **Fail closed (delta 10).** `ContentSink.upsert` returns a Result, and only a literal
 *     `{ok:true}` produces the single `status: "done"` settle in this file. A rejected Result, a
 *     throw, or a shape that is not a Result at all are the same thing: the item is NOT removed,
 *     NOT counted fetched, and retries. Silent success has nowhere to come from.
 *
 * SEQUENTIAL STORAGE (§9.3): user lanes run concurrently, but every node call they make funnels
 * through the SHARED `BackendStorageLane` — one lane per process, wired by `index.ts` into the
 * queue, the KV content store and the KV credential row store. TinyCloud drops concurrent
 * responses on one space; a per-component lane is not enough because a queue settle for user A
 * and a content upsert for user B still race at the shared backend node. The delta-02 test
 * "KV writes from the queue and content store share ONE lane against the backend node" pins the
 * invariant against the fake node's concurrency counter.
 */

// ── Tunables ─────────────────────────────────────────────────────────

/** Plan §8.1 W3: a 30 s ceiling on any single upstream fetch. */
export const FETCH_TIMEOUT_MS = 30_000;
/** Plan §8.1 W3: per-user serial with ≥800 ms spacing (the browser drain's pacing precedent). */
export const MIN_USER_SPACING_MS = 800;
/** Plan §8.1 W3: global Fireflies concurrency cap, default 3, tunable. */
export const DEFAULT_UPSTREAM_CONCURRENCY = 3;
export const UPSTREAM_CONCURRENCY_ENV = "CONNECTOR_FETCH_CONCURRENCY";
/** Timer sweep. The nudge is the fast path; this is the backstop that survives a lost nudge. */
export const SWEEP_INTERVAL_MS = 30_000;
/** Plan §8.1 W3 SLA proposal: p95 webhook → `fetched` under 5 minutes. */
export const FETCH_SLA_MS = 5 * 60_000;
/** A 429 with no `Retry-After` still has to pause something; this is the documented fallback. */
export const RATE_LIMIT_FALLBACK_MS = 60_000;
/**
 * How long a lane is held after its credential turns out to be missing or refused. Long enough
 * that a disconnected user costs no upstream traffic, short enough that a reconnect is picked up
 * without an operator.
 */
export const CREDENTIAL_HOLD_MS = 5 * 60_000;
/**
 * Items one lane claims per pass. Bounded work per pass keeps a 200-deep backlog from turning a
 * single sweep into a three-minute lane, and the remainder rides the next one.
 */
export const MAX_ITEMS_PER_PASS = 50;
/** Rolling window the p95 lag is computed over. A metric is not a log; it keeps no identifiers. */
const LAG_WINDOW = 512;

/** Sources this worker consumes. Fireflies is the only connector with a backend fetch today. */
export const DEFAULT_FETCH_SOURCES: readonly string[] = ["fireflies"];

export function resolveUpstreamConcurrency(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env[UPSTREAM_CONCURRENCY_ENV];
  if (typeof raw !== "string") return DEFAULT_UPSTREAM_CONCURRENCY;
  const parsed = Number.parseInt(raw.trim(), 10);
  // Junk, zero and negatives fall back rather than uncapping the shared upstream.
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_UPSTREAM_CONCURRENCY;
  return parsed;
}

// ── Ports ────────────────────────────────────────────────────────────

/** What the worker fetched. `payload` is the connector-shaped content W4 encrypts and stores. */
export interface FetchedMeeting {
  /** MUST equal the id the worker asked for — see `unparseable_content`. */
  sourceId: string;
  title?: string;
  /** ISO meeting timestamp when the provider gave one. */
  ts?: string;
  payload: unknown;
}

export interface MeetingFetchRequest {
  source: string;
  /** REFETCH BY ID. There is no URL in this request and none in the stored result. */
  meetingId: string;
  kind: PendingKind;
  secret: CredentialSecret;
  /** Aborted at the fetch timeout so a hung provider cannot hold a lane open. */
  signal: AbortSignal;
}

/**
 * A provider error. `code` is advisory: the worker maps it through a FIXED allowlist before it
 * can reach the queue or a log, because a provider message can quote the credential.
 */
export interface MeetingFetchError {
  code: string;
  /** From `Retry-After` on a 429. */
  retryAfterMs?: number;
  /** The provider is certain this id will never resolve (404 for an id it does not have). */
  terminal?: boolean;
}

export type MeetingFetchResult =
  | { ok: true; content: FetchedMeeting }
  | { ok: false; error: MeetingFetchError };

export interface MeetingFetcher {
  fetchMeeting(request: MeetingFetchRequest): Promise<MeetingFetchResult>;
}

/** What the worker hands W4. Upsert identity is `(source, sourceId)` scoped by `address`. */
export interface ContentUpsertInput {
  source: string;
  address: string;
  sourceId: string;
  kind: PendingKind;
  title?: string;
  ts?: string;
  /** Link-stripped provider content. W4 encrypts it; the worker never persists it itself. */
  content: unknown;
  /** ISO. */
  fetchedAt: string;
  /** ISO — the delivery's own `receivedAt`, so W4 can report ingest lag without a timer. */
  receivedAt: string;
}

/**
 * The fail-closed contract (delta 10). `ok` is a LITERAL `true` on the success arm, so a store
 * that resolves anything else — `{ok:false}`, `undefined`, a bare object — cannot be read as a
 * success by construction, and the worker checks the literal rather than the truthiness.
 */
export type ContentUpsertResult =
  | { ok: true; stored: "created" | "merged" }
  | { ok: false; code: string };

export interface ContentSink {
  upsert(input: ContentUpsertInput): Promise<ContentUpsertResult>;
}

/**
 * W4/W7's retention + purge tombstones. A tombstoned id must never be refetched or re-stored: an
 * at-least-once provider can replay a delivery indefinitely when it carried no timestamp
 * (findings §2.1), and a retention sweep that can be undone by a replay is not a retention
 * policy. A check that FAILS holds the item — it is never read as "not tombstoned".
 */
export interface RetentionGuard {
  tombstoned(input: {
    source: string;
    address: string;
    meetingId: string;
    kind: PendingKind;
    sourceTimestamp?: string;
  }): Promise<boolean>;
}

/** The cohort membership the worker sweeps. Satisfied by `IngestModeService`. */
export interface IngestCohortLookup {
  cohort(): Promise<ReadonlySet<string>>;
  mode(address: string): Promise<IngestMode>;
}

/** §6.2 restricts credential retrieval to this path; the purpose argument says so out loud. */
export interface WorkerCredentialLookup {
  getCredential(
    source: string,
    address: string,
    purpose: "fetch-worker",
  ): Promise<CredentialSecret | null>;
  markUsed?(source: string, address: string): Promise<void>;
}

/** The queue surface the worker uses. Narrowed so it cannot reach for `clear` or `acknowledge`. */
export type FetchWorkerQueue = Pick<ConnectorQueue, "due" | "settle">;

export interface FetchWorkerDeps {
  queue: FetchWorkerQueue;
  modes: IngestCohortLookup;
  credentials: WorkerCredentialLookup;
  fetcher: MeetingFetcher;
  content: ContentSink;
  retention?: RetentionGuard;
}

export interface FetchWorkerOptions {
  now?: () => number;
  /** Injectable so the ≥800 ms pacing is asserted exactly instead of waited out. */
  sleep?: (ms: number) => Promise<void>;
  concurrency?: number;
  spacingMs?: number;
  fetchTimeoutMs?: number;
  maxItemsPerPass?: number;
  sweepIntervalMs?: number;
  sources?: readonly string[];
}

// ── Counters (W8's surface; §6.3 — no identifier, ever) ──────────────

export interface FetchWorkerStats {
  passes: number;
  claimed: number;
  fetched: number;
  failed: number;
  deadLettered: number;
  tombstoned: number;
  rateLimited: number;
  timeouts: number;
  storeFailures: number;
  credentialUnavailable: number;
  errors: number;
  slaBreaches: number;
  /** How many URL-valued strings were substituted with the link-removed sentinel this run. */
  linksStripped: number;
  /** p95 of `fetched` minus the delivery's `receivedAt`, over a rolling window. */
  p95LagMs: number;
  peakUpstreamConcurrency: number;
}

export interface FetchPassSummary {
  lanes: number;
  claimed: number;
  fetched: number;
  errors: number;
}

// ── Error codes: SHORT, FIXED, and never provider-authored ───────────

const UPSTREAM_ERROR = "upstream_error";
const RATE_LIMITED = "rate_limited";
const UNAUTHORIZED = "unauthorized";
const NOT_FOUND = "not_found";
const NETWORK_ERROR = "network_error";
const INVALID_RESPONSE = "invalid_response";
const FETCH_FAILED = "fetch_failed";
const FETCH_TIMEOUT = "fetch_timeout";
const UNPARSEABLE_CONTENT = "unparseable_content";
const CONTENT_STORE_FAILED = "content_store_failed";

/**
 * The ONLY provider-supplied codes that survive into the queue and the logs. Anything else
 * collapses to `fetch_failed` — a provider message can quote a token, a meeting title or a whole
 * payload fragment, and `sanitizeErrorCode` would happily strip the punctuation and keep the
 * secret.
 */
const PROVIDER_CODES = new Set([
  UPSTREAM_ERROR,
  RATE_LIMITED,
  UNAUTHORIZED,
  NOT_FOUND,
  NETWORK_ERROR,
  INVALID_RESPONSE,
]);

/** Codes that mean "this user's credential cannot be used", not "this item is bad". */
const CREDENTIAL_CODES = new Set([UNAUTHORIZED]);

function classifyProviderCode(raw: unknown): string {
  const cleaned = sanitizeErrorCode(raw);
  if (cleaned !== undefined && PROVIDER_CODES.has(cleaned)) return cleaned;
  return FETCH_FAILED;
}

// ── Logging (§6.3: hashed ids, never a raw address, never a credential) ─

function logWorker(fields: string): void {
  console.log(`[connector-fetch] ${fields} t=${new Date().toISOString()}`);
}

function logWorkerWarn(fields: string): void {
  console.warn(`[connector-fetch] ${fields} t=${new Date().toISOString()}`);
}

function hashed(value: string): string {
  try {
    return keyedLogHash(value);
  } catch {
    return "unavailable";
  }
}

// ── Expiring-link stripping (delta 7: refetch by id, store no link) ──

/** Left as a value the caller can grep for, instead of silently deleting keys or array entries. */
export const LINK_SENTINEL = "[link removed]";

/**
 * Keys whose VALUE is treated as a link even when the URL body itself carries no expiring marker.
 * A presigned media URL and an unsigned one are the same disclosure risk when the field name says
 * "this is a link" — the store should hold neither.
 */
const LINK_KEY_RE = /(?:^|_)(?:url|href|link|download|thumbnail)$/i;

/**
 * A string that is ENTIRELY a URL — a scheme at the start, no interior whitespace or prose. The
 * old {@link SIGNED_HINT} matched anywhere in a string, which destroyed sentences like
 * `"use the token=abc auth header"`; the anchored form ensures only actual URL VALUES are
 * replaced, never transcript prose that happens to name a query-param.
 */
const PURE_URL_RE = /^\s*(?:https?|wss?|ftp):\/\/\S+\s*$/i;

/**
 * Rewrite every URL-valued string in the content to {@link LINK_SENTINEL} before it is stored.
 *
 * A presigned media link is an EXPIRING credential in disguise: stored, it rots into a dead link,
 * and shared, it is an unauthenticated read of the user's meeting. The worker refetches by id
 * instead — so nothing downstream ever needs one.
 *
 * The mutation is a SUBSTITUTION, not a deletion: array indices are preserved, object shapes are
 * preserved, and a grep for `[link removed]` in the stored blob is the observability the audit
 * asked for. Two triggers:
 *  - the key is one of `*_url` / `href` / `link` / `*_download` and the value looks like a URL
 *    (even without a signed-URL marker — the field name is enough);
 *  - the value IS a URL, whole string. Prose that mentions "token=" is left untouched.
 */
export function stripExpiringLinks(value: unknown): unknown {
  return walkStrip(value, "").value;
}

function looksLikeUrlValue(value: string): boolean {
  return PURE_URL_RE.test(value);
}

interface WalkResult {
  value: unknown;
  stripped: number;
}

function walkStrip(value: unknown, keyHint: string): WalkResult {
  if (typeof value === "string") {
    if (looksLikeUrlValue(value) || (LINK_KEY_RE.test(keyHint) && looksLikeUrlValue(value.trim()))) {
      return { value: LINK_SENTINEL, stripped: 1 };
    }
    return { value, stripped: 0 };
  }
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    let stripped = 0;
    for (const entry of value) {
      const walked = walkStrip(entry, "");
      out.push(walked.value);
      stripped += walked.stripped;
    }
    return { value: out, stripped };
  }
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    let stripped = 0;
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      const walked = walkStrip(entry, key);
      out[key] = walked.value;
      stripped += walked.stripped;
    }
    return { value: out, stripped };
  }
  return { value, stripped: 0 };
}

/**
 * Runs the same walker and reports whether any string was rewritten to the sentinel. Callers use
 * it to attach a hashed log line per meeting instead of silently mutating content.
 */
export function stripExpiringLinksWithCount(value: unknown): {
  value: unknown;
  stripped: number;
} {
  return walkStrip(value, "");
}

// ── A global semaphore over the shared Fireflies budget ──────────────

class Semaphore {
  private readonly waiters: Array<() => void> = [];
  private available: number;

  constructor(private readonly limit: number) {
    this.available = limit;
  }

  async acquire(): Promise<() => void> {
    if (this.available > 0) {
      this.available -= 1;
      return () => this.release();
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    return () => this.release();
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next !== undefined) {
      next();
      return;
    }
    this.available = Math.min(this.limit, this.available + 1);
  }
}

// ── D4: one worker per process ───────────────────────────────────────
//
// A SECOND consumer of the same queue would void both the per-address mutex and §7's write
// budget (findings §2.5). This holder carries the running WORKER — never an address, a user or a
// secret; the AP-1 exclusion is about per-delivery state, and there is none here.

const runningWorker: { instance: ConnectorFetchWorker | null } = {
  instance: null,
};

/** Test hook (house `_reset` convention). */
export function _resetFetchWorkerSingleton(): void {
  runningWorker.instance = null;
}

/**
 * W8's read of the seat. The observability reporter is built at startup and the worker may be
 * started later (or not at all in a deployment that has not enabled backend ingestion), so the
 * counters are looked up per emit rather than captured once. Read-only: the seat is claimed by
 * `start()` and released by `stop()`, and nothing else may write it.
 */
export function runningFetchWorkerStats(): FetchWorkerStats | null {
  return runningWorker.instance?.stats() ?? null;
}

// ── Internal per-item disposition ────────────────────────────────────
//
// `stored` is the ONLY arm that can produce a `done` settle, and it is only constructible after a
// `{ok:true}` content result — delta 10's "silent success is unrepresentable" in type form.

type ItemDisposition =
  | { kind: "stored"; receivedAt: string; fetchedAt: number }
  | { kind: "tombstoned" };

interface ItemOutcome {
  /** Absent means "no queue mutation" — a held item, never a settled one. */
  settle?: SettleOutcome;
  disposition?: ItemDisposition;
  /** A throttled or credential-less lane stops immediately; the rest of its items wait. */
  stopLane?: boolean;
}

interface LaneTarget {
  source: string;
  address: string;
}

// ── The worker ───────────────────────────────────────────────────────

export class ConnectorFetchWorker implements FetchWorkerNudge {
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly spacingMs: number;
  private readonly fetchTimeoutMs: number;
  private readonly maxItemsPerPass: number;
  private readonly sweepIntervalMs: number;
  private readonly sources: readonly string[];
  private readonly semaphore: Semaphore;
  private readonly concurrency: number;

  /** Per-lane pause deadlines: 429 `Retry-After`, and credential holds. */
  private readonly gates = new Map<string, number>();
  /** Per-lane timestamp of the last upstream call, for the ≥800 ms spacing. */
  private readonly lastCallAt = new Map<string, number>();
  /** Claimed items, so a nudge storm and the timer sweep cannot double-fetch one id. */
  private readonly claims = new Set<string>();
  private readonly lags: number[] = [];
  private readonly dirty = new Set<string>();
  private readonly counters: FetchWorkerStats = emptyStats();

  private timer: ReturnType<typeof setInterval> | null = null;
  private started = false;
  private inFlightUpstream = 0;
  private active: Promise<unknown> | null = null;
  private queued: { promise: Promise<FetchPassSummary>; sweepAll: boolean } | null =
    null;

  constructor(
    private readonly deps: FetchWorkerDeps,
    options: FetchWorkerOptions = {},
  ) {
    this.now = options.now ?? (() => Date.now());
    this.sleep =
      options.sleep ??
      ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    this.spacingMs = options.spacingMs ?? MIN_USER_SPACING_MS;
    this.fetchTimeoutMs = options.fetchTimeoutMs ?? FETCH_TIMEOUT_MS;
    this.maxItemsPerPass = options.maxItemsPerPass ?? MAX_ITEMS_PER_PASS;
    this.sweepIntervalMs = options.sweepIntervalMs ?? SWEEP_INTERVAL_MS;
    this.sources = options.sources ?? DEFAULT_FETCH_SOURCES;
    this.concurrency = options.concurrency ?? resolveUpstreamConcurrency();
    this.semaphore = new Semaphore(this.concurrency);
  }

  /**
   * Claim the process's single worker seat (D4), register with W1's `onDelivery` seam and start
   * the backstop sweep. A second instance REFUSES rather than quietly becoming a second consumer.
   */
  start(): void {
    if (runningWorker.instance !== null && runningWorker.instance !== this) {
      throw new Error(
        "connector fetch worker is single instance per process (D4); one is already running",
      );
    }
    if (this.started) return;
    runningWorker.instance = this;
    this.started = true;
    registerFetchWorkerNudge(this);
    this.timer = setInterval(() => {
      void this.schedulePass(true).catch(() => {
        // `runPass` already counted and logged; an unhandled rejection out of a timer would take
        // the process down for a failure the next tick retries anyway.
      });
    }, this.sweepIntervalMs);
    // The sweep must never be the reason a process refuses to exit.
    this.timer.unref?.();
    logWorker(`op=worker-start concurrency=${this.concurrency}`);
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (runningWorker.instance === this) runningWorker.instance = null;
    if (this.started) registerFetchWorkerNudge(null);
    this.started = false;
  }

  isRunning(): boolean {
    return this.started;
  }

  /**
   * W1's post-ack seam. Runs strictly AFTER the 202 (see `ingest-nudge.ts`), so the returned
   * promise costs the delivery nothing; it resolves when the pass covering this delivery is done,
   * which is what makes the seam testable end to end.
   */
  nudge(input: FetchWorkerNudgeInput): Promise<void> {
    this.dirty.add(laneKey(input.source, input.address));
    return this.schedulePass(false).then(() => undefined);
  }

  /** One full sweep of the cohort. The timer's unit of work, and the tests' entry point. */
  runOnce(): Promise<FetchPassSummary> {
    return this.schedulePass(true);
  }

  stats(): Readonly<FetchWorkerStats> {
    return { ...this.counters, p95LagMs: this.p95() };
  }

  // ── Pass scheduling: at most one pass at a time, at most one queued ─

  private schedulePass(sweepAll: boolean): Promise<FetchPassSummary> {
    const queued = this.queued;
    if (queued !== null) {
      // A burst of nudges joins the already-queued pass instead of scheduling one each: 50
      // deliveries must not become 50 queue reads.
      queued.sweepAll = queued.sweepAll || sweepAll;
      return queued.promise;
    }
    const entry: { promise: Promise<FetchPassSummary>; sweepAll: boolean } = {
      sweepAll,
      promise: undefined as unknown as Promise<FetchPassSummary>,
    };
    const prior = this.active ?? Promise.resolve();
    entry.promise = prior.then(
      () => this.startQueued(entry),
      () => this.startQueued(entry),
    );
    this.queued = entry;
    return entry.promise;
  }

  private startQueued(entry: {
    sweepAll: boolean;
  }): Promise<FetchPassSummary> {
    this.queued = null;
    const run = this.runPass(entry.sweepAll);
    this.active = run.catch(() => undefined);
    return run;
  }

  private async runPass(sweepAll: boolean): Promise<FetchPassSummary> {
    const summary: FetchPassSummary = {
      lanes: 0,
      claimed: 0,
      fetched: 0,
      errors: 0,
    };
    this.counters.passes += 1;

    let targets: LaneTarget[];
    try {
      targets = await this.targets(sweepAll);
    } catch {
      // FAIL CLOSED: an unreadable cohort is never read as "nobody is enrolled" — that would
      // hand a cohort address back to a browser drain the worker is also consuming for.
      this.counters.errors += 1;
      summary.errors += 1;
      logWorkerWarn(`op=pass result=cohort_unavailable`);
      return summary;
    }
    summary.lanes = targets.length;

    // Lanes run CONCURRENTLY (fairness — delta 2) but every node call inside them funnels through
    // the queue's single storage lane, so the space still sees one request at a time (§9.3).
    await Promise.all(
      targets.map((target) => this.runLane(target, summary)),
    );
    return summary;
  }

  private async targets(sweepAll: boolean): Promise<LaneTarget[]> {
    const cohort = await this.deps.modes.cohort();
    const nudged = [...this.dirty];
    this.dirty.clear();

    const seen = new Set<string>();
    const targets: LaneTarget[] = [];
    const add = (source: string, address: string) => {
      const normalized = normalizeWebhookAddress(address);
      if (!cohort.has(normalized)) return;
      const key = laneKey(source, normalized);
      if (seen.has(key)) return;
      seen.add(key);
      targets.push({ source, address: normalized });
    };

    for (const key of nudged) {
      const [source, address] = splitLaneKey(key);
      if (source === undefined || address === undefined) continue;
      try {
        add(source, address);
      } catch {
        // An address that no longer normalizes cannot be a cohort member either.
        this.counters.errors += 1;
      }
    }
    if (sweepAll) {
      for (const source of this.sources) {
        for (const address of cohort) add(source, address);
      }
    }
    return targets;
  }

  // ── One user's lane: serial, spaced, gated ─────────────────────────

  private async runLane(
    target: LaneTarget,
    summary: FetchPassSummary,
  ): Promise<void> {
    const key = laneKey(target.source, target.address);
    const gate = this.gates.get(key);
    if (gate !== undefined && gate > this.now()) return;
    if (gate !== undefined) this.gates.delete(key);

    let due: PendingItem[];
    try {
      due = await this.deps.queue.due(target.source, target.address);
    } catch {
      this.counters.errors += 1;
      summary.errors += 1;
      logWorkerWarn(
        `op=lane result=queue_unavailable source=${target.source} aid=${hashed(target.address)}`,
      );
      return;
    }
    const batch = due.slice(0, this.maxItemsPerPass);
    if (batch.length === 0) return;
    if (due.length > batch.length) {
      // No silent caps: the operator sees that this pass left work behind on purpose.
      logWorker(
        `op=lane result=batch_capped source=${target.source} claimed=${batch.length} ` +
          `deferred=${due.length - batch.length} aid=${hashed(target.address)}`,
      );
    }

    let secret: CredentialSecret | null;
    try {
      secret = await this.deps.credentials.getCredential(
        target.source,
        target.address,
        "fetch-worker",
      );
    } catch {
      // An unreadable envelope is a custody failure, not an item failure: hold the lane, burn
      // nothing, and never let the reason near a log line.
      this.holdLane(key, "credential_unreadable", target);
      return;
    }
    if (secret === null) {
      this.holdLane(key, "credential_missing", target);
      return;
    }

    const outcomes: SettleOutcome[] = [];
    const dispositions = new Map<string, ItemDisposition>();
    let fetchedAny = false;

    for (const item of batch) {
      const claim = `${key}|${item.kind}:${item.meetingId}`;
      if (this.claims.has(claim)) continue;
      this.claims.add(claim);
      summary.claimed += 1;
      this.counters.claimed += 1;
      let outcome: ItemOutcome;
      try {
        outcome = await this.processItem(target, key, item, secret);
      } catch {
        // Nothing in `processItem` is allowed to throw; if something does, the item is HELD.
        this.counters.errors += 1;
        summary.errors += 1;
        outcome = {};
      } finally {
        this.claims.delete(claim);
      }
      if (outcome.settle !== undefined) outcomes.push(outcome.settle);
      if (outcome.disposition !== undefined) {
        dispositions.set(itemKey(item), outcome.disposition);
        if (outcome.disposition.kind === "stored") fetchedAny = true;
      }
      if (outcome.stopLane === true) break;
    }

    if (outcomes.length > 0) {
      // ONE read-modify-write per lane per pass, not one per item: the queue lives on the shared
      // single-writer node and §7's budget is real.
      let results: SettleResult[];
      try {
        results = await this.deps.queue.settle(
          target.source,
          target.address,
          outcomes,
        );
      } catch {
        // The content may be stored but the queue could not record it. That is NOT a fetch: the
        // item stays pending and the next pass re-stores idempotently by `(source, source_id)`.
        this.counters.errors += 1;
        summary.errors += 1;
        logWorkerWarn(
          `op=lane result=settle_failed source=${target.source} aid=${hashed(target.address)}`,
        );
        return;
      }
      summary.fetched += this.countSettled(target, results, dispositions);
    }

    if (fetchedAny && this.deps.credentials.markUsed !== undefined) {
      try {
        await this.deps.credentials.markUsed(target.source, target.address);
      } catch {
        // An audit stamp is not worth failing a fetch that already succeeded.
        this.counters.errors += 1;
      }
    }
  }

  private holdLane(
    key: string,
    reason:
      | "credential_missing"
      | "credential_unreadable"
      | "credential_rejected",
    target: LaneTarget,
  ): void {
    this.counters.credentialUnavailable += 1;
    this.gates.set(key, this.now() + CREDENTIAL_HOLD_MS);
    logWorkerWarn(
      `op=lane result=${reason} source=${target.source} aid=${hashed(target.address)}`,
    );
  }

  // ── One item ───────────────────────────────────────────────────────

  private async processItem(
    target: LaneTarget,
    key: string,
    item: PendingItem,
    secret: CredentialSecret,
  ): Promise<ItemOutcome> {
    // 1. Retention / purge tombstones (delta 5, W4/W7). Checked BEFORE the upstream call: a
    //    swept or purged meeting must cost neither a fetch nor a store.
    if (this.deps.retention !== undefined) {
      let tombstoned: boolean;
      try {
        tombstoned = await this.deps.retention.tombstoned({
          source: target.source,
          address: target.address,
          meetingId: item.meetingId,
          kind: item.kind,
          ...(item.sourceTimestamp !== undefined
            ? { sourceTimestamp: item.sourceTimestamp }
            : {}),
        });
      } catch {
        // Fail closed: an unavailable ledger is never "not tombstoned".
        this.counters.errors += 1;
        logWorkerWarn(
          `op=item result=retention_unavailable source=${target.source} ` +
            `mid=${hashed(item.meetingId)} aid=${hashed(target.address)}`,
        );
        return {};
      }
      if (tombstoned) {
        logWorker(
          `op=item result=tombstoned source=${target.source} ` +
            `mid=${hashed(item.meetingId)} aid=${hashed(target.address)}`,
        );
        return {
          settle: doneOutcome(item),
          disposition: { kind: "tombstoned" },
        };
      }
    }

    // 2. Per-user pacing (≥800 ms), OUTSIDE the global slot so a paced lane holds no budget.
    await this.pace(key);

    // 3. The upstream call, under the global cap and the fetch timeout.
    const release = await this.semaphore.acquire();
    let result: MeetingFetchResult | { timeout: true } | { thrown: true };
    try {
      this.inFlightUpstream += 1;
      if (this.inFlightUpstream > this.counters.peakUpstreamConcurrency) {
        this.counters.peakUpstreamConcurrency = this.inFlightUpstream;
      }
      this.lastCallAt.set(key, this.now());
      result = await this.fetchWithTimeout(target.source, item, secret);
    } finally {
      this.inFlightUpstream -= 1;
      release();
    }

    if ("timeout" in result) {
      this.counters.timeouts += 1;
      logWorkerWarn(
        `op=item result=${FETCH_TIMEOUT} source=${target.source} ` +
          `mid=${hashed(item.meetingId)} aid=${hashed(target.address)}`,
      );
      return { settle: failedOutcome(item, FETCH_TIMEOUT) };
    }
    if ("thrown" in result) {
      return { settle: failedOutcome(item, FETCH_FAILED) };
    }

    if (!result.ok) {
      const code = classifyProviderCode(result.error?.code);
      if (code === RATE_LIMITED) {
        // Honor `Retry-After` exactly, on THIS user's lane only, and burn no attempt: a provider
        // throttle is not the item's fault, and a queue write here would be a write per 429.
        const waitMs =
          typeof result.error.retryAfterMs === "number" &&
          Number.isFinite(result.error.retryAfterMs) &&
          result.error.retryAfterMs > 0
            ? result.error.retryAfterMs
            : RATE_LIMIT_FALLBACK_MS;
        this.gates.set(key, this.now() + waitMs);
        this.counters.rateLimited += 1;
        logWorkerWarn(
          `op=item result=${RATE_LIMITED} source=${target.source} ` +
            `wait_ms=${waitMs} aid=${hashed(target.address)}`,
        );
        return { stopLane: true };
      }
      if (CREDENTIAL_CODES.has(code)) {
        // The PROVIDER refused this credential — the grant expired or was revoked upstream, so the
        // exit is the connect flow. Deliberately NOT `credential_unreadable`: that one means we
        // could not open our own envelope (wrong master, corrupt row — a custody incident), and an
        // operator paging on one must never be chasing the other.
        this.holdLane(key, "credential_rejected", target);
        return { stopLane: true };
      }
      const terminal = code === NOT_FOUND || result.error.terminal === true;
      return {
        settle: failedOutcome(item, code, terminal),
      };
    }

    // 4. Identity check. An answer for a DIFFERENT id is poison, not a retryable failure — it is
    //    either a provider fabrication or a routing bug, and both are terminal on attempt 1.
    const content = result.content;
    if (
      content === null ||
      typeof content !== "object" ||
      content.sourceId !== item.meetingId
    ) {
      logWorkerWarn(
        `op=item result=${UNPARSEABLE_CONTENT} source=${target.source} ` +
          `mid=${hashed(item.meetingId)} aid=${hashed(target.address)}`,
      );
      return { settle: failedOutcome(item, UNPARSEABLE_CONTENT, true) };
    }

    // 5. Store — and believe nothing until the store says `{ok:true}` (delta 10).
    const fetchedAt = this.now();
    const stripped = stripExpiringLinksWithCount(content.payload);
    if (stripped.stripped > 0) {
      // No silent caps: every other bound in W3/W4 counts and logs, and a URL substitution should
      // be no different. Hashed id and address only — never the URL, never a raw address.
      this.counters.linksStripped += stripped.stripped;
      logWorker(
        `op=links-stripped result=ok source=${target.source} ` +
          `mid=${hashed(item.meetingId)} aid=${hashed(target.address)} ` +
          `count=${stripped.stripped}`,
      );
    }
    const upsert: ContentUpsertInput = {
      source: target.source,
      address: target.address,
      sourceId: content.sourceId,
      kind: item.kind,
      ...(typeof content.title === "string" ? { title: content.title } : {}),
      ...(typeof content.ts === "string" ? { ts: content.ts } : {}),
      content: stripped.value,
      fetchedAt: new Date(fetchedAt).toISOString(),
      receivedAt: item.receivedAt,
    };

    let stored: unknown;
    try {
      stored = await this.deps.content.upsert(upsert);
    } catch {
      this.counters.storeFailures += 1;
      logWorkerWarn(
        `op=item result=${CONTENT_STORE_FAILED} source=${target.source} ` +
          `mid=${hashed(item.meetingId)} aid=${hashed(target.address)}`,
      );
      return { settle: failedOutcome(item, CONTENT_STORE_FAILED) };
    }
    if (!isStoredOk(stored)) {
      // A resolved `{ok:false}` — or anything that is not the success shape — is a FAILURE.
      this.counters.storeFailures += 1;
      logWorkerWarn(
        `op=item result=${CONTENT_STORE_FAILED} source=${target.source} ` +
          `mid=${hashed(item.meetingId)} aid=${hashed(target.address)}`,
      );
      return { settle: failedOutcome(item, CONTENT_STORE_FAILED) };
    }

    return {
      settle: doneOutcome(item),
      disposition: {
        kind: "stored",
        receivedAt: item.receivedAt,
        fetchedAt,
      },
    };
  }

  /** Per-user serial pacing: at least `spacingMs` between two upstream calls for one address. */
  private async pace(key: string): Promise<void> {
    const last = this.lastCallAt.get(key);
    if (last === undefined) return;
    const elapsed = this.now() - last;
    if (elapsed >= this.spacingMs) return;
    await this.sleep(this.spacingMs - elapsed);
  }

  private async fetchWithTimeout(
    source: string,
    item: PendingItem,
    secret: CredentialSecret,
  ): Promise<MeetingFetchResult | { timeout: true } | { thrown: true }> {
    const controller = new AbortController();
    const timeoutHandle: { id: ReturnType<typeof setTimeout> | null } = {
      id: null,
    };
    // The fetch promise is made non-rejecting BEFORE the race, so a provider that throws after
    // the timeout has already won cannot surface as an unhandled rejection.
    const attempt = this.deps.fetcher
      .fetchMeeting({
        source,
        meetingId: item.meetingId,
        kind: item.kind,
        secret,
        signal: controller.signal,
      })
      .then(
        (value) => ({ value }) as { value: MeetingFetchResult },
        () => ({ thrown: true }) as { thrown: true },
      );
    const timeout = new Promise<{ timeout: true }>((resolve) => {
      timeoutHandle.id = setTimeout(
        () => resolve({ timeout: true }),
        this.fetchTimeoutMs,
      );
    });
    try {
      const settled = await Promise.race([attempt, timeout]);
      if ("timeout" in settled) {
        controller.abort();
        return settled;
      }
      if ("thrown" in settled) return settled;
      return settled.value;
    } finally {
      if (timeoutHandle.id !== null) clearTimeout(timeoutHandle.id);
    }
  }

  // ── Counting, strictly after the queue confirmed the removal ───────

  private countSettled(
    target: LaneTarget,
    results: SettleResult[],
    dispositions: Map<string, ItemDisposition>,
  ): number {
    let fetched = 0;
    for (const result of results) {
      const disposition = dispositions.get(
        itemKey({ meetingId: result.meetingId, kind: result.kind }),
      );
      if (result.disposition === "removed") {
        if (disposition?.kind === "tombstoned") {
          this.counters.tombstoned += 1;
          continue;
        }
        if (disposition?.kind === "stored") {
          // `fetched` is stamped HERE — after the removal is durable — so an item whose settle
          // failed is never reported fetched (delta 10).
          this.counters.fetched += 1;
          fetched += 1;
          this.recordLag(disposition, target);
        }
        continue;
      }
      if (result.disposition === "dead-lettered") {
        this.counters.deadLettered += 1;
        continue;
      }
      if (result.disposition === "requeued") this.counters.failed += 1;
    }
    return fetched;
  }

  private recordLag(
    disposition: { receivedAt: string; fetchedAt: number },
    target: LaneTarget,
  ): void {
    const received = Date.parse(disposition.receivedAt);
    if (!Number.isFinite(received)) return;
    const lag = disposition.fetchedAt - received;
    if (lag < 0) return;
    this.lags.push(lag);
    if (this.lags.length > LAG_WINDOW) this.lags.shift();
    if (lag > FETCH_SLA_MS) {
      this.counters.slaBreaches += 1;
      // The alertable line. `lag_ms` is a duration, not an identifier.
      logWorkerWarn(
        `op=sla result=breach source=${target.source} lag_ms=${lag} ` +
          `aid=${hashed(target.address)}`,
      );
    }
  }

  private p95(): number {
    if (this.lags.length === 0) return 0;
    const sorted = [...this.lags].sort((a, b) => a - b);
    const index = Math.min(
      sorted.length - 1,
      Math.max(0, Math.ceil(sorted.length * 0.95) - 1),
    );
    return sorted[index]!;
  }
}

// ── Small helpers ────────────────────────────────────────────────────

function emptyStats(): FetchWorkerStats {
  return {
    passes: 0,
    claimed: 0,
    fetched: 0,
    failed: 0,
    deadLettered: 0,
    tombstoned: 0,
    rateLimited: 0,
    timeouts: 0,
    storeFailures: 0,
    credentialUnavailable: 0,
    errors: 0,
    slaBreaches: 0,
    linksStripped: 0,
    p95LagMs: 0,
    peakUpstreamConcurrency: 0,
  };
}

function laneKey(source: string, address: string): string {
  return `${source} ${address.toLowerCase()}`;
}

function splitLaneKey(
  key: string,
): [string | undefined, string | undefined] {
  const [source, address] = key.split(" ");
  return [source, address];
}

function itemKey(item: { meetingId: string; kind: PendingKind }): string {
  return `${item.kind}:${item.meetingId}`;
}

/**
 * The ONE place a `done` settle is constructed. Reachable from exactly two callers — a checked
 * `{ok:true}` store result, and a retention tombstone that means the content must NOT be stored.
 * A second construction site is how an optimistic removal gets added by accident.
 */
function doneOutcome(item: PendingItem): SettleOutcome {
  return { meetingId: item.meetingId, kind: item.kind, status: "done" };
}

function failedOutcome(
  item: PendingItem,
  lastError: string,
  terminal = false,
): SettleOutcome {
  return {
    meetingId: item.meetingId,
    kind: item.kind,
    status: "failed",
    lastError,
    ...(terminal ? { terminal: true } : {}),
  };
}

/**
 * Delta 10 in one function: only the literal success shape is a success. `undefined`, `null`, a
 * bare `{}`, `{ok:"true"}` and `{ok:1}` are each a FAILURE — the worker never asks whether a
 * store result is truthy.
 */
function isStoredOk(result: unknown): result is { ok: true } {
  return (
    typeof result === "object" &&
    result !== null &&
    (result as { ok?: unknown }).ok === true
  );
}
