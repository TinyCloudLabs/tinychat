import type { HostedUploadStore } from "./assemblyai-hosted.js";

/**
 * Operator-facing view of the hosted AssemblyAI path: JSON events on stdout and the read-only status the
 * probe route serves (routes/assemblyai-status.ts). Names and fields are the contract the Better Stack
 * rules are written from; `alert: true` marks the lines that page (first of a blocked spell, N failures in
 * a row), never every failure. Only coded tokens and counts appear: nothing AssemblyAI sends, no key,
 * handle, transcript id or address. Every number in an event, the heartbeat and the route comes from
 * `status()`, so they cannot disagree.
 *
 *   assemblyai_provider_blocked     { reason, http_status, delayed_jobs }  alert; first refusal of a spell
 *   assemblyai_provider_recovered   { delayed_jobs }                       a submission succeeded after a spell
 *   assemblyai_jobs_failed_in_a_row { count }                              alert; N consecutive terminal failures
 *   assemblyai_worker_heartbeat     { pending_jobs, delayed_jobs, oldest_pending_age_s, consecutive_failed_jobs }
 */

/** Why AssemblyAI refused a request before doing (or billing) any work. */
export type ProviderBlockReason = "billing_blocked" | "key_rejected" | "rate_limited";

export const FAILED_IN_A_ROW = 3;
export const HEARTBEAT_INTERVAL_MS = 60_000;

export type HostedEventSink = (event: Record<string, unknown>) => void;

export const stdoutEvents: HostedEventSink = (event) => {
  console.log(JSON.stringify({ ...event, ts: new Date().toISOString() }));
};

/** Wording of AssemblyAI's insufficient-funds answer (see `classifyProviderRefusal`). */
const BALANCE_MARKERS = ["account balance", "insufficient", "top up", "top-up"];
const RATE_LIMIT_WORDING = /\brate\b|limit|too many/;

/**
 * The refusal class of an AssemblyAI answer, or null when it is anything else. Every class is a definite
 * refusal before work was done: nothing was created or billed.
 *
 *   400 + balance wording  billing_blocked  AssemblyAI's documented insufficient-funds answer, `400 {"error":
 *                                           "Your current account balance is negative. Please top up to continue
 *                                           using the API."}` (docs: pre-recorded-audio/guides/common_errors_and_solutions)
 *   402                    billing_blocked  not known to be sent; accepted in case it ever is
 *   401                    key_rejected     bodies differ per route ("Invalid API key", "Authentication error, ...")
 *   403 + rate wording     rate_limited     AssemblyAI's HTTP rate limit (20,000 requests / 5 min) is a 403
 *   403 otherwise          key_rejected     including a bodiless 403: the safer page
 *   429                    rate_limited
 *
 * Any other 400 is not a refusal (the caller alerts it as `request_rejected`): a reworded balance message
 * must not hide as a quiet failure.
 */
export function classifyProviderRefusal(status: number, body: Uint8Array | null): ProviderBlockReason | null {
  const text = body === null ? "" : new TextDecoder().decode(body).toLowerCase();
  if (status === 400) return BALANCE_MARKERS.some((marker) => text.includes(marker)) ? "billing_blocked" : null;
  if (status === 401) return "key_rejected";
  if (status === 402) return "billing_blocked";
  if (status === 403) return RATE_LIMIT_WORDING.test(text) ? "rate_limited" : "key_rejected";
  if (status === 429) return "rate_limited";
  return null;
}

/** What the status route serves (counts and tokens only). */
export interface HostedStatus {
  hosted_enabled: boolean;
  provider_state: "healthy" | "blocked";
  blocked_reason: ProviderBlockReason | null;
  blocked_http_status: number | null;
  blocked_since: string | null;
  last_error_at: string | null;
  consecutive_failed_jobs: number;
  pending_jobs: number;
  delayed_jobs: number;
  oldest_pending_age_s: number;
  /** Seconds since the last worker iteration (the heartbeat tick); it grows if the tick stops. */
  worker_heartbeat_age_s: number;
  generated_at: string;
}

export class HostedProviderMonitor {
  /** The blocked spell in progress; null while the provider is healthy. Cleared by the next success. */
  private spell: { reason: ProviderBlockReason; httpStatus: number; since: number } | null = null;
  private failedInARow = 0;
  private lastErrorAt: number | null = null;
  private store: Pick<HostedUploadStore, "pendingStats"> | null = null;
  private lastIterationAt: number;

  constructor(
    private readonly sink: HostedEventSink = stdoutEvents,
    private readonly now: () => number = Date.now,
  ) {
    this.lastIterationAt = now();
  }

  /** The store whose jobs the counts describe; null (the default) is hosted mode off. */
  attach(store: Pick<HostedUploadStore, "pendingStats"> | null): void {
    this.store = store;
  }

  /** A submission was refused. Alerts on the first of a spell, and again only when the cause changes. */
  blocked(reason: ProviderBlockReason, httpStatus: number): void {
    const changed = this.spell?.reason !== reason;
    this.lastErrorAt = this.now();
    this.spell = { reason, httpStatus, since: changed ? this.lastErrorAt : this.spell!.since };
    if (changed) this.sink({ event: "assemblyai_provider_blocked", reason, http_status: httpStatus, delayed_jobs: this.status().delayed_jobs, alert: true });
  }

  /** A submission succeeded; ends a blocked spell. */
  succeeded(): void {
    this.failedInARow = 0;
    if (this.spell === null) return;
    this.spell = null;
    this.sink({ event: "assemblyai_provider_recovered", delayed_jobs: this.status().delayed_jobs });
  }

  /**
   * A job ended terminally failed: always the latest error. A shutdown or deadline abort (`aborted`) is not
   * AssemblyAI failing jobs, so it never counts toward the streak (a deploy must not page).
   */
  failed(aborted = false): void {
    this.lastErrorAt = this.now();
    if (aborted) return;
    this.failedInARow++;
    if (this.failedInARow === FAILED_IN_A_ROW) this.sink({ event: "assemblyai_jobs_failed_in_a_row", count: this.status().consecutive_failed_jobs, alert: true });
  }

  /** One worker iteration: records it and writes the heartbeat line. Run every `HEARTBEAT_INTERVAL_MS`, only while hosted mode is on. */
  heartbeat(): void {
    this.lastIterationAt = this.now();
    const status = this.status();
    this.sink({
      event: "assemblyai_worker_heartbeat",
      pending_jobs: status.pending_jobs,
      delayed_jobs: status.delayed_jobs,
      oldest_pending_age_s: status.oldest_pending_age_s,
      consecutive_failed_jobs: status.consecutive_failed_jobs,
    });
  }

  /** The one snapshot of the live state: the route serves it, the heartbeat and the events are cut from it. */
  status(): HostedStatus {
    const now = this.now();
    const counts = this.store?.pendingStats(now) ?? { pending: 0, delayed: 0, oldestAgeSeconds: 0 };
    return {
      hosted_enabled: this.store !== null,
      provider_state: this.spell ? "blocked" : "healthy",
      blocked_reason: this.spell?.reason ?? null,
      blocked_http_status: this.spell?.httpStatus ?? null,
      blocked_since: this.spell ? new Date(this.spell.since).toISOString() : null,
      last_error_at: this.lastErrorAt === null ? null : new Date(this.lastErrorAt).toISOString(),
      consecutive_failed_jobs: this.failedInARow,
      pending_jobs: counts.pending,
      delayed_jobs: counts.delayed,
      oldest_pending_age_s: counts.oldestAgeSeconds,
      worker_heartbeat_age_s: this.store === null ? 0 : Math.max(0, Math.floor((now - this.lastIterationAt) / 1000)),
      generated_at: new Date(now).toISOString(),
    };
  }
}
