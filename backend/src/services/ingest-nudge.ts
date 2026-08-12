import { redactedErrorMessage } from "./webhook-tokens.js";
import { cohortLogField, type IngestModeLookup } from "./ingest-mode.js";

/**
 * W1 — the `onDelivery` seam, finally wired (backend-ingest plan §8.1 W1; §8.2 delta items 1
 * and 7; §9 anti-patterns 1 and 2).
 *
 * The public delivery route has always exposed a post-ack hook and, under Option C, deliberately
 * left it unwired: with the browser as the only writer, enqueueing the id WAS the whole
 * server-side job. Under the cohort's backend ingest there IS a consumer — W3's fetch worker —
 * and it wants to hear about a delivery immediately rather than waiting out its timer sweep.
 *
 * Two invariants this module exists to keep:
 *
 *  - **CAPTURE-BEFORE-ACK (AP 2).** Everything here runs strictly AFTER the 202 has been
 *    written. Nothing in this file may be awaited by the response path, and nothing in it may
 *    throw out of the hook — a fetch is *never* inside the delivery window. Fireflies needs a
 *    2xx in under 10 s; a synchronous fetch is precisely how Listen lost deliveries.
 *  - **PER-DELIVERY TENANT RESOLUTION (AP 1).** The nudge carries the address THIS delivery's
 *    signed token resolved to. Nothing here stores a "current user" or a "latest address": the
 *    registered worker is address-less, and the mode check is a membership test.
 *
 * The worker itself lands in W3. Until then the seam is registered-but-empty: a nudge with no
 * worker is a COUNTED no-op, not a silent one, so "the worker never got wired" is visible.
 */

export interface FetchWorkerNudgeInput {
  source: string;
  address: string;
}

/** The one method W3's worker must expose to this seam. */
export interface FetchWorkerNudge {
  nudge(input: FetchWorkerNudgeInput): void | Promise<void>;
}

/**
 * One registration per process (D4: single instance). It holds no per-user state — see the AP 1
 * note above; a second worker would be a second queue consumer, so registration REPLACES.
 */
let registered: FetchWorkerNudge | null = null;

interface NudgeStats {
  /** Cohort deliveries handed to the worker. */
  nudged: number;
  /** Non-cohort deliveries — Option C, nothing to do. */
  skipped: number;
  /** Cohort deliveries that found no worker registered. */
  noWorker: number;
  /** Mode reads or worker calls that failed. The timer sweep is the backstop. */
  errors: number;
}

const stats: NudgeStats = { nudged: 0, skipped: 0, noWorker: 0, errors: 0 };

/** W3 calls this at startup. Passing `null` unregisters (teardown, tests). */
export function registerFetchWorkerNudge(worker: FetchWorkerNudge | null): void {
  registered = worker;
}

/** Test hook (house `_reset` convention, cf. `billing/stripe.ts`). */
export function _resetFetchWorkerNudge(): void {
  registered = null;
  stats.nudged = 0;
  stats.skipped = 0;
  stats.noWorker = 0;
  stats.errors = 0;
}

/**
 * W8's counters for this seam. Deliberately carries NO meeting identifier and no address — a
 * per-meeting counter is a client-visible identifier by another name (§6.3).
 */
export function ingestNudgeStats(): Readonly<NudgeStats> {
  return { ...stats };
}

export interface IngestOnDeliveryOptions {
  modes: IngestModeLookup;
  /** Defaults to the process registration; injectable for tests and for W3's own wiring. */
  worker?: () => FetchWorkerNudge | null;
}

/**
 * Build the `onDelivery` hook. The returned function NEVER rejects: the delivery route already
 * answered 202, and an unhandled rejection out of a fire-and-forget hook on an unauthenticated
 * route is an availability bug, not a diagnostic.
 */
export function createIngestOnDelivery(
  options: IngestOnDeliveryOptions,
): (input: FetchWorkerNudgeInput) => Promise<void> {
  const worker = options.worker ?? (() => registered);

  return async (input: FetchWorkerNudgeInput): Promise<void> => {
    let mode: string;
    try {
      mode = await options.modes.mode(input.address);
    } catch (error) {
      // FAIL CLOSED means "do not guess", not "do not proceed": the item is already durably
      // queued, so the worker's sweep still collects it. What must not happen is a silent skip.
      stats.errors += 1;
      logNudgeWarn(
        `op=nudge result=mode_unavailable source=${input.source} ${cohortLogField(input.address)}`,
      );
      console.warn(
        "[connector-ingest] ingest-mode read failed:",
        redactedErrorMessage(error),
      );
      return;
    }

    if (mode !== "backend") {
      // The byte-identical Option C path: no worker, no log line, no cost.
      stats.skipped += 1;
      return;
    }

    const target = worker();
    if (target === null) {
      stats.noWorker += 1;
      logNudgeWarn(
        `op=nudge result=no_worker source=${input.source} ${cohortLogField(input.address)}`,
      );
      return;
    }

    try {
      // Awaited so a rejection is caught HERE; the caller is already fire-and-forget, so this
      // await costs the response nothing (§4.6 — the 202 is long gone).
      await target.nudge({ source: input.source, address: input.address });
      stats.nudged += 1;
    } catch (error) {
      stats.errors += 1;
      logNudgeWarn(
        `op=nudge result=error source=${input.source} ${cohortLogField(input.address)}`,
      );
      console.warn(
        "[connector-ingest] fetch-worker nudge failed:",
        redactedErrorMessage(error),
      );
    }
  };
}

function logNudgeWarn(fields: string): void {
  console.warn(`[connector-ingest] ${fields} t=${new Date().toISOString()}`);
}
