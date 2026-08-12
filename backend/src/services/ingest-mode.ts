import type { TinyCloudNode } from "@tinycloud/node-sdk";
import * as serverPackage from "@tinyboilerplate/server";
import { keyedLogHash, normalizeWebhookAddress } from "./webhook-tokens.js";

const { assertKvResult, withSessionRefresh } = serverPackage;
const { isKvMissingKeyResult } = serverPackage as typeof serverPackage & {
  isKvMissingKeyResult: (result: unknown, key: string) => boolean;
};

/**
 * W1 — the per-address INGEST MODE (backend-ingest plan §8.1 W1, §5.3, §12.1).
 *
 * Two independent switches decide whether a given address's deliveries are consumed by the
 * BROWSER (Option C, shipped) or by the backend fetch worker (hardened Option B, W3):
 *
 *  1. `CONNECTOR_BACKEND_INGEST_ENABLED` — the process-wide flag, **dark by default** (the name
 *     is fixed by the decision record; do not rename it here). Off means this module makes ZERO
 *     node calls and every address is `browser` — Option C is not merely "the fallback", it is
 *     the untouched, unre-decided path.
 *  2. A per-address cohort allowlist in the backend's OWN config KV (D5: operator-only, a single
 *     dark address to start). Membership is a SET test, never a stored "current user" — §8.2
 *     delta item 1 / §9 anti-pattern 1 (Listen's global single-user routing) turns on exactly
 *     that distinction.
 *
 * FAIL CLOSED. A cohort read that fails, or a stored value that does not parse, REJECTS. It is
 * never read as "this address is not in the cohort", because that reading silently hands a
 * cohort address back to the browser drain while the worker is also consuming its queue — the
 * double-drain race §5.3 exists to exclude. Callers decide what a rejection means for them: the
 * post-ack nudge counts it and skips (the 202 already shipped; the worker's timer sweep is the
 * backstop), the companions answer 503.
 *
 * Keys are backend-own and auto-prefixed under `ops.tinychat.backend` — they do NOT carry the
 * full `xyz.tinycloud.tinychat/…` user-space path.
 */

/** The env flag, per the decision record's `Flag-name`. Dark default. */
export const BACKEND_INGEST_FLAG = "CONNECTOR_BACKEND_INGEST_ENABLED";

/** Backend-own config key holding the operator's cohort allowlist. */
export const INGEST_COHORT_KEY = "webhooks/ingest/cohort";

/**
 * The cohort is read on the delivery path, so it is cached — a 50-delivery burst must not be a
 * 50-read burst against the single-writer node every tenant shares (findings §2.5).
 */
export const COHORT_CACHE_TTL_MS = 60_000;

/**
 * D5 makes this an operator-only cohort; the cap is a blast-radius bound on a mis-edited key,
 * not a product limit. Over-cap entries are dropped LOUDLY (no silent caps).
 */
export const COHORT_CAP = 100;

export type IngestMode = "browser" | "backend";

/** The slice the delivery path and the companions consume. */
export interface IngestModeLookup {
  mode(address: string): Promise<IngestMode>;
}

export interface IngestCohortRecord {
  addresses: string[];
  updatedAt?: string;
}

function logIngest(fields: string): void {
  console.log(`[connector-ingest] ${fields} t=${new Date().toISOString()}`);
}

function logIngestWarn(fields: string): void {
  console.warn(`[connector-ingest] ${fields} t=${new Date().toISOString()}`);
}

/** Addresses are never logged raw (§6.3). An unset salt drops the field rather than faking it. */
function hashed(value: string): string {
  try {
    return keyedLogHash(value);
  } catch {
    return "unavailable";
  }
}

/**
 * The flag read, in one place. Anything other than the exact string `"true"` is OFF — a typo'd
 * `1`/`yes`/`TRUE` must not enable a feature that reverses two shipped invariants (plan §11).
 */
export function backendIngestEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env[BACKEND_INGEST_FLAG] === "true";
}

export interface IngestModeOptions {
  /** Injectable so a test can pin the flag without mutating the process env. */
  enabled?: () => boolean;
  ttlMs?: number;
  now?: () => number;
}

interface CohortCache {
  addresses: ReadonlySet<string>;
  readAt: number;
}

export class IngestModeService implements IngestModeLookup {
  private readonly enabled: () => boolean;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private cache: CohortCache | null = null;
  /** Coalesces concurrent misses into ONE node read, per §9.3's sequential-storage rule. */
  private inFlight: Promise<ReadonlySet<string>> | null = null;

  constructor(
    private readonly node: TinyCloudNode,
    options: IngestModeOptions = {},
  ) {
    this.enabled = options.enabled ?? (() => backendIngestEnabled());
    this.ttlMs = options.ttlMs ?? COHORT_CACHE_TTL_MS;
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * `backend` only for a flag-on, allow-listed address. Rejects rather than guessing when the
   * cohort cannot be read — see the fail-closed note above.
   */
  async mode(address: string): Promise<IngestMode> {
    // The dark-default short circuit, BEFORE any normalization or node call: with the flag off
    // this method is pure, free, and cannot introduce a failure mode into Option C.
    if (!this.enabled()) return "browser";
    const normalized = normalizeWebhookAddress(address);
    const cohort = await this.cohort();
    return cohort.has(normalized) ? "backend" : "browser";
  }

  /** The allow-listed set, cached for `ttlMs`. Rejects on an unreadable/unparseable value. */
  async cohort(): Promise<ReadonlySet<string>> {
    const cached = this.cache;
    if (cached !== null && this.now() - cached.readAt < this.ttlMs) {
      return cached.addresses;
    }
    if (this.inFlight !== null) return this.inFlight;
    const read = this.read()
      .then((addresses) => {
        this.cache = { addresses, readAt: this.now() };
        return addresses;
      })
      .finally(() => {
        this.inFlight = null;
      });
    this.inFlight = read;
    return read;
  }

  /** Test/operator hook: drop the cache so the next check re-reads (house `_reset` convention). */
  invalidate(): void {
    this.cache = null;
  }

  private async read(): Promise<ReadonlySet<string>> {
    const raw = await this.readJson(INGEST_COHORT_KEY);
    // ABSENT is a legitimate empty cohort — the dark-launch steady state before the operator
    // seeds their own address (§12.1). Only a PRESENT-but-unreadable value fails closed.
    if (raw === null || raw === undefined) return new Set<string>();
    const parsed = parseCohort(raw);
    if (parsed === null) {
      logIngestWarn(`op=cohort-read result=unparseable`);
      throw new Error("Ingest cohort record is unparseable");
    }
    return parsed;
  }

  private async readJson(key: string): Promise<unknown> {
    // §9.3 read-side hardening, same shape as `ConnectorControlStore.readJson`: the SDK resolves
    // `{ok:false,error}` on a durable read failure, and casting that to `undefined` would read
    // as "the cohort is empty" — the most dangerous available reading for an authorization-ish
    // input. The assertion runs INSIDE `withSessionRefresh` so a session-class Result still
    // rides the single retry.
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
    const value = (response as { data?: unknown }).data ?? response;
    if (typeof value !== "string") return value ?? null;
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
}

/**
 * `{addresses:[…]}` → a normalized set. Returns null for anything that is not that shape: a
 * present value we cannot read is a fail-closed rejection, never an empty cohort.
 */
export function parseCohort(raw: unknown): ReadonlySet<string> | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (!Array.isArray(value.addresses)) return null;

  const normalized: string[] = [];
  let malformed = 0;
  for (const entry of value.addresses) {
    try {
      normalized.push(normalizeWebhookAddress(entry));
    } catch {
      // One bad entry does not invalidate the list, but it is counted — a mis-typed cohort
      // address means an operator believes a user is enrolled who is not.
      malformed += 1;
    }
  }
  if (malformed > 0) {
    logIngestWarn(`op=cohort-parse result=malformed_entries dropped=${malformed}`);
  }
  if (normalized.length > COHORT_CAP) {
    // No silent caps: an over-cap cohort means the enrolled set is a floor, not a total.
    logIngestWarn(
      `op=cohort-cap reason=cap cap=${COHORT_CAP} dropped=${normalized.length - COHORT_CAP}`,
    );
  }
  const kept = normalized.slice(0, COHORT_CAP);
  logIngest(`op=cohort-read result=ok size=${kept.length}`);
  return new Set(kept);
}

/** Operator/observability helper: is THIS address enrolled? Hashed, never raw, in any log. */
export function cohortLogField(address: string): string {
  return `aid=${hashed(address.toLowerCase())}`;
}
