import type { ContentStoreStats } from "./content-store.js";
import type { DeadItem } from "./connector-queue.js";
import {
  FETCH_SLA_MS,
  runningFetchWorkerStats,
  type FetchWorkerStats,
} from "./fetch-worker.js";
import { ingestNudgeStats } from "./ingest-nudge.js";

/**
 * W8 — OBSERVABILITY + REDACTION (backend-ingest plan §8.1 W8; §8.2 delta item 9;
 * §9 anti-pattern 7).
 *
 * Every other work package counts its own work: the fetch worker knows how many items it fetched,
 * the content store knows how many rows it dropped to a cap, the nudge seam knows how many
 * deliveries it saw. What none of them can know is the *system* answer an operator needs at 3am —
 * "is the dead-letter growing, and are we inside the SLA?" — because each of them sees one tenant,
 * one pass or one row at a time. This module is that one place, and it is deliberately the ONLY
 * place that reads across them.
 *
 * Two rules shape the whole file.
 *
 * **1. The snapshot is numbers only.** Not "we remembered to hash the ids" — there are no ids to
 * hash. Anti-pattern 7 is not a story about someone logging a secret on purpose; it is a story
 * about an identifier riding a diagnostic onto a `public_logs=true` stream because a diagnostic
 * is the one place nobody looks for a tenant. {@link IngestObservabilitySnapshot} has no string
 * field, so a future field cannot smuggle an address, a meeting id, a title or a credential into
 * the operator stream even by accident. Where a per-tenant fact IS needed on a log line, the peer
 * modules already emit it themselves with `aid=<keyedLogHash>` — this module never re-emits one.
 *
 * **2. A number this module could not read is a COUNTED failure, never a zero.** A dead-letter
 * read that throws must not resolve to "the queue is empty" — that is the exact reading that
 * turns an outage into a green dashboard. {@link IngestObservabilitySnapshot.dlqUnreadable} is
 * the floor marker, and it has its own alert.
 *
 * The DLQ walk is SEQUENTIAL across the cohort. TinyCloud drops concurrent responses on one space
 * (findings §2.5), so a `Promise.all` over the cohort would not merely be rude to the write
 * budget — it would return wrong numbers.
 */

// ── Constants ────────────────────────────────────────────────────────

export const OBSERVABILITY_LOG_PREFIX = "[connector-obs]";

/** How often the reporter emits when it is started. One line a minute, not one per delivery. */
export const OBSERVABILITY_INTERVAL_MS = 60_000;

/** Sources the collector walks when the caller does not narrow it. */
export const OBSERVABILITY_SOURCES: readonly string[] = ["fireflies"];

/**
 * A standing dead-letter this deep means items are failing for a reason retries cannot fix
 * (a revoked credential, a provider contract change) and a human has to look. Deliberately well
 * under `DEAD_CAP` (50): the alert exists to fire BEFORE the dead-letter starts evicting.
 */
export const DLQ_DEPTH_THRESHOLD = 10;

/** Growth between two consecutive snapshots. Catches a fast ramp long before the depth alert. */
export const DLQ_GROWTH_THRESHOLD = 5;

/** The plan's p95 webhook→`fetched` SLA, shared with W3 so there is one number, not two. */
export const FETCH_LAG_THRESHOLD_MS = FETCH_SLA_MS;

/** Rolling window for the reconcile-lag p95 — same shape as the worker's fetch-lag window. */
const RECONCILE_LAG_WINDOW = 200;

// ── Caller-facing error vocabulary (anti-pattern 7, second half) ─────
//
// "Internal errors never returned to callers." The connector routes already answer in short fixed
// codes; this is that vocabulary written down in ONE place so it can be asserted as a set, and so
// anything this module itself surfaces is checked against it rather than improvised.

export const GENERIC_CALLER_ERROR = "unavailable";

export const CALLER_SAFE_ERRORS: ReadonlySet<string> = new Set([
  "unavailable",
  "not_found",
  "unauthorized",
  "forbidden",
  "invalid_request",
  "invalid_source",
  "invalid_meeting_id",
  "invalid_page_size",
  "invalid_cursor",
  "invalid_code",
  "invalid_state",
  "internal_error",
  "store_unavailable",
  "revoke_failed",
  "upstream_exchange_failed",
  "upstream_revoke_failed",
  "rate_limited",
  "payload_too_large",
]);

export function isCallerSafeError(value: unknown): boolean {
  return typeof value === "string" && CALLER_SAFE_ERRORS.has(value);
}

/**
 * The fail-closed collapse. Anything that is not already a known short code — a thrown message, a
 * provider body, a raw identifier — becomes the generic code. There is no arm that inspects the
 * value and decides it is "probably safe": that decision is what leaks.
 */
export function callerFacingError(value: unknown): string {
  return isCallerSafeError(value) ? (value as string) : GENERIC_CALLER_ERROR;
}

// ── Process counters this module owns ────────────────────────────────

export interface CredentialAuditCounters {
  store: number;
  rotate: number;
  read: number;
  revoke: number;
  /** Any audited credential op that is none of the four above (a new op, an unparseable row). */
  other: number;
  /** The subset of `total` that did not report success. */
  failures: number;
  total: number;
}

export interface ReconcileLagCounters {
  observations: number;
  p95LagMs: number;
  maxLagMs: number;
}

interface OwnCounters {
  credentials: CredentialAuditCounters;
  reconcileLags: number[];
  reconcileMaxMs: number;
}

function emptyCredentialAudit(): CredentialAuditCounters {
  return {
    store: 0,
    rotate: 0,
    read: 0,
    revoke: 0,
    other: 0,
    failures: 0,
    total: 0,
  };
}

const own: OwnCounters = {
  credentials: emptyCredentialAudit(),
  reconcileLags: [],
  reconcileMaxMs: 0,
};

/** Results the credential store reports for an op that DID what it said. Everything else failed. */
const CREDENTIAL_SUCCESS_RESULTS = new Set(["ok", "deleted"]);

/**
 * The credential-op audit tap (plan §8.1 W8: *credential-op audit*).
 *
 * `CredentialStore` funnels every op through its two loggers, so tapping them — rather than
 * sprinkling `record…()` calls at each call site — makes the audit impossible to forget: a
 * credential op that is added later and logs like its peers is counted for free, and one that
 * does not log at all is already violating §6.2 for a different reason.
 *
 * The argument is the store's OWN structured field string (`op=credential-read result=ok …`),
 * never provider text and never a caller's input, so parsing it is reading our own format back.
 * The address on that line is ALREADY hashed by the caller; nothing here re-derives or stores it.
 */
export function recordCredentialAudit(fields: string): void {
  const op = /\bop=credential-([a-z-]+)/.exec(fields)?.[1];
  if (op === undefined) return;
  const result = /\bresult=([a-z_]+)/.exec(fields)?.[1] ?? "unknown";

  const audit = own.credentials;
  audit.total += 1;
  if (op === "store") audit.store += 1;
  else if (op === "rotate") audit.rotate += 1;
  else if (op === "read") audit.read += 1;
  else if (op === "revoke") audit.revoke += 1;
  else audit.other += 1;
  if (!CREDENTIAL_SUCCESS_RESULTS.has(result)) audit.failures += 1;
}

/**
 * Reconcile lag (plan §8.1 W8): how long a stored meeting waited for a browser to copy it into
 * the user's own space. A DURATION — the one shape of this metric that carries no identifier.
 * W6's reconcile-ack is the only producer; W4 records it because only the store holds `storedAt`.
 *
 * A negative, NaN or infinite lag is DROPPED rather than recorded: a clock skew or a malformed
 * stamp must not be able to move an alerting metric.
 */
export function recordReconcileLag(ms: number): void {
  if (!Number.isFinite(ms) || ms < 0) return;
  own.reconcileLags.push(ms);
  if (own.reconcileLags.length > RECONCILE_LAG_WINDOW) own.reconcileLags.shift();
  if (ms > own.reconcileMaxMs) own.reconcileMaxMs = ms;
}

export function ingestObservabilityCounters(): {
  credentials: CredentialAuditCounters;
  reconcile: ReconcileLagCounters;
} {
  return {
    credentials: { ...own.credentials },
    reconcile: {
      observations: own.reconcileLags.length,
      p95LagMs: p95(own.reconcileLags),
      maxLagMs: own.reconcileMaxMs,
    },
  };
}

/** Test hook (house `_reset` convention). */
export function _resetIngestObservability(): void {
  own.credentials = emptyCredentialAudit();
  own.reconcileLags = [];
  own.reconcileMaxMs = 0;
}

// ── The snapshot ─────────────────────────────────────────────────────

/**
 * Every field is a `number`. See rule 1 in the file header — this is the redaction, not a
 * convention alongside it.
 */
export interface IngestObservabilitySnapshot {
  /** Every delivery the post-ack seam saw, cohort or not (W1's `onDelivery`). */
  deliveries: number;
  /** The cohort subset handed to the worker. */
  nudged: number;
  /** Deliveries the seam could not classify or hand over. The timer sweep is the backstop. */
  deliveryErrors: number;
  fetchOk: number;
  /** Requeued + dead-lettered: with `fetchOk` these partition every settled item. */
  fetchFail: number;
  deadLettered: number;
  /** Live dead-letter entries across the cohort, summed sequentially. */
  dlqDepth: number;
  /** Tenants whose dead-letter could not be read. `dlqDepth` is a FLOOR when this is non-zero. */
  dlqUnreadable: number;
  /** Content dropped to a cap: per-user oldest-drop plus per-meeting reject. */
  overflowDrops: number;
  contentWriteFailures: number;
  reconciled: number;
  reconcileLagP95Ms: number;
  fetchLagP95Ms: number;
  slaBreaches: number;
  credentialOps: CredentialAuditCounters;
  cohortSize: number;
}

/** The dead-letter surface the collector reads. `ConnectorQueue` satisfies it structurally. */
export interface DeadLetterReader {
  dead(source: string, address: string): Promise<DeadItem[]>;
}

export interface IngestObservabilityDeps {
  /**
   * W3's worker counters. Defaults to the process's single running worker (D4), looked up per
   * emit rather than captured once — the reporter is built at startup and the worker may claim
   * its seat later, or never, in a deployment that has not enabled backend ingestion.
   */
  worker?: () => FetchWorkerStats | null;
  /** W4's store counters. */
  content?: () => ContentStoreStats;
  deadLetters?: DeadLetterReader;
  /** `IngestModeService.cohort` — the addresses whose queues are the worker's to drain. */
  cohort?: () => Promise<ReadonlySet<string>>;
  sources?: readonly string[];
  /** Defaults to the process-wide nudge counters; injectable for tests. */
  nudge?: () => { nudged: number; skipped: number; noWorker: number; errors: number };
}

/**
 * Read every counter once. NEVER throws: an observability read that can take down its caller is
 * worse than no observability at all, and every failure it swallows is itself a counter.
 */
export async function collectIngestObservability(
  deps: IngestObservabilityDeps,
): Promise<IngestObservabilitySnapshot> {
  const worker = safeRead(deps.worker ?? (() => runningFetchWorkerStats()));
  const content = safeRead(deps.content);
  const nudge = safeRead(deps.nudge ?? (() => ingestNudgeStats())) ?? {
    nudged: 0,
    skipped: 0,
    noWorker: 0,
    errors: 0,
  };
  const audit = ingestObservabilityCounters();
  const dlq = await readDeadLetterDepth(deps);

  return {
    deliveries: nudge.nudged + nudge.skipped + nudge.noWorker + nudge.errors,
    nudged: nudge.nudged,
    deliveryErrors: nudge.errors + nudge.noWorker,
    fetchOk: worker?.fetched ?? 0,
    fetchFail: (worker?.failed ?? 0) + (worker?.deadLettered ?? 0),
    deadLettered: worker?.deadLettered ?? 0,
    dlqDepth: dlq.depth,
    dlqUnreadable: dlq.unreadable,
    overflowDrops:
      (content?.droppedOverflow ?? 0) + (content?.rejectedTooLarge ?? 0),
    contentWriteFailures: content?.writeFailures ?? 0,
    reconciled: content?.reconciled ?? 0,
    reconcileLagP95Ms: audit.reconcile.p95LagMs,
    fetchLagP95Ms: worker?.p95LagMs ?? 0,
    slaBreaches: worker?.slaBreaches ?? 0,
    credentialOps: audit.credentials,
    cohortSize: dlq.cohortSize,
  };
}

async function readDeadLetterDepth(
  deps: IngestObservabilityDeps,
): Promise<{ depth: number; unreadable: number; cohortSize: number }> {
  const reader = deps.deadLetters;
  if (reader === undefined || deps.cohort === undefined) {
    return { depth: 0, unreadable: 0, cohortSize: 0 };
  }

  let cohort: ReadonlySet<string>;
  try {
    cohort = await deps.cohort();
  } catch {
    // An unreadable cohort is not an empty one. No detail is logged here: the cohort reader
    // already logged its own failure with its own hashed fields.
    return { depth: 0, unreadable: 1, cohortSize: 0 };
  }

  const sources = deps.sources ?? OBSERVABILITY_SOURCES;
  let depth = 0;
  let unreadable = 0;
  // SEQUENTIAL, on purpose — see the file header. One tenant, one source, at a time.
  for (const address of cohort) {
    for (const source of sources) {
      try {
        depth += (await reader.dead(source, address)).length;
      } catch {
        unreadable += 1;
      }
    }
  }
  return { depth, unreadable, cohortSize: cohort.size };
}

function safeRead<T>(read: (() => T) | undefined): T | null {
  if (read === undefined) return null;
  try {
    return read();
  } catch {
    return null;
  }
}

// ── Alerts (plan §8.1 W8: thresholds for DLQ growth + SLA breach) ────

export type IngestAlertCode =
  | "dlq_depth"
  | "dlq_growth"
  | "dlq_unreadable"
  | "sla_breach"
  | "fetch_lag";

export interface IngestAlert {
  code: IngestAlertCode;
  value: number;
  threshold: number;
}

/**
 * Compare a snapshot against the previous one. `previous` is optional because the first emit of a
 * process has nothing to compare against — and a growth alert on a cold start would be an alert
 * about the process having started.
 */
export function evaluateIngestAlerts(
  current: IngestObservabilitySnapshot,
  previous?: IngestObservabilitySnapshot,
): IngestAlert[] {
  const alerts: IngestAlert[] = [];

  if (current.dlqDepth > DLQ_DEPTH_THRESHOLD) {
    alerts.push({
      code: "dlq_depth",
      value: current.dlqDepth,
      threshold: DLQ_DEPTH_THRESHOLD,
    });
  }
  if (previous !== undefined) {
    const growth = current.dlqDepth - previous.dlqDepth;
    if (growth > DLQ_GROWTH_THRESHOLD) {
      alerts.push({
        code: "dlq_growth",
        value: growth,
        threshold: DLQ_GROWTH_THRESHOLD,
      });
    }
  }
  if (current.dlqUnreadable > 0) {
    // The depth is a floor, so neither of the two alerts above can be trusted to be quiet.
    alerts.push({
      code: "dlq_unreadable",
      value: current.dlqUnreadable,
      threshold: 0,
    });
  }
  if (current.slaBreaches > 0) {
    alerts.push({
      code: "sla_breach",
      value: current.slaBreaches,
      threshold: 0,
    });
  }
  if (current.fetchLagP95Ms > FETCH_LAG_THRESHOLD_MS) {
    alerts.push({
      code: "fetch_lag",
      value: current.fetchLagP95Ms,
      threshold: FETCH_LAG_THRESHOLD_MS,
    });
  }
  return alerts;
}

// ── The operator surface ─────────────────────────────────────────────

export interface IngestObservabilityReporterOptions {
  intervalMs?: number;
  /**
   * Whether THIS process should be the one reporting. Wired to the D4 lease
   * (`IngestInstanceSupervisor.guard.isHolder()`): an instance that refused the seat ingests
   * nothing, so its periodic line describes a system it is not part of — and during a rolling
   * deploy two instances would emit contradicting numbers for one cohort, which is the opposite of
   * what this surface is for. Defaults to "yes": a caller that does not gate still reports.
   *
   * It gates the TIMER, not {@link IngestObservabilityReporter.emit} — an operator (or a test) that
   * asks for a snapshot by hand still gets one.
   */
  enabled?: () => boolean;
}

/**
 * The operator surface delta 9 asks for ("DLQ depth visible in an operator surface").
 *
 * It is the STRUCTURED LOG STREAM rather than an HTTP endpoint, and that is a deliberate choice:
 * an ops endpoint on this backend would be a new unauthenticated-or-nearly surface on a public
 * CVM whose whole purpose is to describe the state of other people's meetings. The log stream is
 * where every peer module already reports, an operator already has it, and — because the snapshot
 * is numbers only — nothing on it is worth stealing.
 *
 * One reporter per process (D4). `start()` twice leaves one timer, and the timer is unref'd so an
 * observability loop can never be the reason a process refuses to exit.
 */
export class IngestObservabilityReporter {
  private timer: ReturnType<typeof setInterval> | null = null;
  private previous: IngestObservabilitySnapshot | null = null;

  constructor(
    private readonly deps: IngestObservabilityDeps,
    private readonly options: IngestObservabilityReporterOptions = {},
  ) {}

  get running(): boolean {
    return this.timer !== null;
  }

  /**
   * Collect, emit, remember. Returns what it emitted so a caller (and the acceptance suite) can
   * assert on the numbers rather than on the text.
   */
  async emit(): Promise<{
    snapshot: IngestObservabilitySnapshot;
    alerts: IngestAlert[];
  }> {
    const snapshot = await collectIngestObservability(this.deps);
    const alerts = evaluateIngestAlerts(snapshot, this.previous ?? undefined);
    this.previous = snapshot;

    logObs(
      `op=snapshot deliveries=${snapshot.deliveries} nudged=${snapshot.nudged} ` +
        `delivery_errors=${snapshot.deliveryErrors} fetch_ok=${snapshot.fetchOk} ` +
        `fetch_fail=${snapshot.fetchFail} dead_lettered=${snapshot.deadLettered} ` +
        `dlq_depth=${snapshot.dlqDepth} dlq_unreadable=${snapshot.dlqUnreadable} ` +
        `overflow_drops=${snapshot.overflowDrops} ` +
        `content_write_failures=${snapshot.contentWriteFailures} ` +
        `reconciled=${snapshot.reconciled} ` +
        `reconcile_lag_p95_ms=${snapshot.reconcileLagP95Ms} ` +
        `fetch_lag_p95_ms=${snapshot.fetchLagP95Ms} ` +
        `sla_breaches=${snapshot.slaBreaches} ` +
        `cred_ops=${snapshot.credentialOps.total} ` +
        `cred_failures=${snapshot.credentialOps.failures} ` +
        `cohort=${snapshot.cohortSize}`,
    );
    for (const alert of alerts) {
      warnObs(
        `op=alert code=${alert.code} value=${alert.value} threshold=${alert.threshold}`,
      );
    }
    return { snapshot, alerts };
  }

  start(): void {
    if (this.timer !== null) return;
    const intervalMs = this.options.intervalMs ?? OBSERVABILITY_INTERVAL_MS;
    this.timer = setInterval(() => {
      // Not the holder ⇒ not the reporter. Checked per tick rather than at `start()`, because the
      // seat can be taken (or lost) at any tick of the supervisor's own timer.
      if (this.options.enabled?.() === false) return;
      // Fire-and-forget by design: `emit` never rejects, and a reporter that could reject into a
      // timer callback would be an unhandled rejection on a periodic schedule.
      void this.emit().catch(() => {
        warnObs(`op=emit result=${GENERIC_CALLER_ERROR}`);
      });
    }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }
}

// ── Small helpers ────────────────────────────────────────────────────

function logObs(fields: string): void {
  console.log(`${OBSERVABILITY_LOG_PREFIX} ${fields} t=${new Date().toISOString()}`);
}

function warnObs(fields: string): void {
  console.warn(`${OBSERVABILITY_LOG_PREFIX} ${fields} t=${new Date().toISOString()}`);
}

function p95(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * 0.95) - 1),
  );
  return sorted[index]!;
}
