import { assertKvResult } from "@tinyboilerplate/server";
import { isKvPreconditionFailed, readVersionedKv, type ExoKvGetOptions, type ExoKvPutOptions } from "./activated-grant.js";
import {
  SOURCES_BY_CAPABILITY,
  acquireSourceLock,
  attachEntry,
  clearEntry,
  evaluateStart,
  limitRefusal,
  parseLedgerEntry,
  parseSourceLock,
  releaseSourceLock,
  snapshotOf,
  stampEntry,
  type ExoSourceGate,
  type ExoStartGate,
  type ExoStartResult,
  type SourceLock,
  type SourceLockStep,
} from "./ledger-model.js";
import { EXO_NAMESPACE, type ConnectorSource, type ExoCapability, type ExoLedger } from "./mailbox.js";
import { extractKeys } from "../services/connector-drain.js";

/** Backend-space KV. Writes are conditional. Callers route writes through the shared backend storage lane. */
export interface ExoLedgerKv {
  get(key: string, options: ExoKvGetOptions): Promise<unknown>;
  put(key: string, value: unknown, options: ExoKvPutOptions): Promise<unknown>;
  list(prefix: string): Promise<unknown>;
}

const MAX_RECORD_RESPONSE_BYTES = 16 * 1024;
/** Compare-and-set attempts per mutation. Exhausting them throws, so the mailbox settles the job unavailable. */
const MAX_ATTEMPTS = 8;

export function ledgerKey(owner: string, capability: ExoCapability): string {
  return `${EXO_NAMESPACE}/ledger/${owner}/${capability}`;
}

function sourceLockKey(owner: string, source: ConnectorSource): string {
  return `${EXO_NAMESPACE}/source-lock/${owner}/${source}`;
}

function heldKey(owner: string, jobId: string): string {
  return `${EXO_NAMESPACE}/held/${owner}/${jobId}`;
}

/** The held job record, or null once released. The mailbox validates the record before use. */
function heldValue(raw: unknown): unknown {
  return typeof raw === "object" && raw !== null && "held" in raw ? raw.held : undefined;
}

async function readRecord<V>(kv: ExoLedgerKv, key: string, parse: (raw: unknown) => V): Promise<{ value: V; etag: string } | undefined> {
  const read = readVersionedKv(await kv.get(key, { source: "network", maxResponseBytes: MAX_RECORD_RESPONSE_BYTES }), key);
  if (read === undefined) return undefined;
  return { value: parse(read.value), etag: read.etag };
}

/**
 * Read-modify-write under compare-and-set. `step` sees the record read in this attempt and returns what to write,
 * or no `next` when nothing changes. A lost race re-reads and re-evaluates, so no decision is made on a stale record.
 */
async function mutate<V, T>(
  kv: ExoLedgerKv,
  key: string,
  parse: (raw: unknown) => V,
  step: (current: V | undefined) => { result: T; next?: V },
): Promise<T> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const current = await readRecord(kv, key, parse);
    const { result, next } = step(current?.value);
    if (next === undefined) return result;
    const write = await kv.put(key, next, current === undefined ? { ifNoneMatch: "*" } : { ifMatch: current.etag });
    if (isKvPreconditionFailed(write)) continue;
    assertKvResult(write);
    return result;
  }
  throw new Error("Exo ledger compare-and-set retries exhausted");
}

/**
 * Takes the source locks in `SOURCES_BY_CAPABILITY` order. On a refusal the locks already taken are freed and the
 * refusal is returned. Two capabilities that read one source are serialized here. Acquisition is not atomic across
 * sources, so a run may briefly hold one source's lock while another source is refused. Callers back off and retry.
 */
async function takeSourceLocks(
  kv: ExoLedgerKv,
  owner: string,
  capability: ExoCapability,
  jobId: string,
  now: number,
): Promise<Extract<ExoStartResult, { started: false }> | undefined> {
  const taken: ConnectorSource[] = [];
  for (const source of SOURCES_BY_CAPABILITY[capability]) {
    const step: SourceLockStep = await mutate(kv, sourceLockKey(owner, source), parseSourceLock, (current): { result: SourceLockStep; next?: SourceLock } => {
      const decided = acquireSourceLock(current, jobId, capability, now);
      return decided.acquired ? { result: decided, next: decided.next } : { result: decided };
    });
    if (!step.acquired) {
      await freeSourceLocks(kv, owner, taken, jobId);
      return { started: false, reason: step.reason, retryAfterMs: step.retryAfterMs };
    }
    taken.push(source);
  }
  return undefined;
}

/** Frees the locks `jobId` holds on `sources`. A lock held by another run is left alone. */
async function freeSourceLocks(kv: ExoLedgerKv, owner: string, sources: readonly ConnectorSource[], jobId: string): Promise<void> {
  for (const source of sources) {
    await mutate(kv, sourceLockKey(owner, source), parseSourceLock, (current) => ({
      result: undefined,
      next: releaseSourceLock(current, jobId),
    }));
  }
}

/**
 * Ledger state in backend-space KV. Restart-durable: cooldowns, daily counts, the active run, coalesced wakes, and
 * source locks live in the node, not in process memory. Every mutation is compare-and-set on the record's etag, and
 * the start gate is evaluated inside that same write, so two writers cannot both admit a run for one capability.
 */
export function createDurableExoLedger(kv: ExoLedgerKv): ExoLedger {
  return {
    async snapshot(owner, capability, now) {
      const current = await readRecord(kv, ledgerKey(owner, capability), parseLedgerEntry);
      return snapshotOf(current?.value, now);
    },
    async recordStart(owner, capability, jobId, now, gate: ExoStartGate, sourceGates: readonly ExoSourceGate[] = []): Promise<ExoStartResult> {
      const sources = SOURCES_BY_CAPABILITY[capability];
      const refused = await takeSourceLocks(kv, owner, capability, jobId, now);
      if (refused) return refused;
      try {
        // Source limits are read before any write. The source locks taken above keep those entries unchanged until the stamp.
        for (const source of sourceGates) {
          const current = await readRecord(kv, ledgerKey(owner, source.capability), parseLedgerEntry);
          const sourceRefusal = limitRefusal(current?.value, now, source.gate);
          if (sourceRefusal) {
            await freeSourceLocks(kv, owner, sources, jobId);
            return sourceRefusal;
          }
        }
        const result = await mutate(kv, ledgerKey(owner, capability), parseLedgerEntry, (entry) => evaluateStart(entry, jobId, now, gate));
        if (!result.started) {
          await freeSourceLocks(kv, owner, sources, jobId);
          return result;
        }
        // Stamped after admission. A failed stamp takes the catch path. Sources stamped before it stay counted: over-counting is the safe direction.
        for (const source of sourceGates) {
          await mutate(kv, ledgerKey(owner, source.capability), parseLedgerEntry, (entry) => ({ result: undefined, next: stampEntry(entry, now) }));
        }
        return result;
      } catch (error) {
        // The original error reaches the caller. Best effort: free the locks and clear the own active run, so a failed start does not hold the capability until its TTL.
        await freeSourceLocks(kv, owner, sources, jobId).catch((): undefined => undefined);
        await mutate(kv, ledgerKey(owner, capability), parseLedgerEntry, (entry) => ({ result: undefined, next: clearEntry(entry, jobId).next })).catch((): undefined => undefined);
        throw error;
      }
    },
    async attach(owner, capability, jobId) {
      await mutate(kv, ledgerKey(owner, capability), parseLedgerEntry, (entry) => ({ result: undefined, next: attachEntry(entry, jobId) }));
    },
    async clearActive(owner, capability, jobId) {
      await freeSourceLocks(kv, owner, SOURCES_BY_CAPABILITY[capability], jobId);
      return mutate(kv, ledgerKey(owner, capability), parseLedgerEntry, (entry) => {
        const cleared = clearEntry(entry, jobId);
        return { result: cleared.released, next: cleared.next };
      });
    },
    async holdJob(owner, jobId, record) {
      await mutate(kv, heldKey(owner, jobId), heldValue, () => ({ result: undefined, next: { held: record } }));
    },
    async heldJob(owner, jobId) {
      return (await readRecord(kv, heldKey(owner, jobId), heldValue))?.value;
    },
    async releaseJob(owner, jobId) {
      await mutate(kv, heldKey(owner, jobId), heldValue, (current) => ({
        result: undefined,
        next: current === undefined || current === null ? undefined : { held: null },
      }));
    },
    async heldJobIds(owner) {
      const prefix = `${EXO_NAMESPACE}/held/${owner}/`;
      const keys = extractKeys(assertKvResult(await kv.list(prefix)));
      return keys.filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length));
    },
  };
}
