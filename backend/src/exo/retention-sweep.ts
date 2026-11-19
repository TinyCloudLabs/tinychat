import { assertKvResult, isKvMissingKeyResult } from "@tinyboilerplate/server";
import { extractKeys } from "../services/connector-drain.js";
import { readVersionedKv } from "./activated-grant.js";
import { EXO_JOB_RETENTION_MS, parseJobRecord, REQUEST_ID_RE, removeExpiredJob, type ExoJobStore, type ExoMailboxPorts } from "./mailbox.js";
import { EXO_MIRROR_JOBS_PREFIX, mirrorJobKey, type ExoBackendKv } from "./stores.js";

/** Interval between passes. The retention window is 30 days, so hourly passes are accurate enough. */
export const EXO_RETENTION_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
/** Bound on how long shutdown waits for an in-flight pass. */
export const EXO_RETENTION_DRAIN_TIMEOUT_MS = 30_000;

const MIRROR_KEY_RE = /\/mirror\/jobs\/(0x[0-9a-f]{40})\/([^/]+)$/;
const MAX_MIRROR_RESPONSE_BYTES = 16 * 1024;

export interface ExoRetentionSweepDeps {
  kv: Pick<ExoBackendKv, "get" | "list" | "delete">;
  ports: Pick<ExoMailboxPorts, "grants" | "ledger" | "requests"> & { jobs: Pick<ExoJobStore, "remove"> };
  now?: () => number;
  retentionMs?: number;
}

export interface ExoRetentionPass {
  /** Expired records removed. */
  removed: number;
  /** Records inside the window, unparseable, or already gone. */
  skipped: number;
  /** Records whose removal threw. The next pass retries them. */
  failed: number;
}

/**
 * One pass over the backend-space job mirrors. Mirrors are listed under the backend's own prefix,
 * so finding them needs no owner grant. An expired mirror is removed through `jobs.remove` (mirror
 * first, then the owner record) while the owner's grant is active. With no active grant the owner
 * record is out of reach, so only the backend's mirror is deleted and the owner record stays in
 * the owner's space. A failed list throws; the timer owns that boundary.
 */
export async function runExoRetentionSweep(deps: ExoRetentionSweepDeps): Promise<ExoRetentionPass> {
  const cutoff = (deps.now ?? Date.now)() - (deps.retentionMs ?? EXO_JOB_RETENTION_MS);
  const keys = extractKeys(assertKvResult(await deps.kv.list(EXO_MIRROR_JOBS_PREFIX)));
  const pass: ExoRetentionPass = { removed: 0, skipped: 0, failed: 0 };
  for (const key of keys) {
    const match = MIRROR_KEY_RE.exec(key);
    if (!match || !REQUEST_ID_RE.test(match[2])) {
      pass.skipped += 1;
      continue;
    }
    const [, owner, jobId] = match;
    try {
      const mirror = mirrorJobKey(owner, jobId);
      const read = readVersionedKv(
        await deps.kv.get(mirror, { source: "network", maxResponseBytes: MAX_MIRROR_RESPONSE_BYTES }),
        mirror,
      );
      const job = read === undefined ? undefined : parseJobRecord(read.value);
      const updated = job ? Date.parse(job.updatedAt) : Number.NaN;
      if (!job || !Number.isFinite(updated) || updated > cutoff) {
        pass.skipped += 1;
        continue;
      }
      if (await deps.ports.grants.isActive(owner)) {
        await removeExpiredJob(deps.ports, owner, jobId, job.capability);
      } else {
        const deleted = await deps.kv.delete(mirror);
        if (!isKvMissingKeyResult(deleted, mirror)) assertKvResult(deleted);
      }
      pass.removed += 1;
    } catch {
      pass.failed += 1;
    }
  }
  return pass;
}

export interface ExoRetentionSweepTimer {
  /** Stops the interval and resolves once an in-flight pass finishes or the drain bound elapses. */
  stop(): Promise<void>;
  /** Runs one pass now. Concurrent calls share the in-flight pass. Never rejects. */
  tick(): Promise<void>;
}

/**
 * Started in `main()` only when the exo flag is ON. Never overlaps passes, never throws into the
 * process, and is `unref()`'d so a test process is not held open by the interval.
 */
export function startExoRetentionSweepTimer(
  deps: ExoRetentionSweepDeps & { intervalMs?: number },
): ExoRetentionSweepTimer {
  let inFlight: Promise<void> | null = null;
  const tick = (): Promise<void> => {
    if (inFlight) return inFlight;
    const pass = (async () => {
      try {
        const result = await runExoRetentionSweep(deps);
        console.log(
          `[exo] retention sweep removed=${result.removed} skipped=${result.skipped} failed=${result.failed}`,
        );
      } catch (error) {
        console.warn(
          "[exo] retention sweep pass failed:",
          error instanceof Error ? error.name : "non-error",
        );
      } finally {
        inFlight = null;
      }
    })();
    inFlight = pass;
    return pass;
  };
  const timer = setInterval(() => {
    void tick();
  }, deps.intervalMs ?? EXO_RETENTION_SWEEP_INTERVAL_MS);
  (timer as unknown as { unref?: () => void }).unref?.();
  return {
    tick,
    stop: async () => {
      clearInterval(timer);
      const pending = inFlight;
      if (!pending) return;
      await Promise.race([
        pending,
        new Promise<void>((resolve) => {
          const handle = setTimeout(resolve, EXO_RETENTION_DRAIN_TIMEOUT_MS);
          void pending.then(() => clearTimeout(handle));
        }),
      ]);
    },
  };
}
