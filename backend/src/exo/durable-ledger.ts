import { assertKvResult } from "@tinyboilerplate/server";
import { isKvPreconditionFailed, readVersionedKv, type ExoKvGetOptions, type ExoKvPutOptions } from "./activated-grant.js";
import {
  attachEntry,
  clearEntry,
  evaluateStart,
  parseLedgerEntry,
  snapshotOf,
  type ExoLedgerEntry,
  type ExoStartGate,
  type ExoStartResult,
} from "./ledger-model.js";
import { EXO_NAMESPACE, type ExoCapability, type ExoLedger } from "./mailbox.js";

/** Backend-space KV. Writes are conditional. Callers route writes through the shared backend storage lane. */
export interface ExoLedgerKv {
  get(key: string, options: ExoKvGetOptions): Promise<unknown>;
  put(key: string, value: unknown, options: ExoKvPutOptions): Promise<unknown>;
}

const MAX_ENTRY_RESPONSE_BYTES = 16 * 1024;
/** Compare-and-set attempts per mutation. Exhausting them throws, so the mailbox settles the job unavailable. */
const MAX_ATTEMPTS = 8;

function ledgerKey(owner: string, capability: ExoCapability): string {
  return `${EXO_NAMESPACE}/ledger/${owner}/${capability}`;
}

async function readEntry(kv: ExoLedgerKv, key: string): Promise<{ entry: ExoLedgerEntry; etag: string } | undefined> {
  const read = readVersionedKv(await kv.get(key, { source: "network", maxResponseBytes: MAX_ENTRY_RESPONSE_BYTES }), key);
  if (read === undefined) return undefined;
  return { entry: parseLedgerEntry(read.value), etag: read.etag };
}

/**
 * Read-modify-write under compare-and-set. `step` sees the entry read in this attempt and returns what to write,
 * or no `next` when nothing changes. A lost race re-reads and re-evaluates, so no decision is made on a stale entry.
 */
async function mutate<T>(
  kv: ExoLedgerKv,
  owner: string,
  capability: ExoCapability,
  step: (entry: ExoLedgerEntry | undefined) => { result: T; next?: ExoLedgerEntry },
): Promise<T> {
  const key = ledgerKey(owner, capability);
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const current = await readEntry(kv, key);
    const { result, next } = step(current?.entry);
    if (next === undefined) return result;
    const write = await kv.put(key, next, current === undefined ? { ifNoneMatch: "*" } : { ifMatch: current.etag });
    if (isKvPreconditionFailed(write)) continue;
    assertKvResult(write);
    return result;
  }
  throw new Error("Exo ledger compare-and-set retries exhausted");
}

/**
 * Ledger state in backend-space KV. Restart-durable: cooldowns, daily counts, the active run, and coalesced wakes
 * live in the node, not in process memory. Every mutation is compare-and-set on the entry's etag, and the start gate
 * is evaluated inside that same write, so two writers cannot both admit a run for one (owner, capability).
 */
export function createDurableExoLedger(kv: ExoLedgerKv): ExoLedger {
  return {
    async snapshot(owner, capability, now) {
      const current = await readEntry(kv, ledgerKey(owner, capability));
      return snapshotOf(current?.entry, now);
    },
    recordStart(owner, capability, jobId, now, gate: ExoStartGate): Promise<ExoStartResult> {
      return mutate(kv, owner, capability, (entry) => evaluateStart(entry, jobId, now, gate));
    },
    async attach(owner, capability, jobId) {
      await mutate(kv, owner, capability, (entry) => ({ result: undefined, next: attachEntry(entry, jobId) }));
    },
    clearActive(owner, capability, jobId) {
      return mutate(kv, owner, capability, (entry) => {
        const cleared = clearEntry(entry, jobId);
        return { result: cleared.released, next: cleared.next };
      });
    },
  };
}
