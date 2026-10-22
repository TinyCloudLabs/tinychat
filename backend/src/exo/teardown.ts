import { assertKvResult, isKvMissingKeyResult } from "@tinyboilerplate/server";
import { EXO_JOBS_PREFIX, EXO_REQUESTS_PREFIX } from "../delegation-verify.js";
import { extractKeys } from "../services/connector-drain.js";
import type { ExoActivatedGrant } from "./activated-grant.js";
import { ledgerKey } from "./durable-ledger.js";
import { SOURCES_BY_CAPABILITY } from "./ledger-model.js";
import { EXO_CAPABILITIES, EXO_NAMESPACE } from "./mailbox.js";
import { EXO_MIRROR_JOBS_PREFIX, type ExoBackendKv } from "./stores.js";

export interface ExoTeardownDeps {
  kv: Pick<ExoBackendKv, "list" | "delete">;
  grantStore: { load(owner: string): Promise<{ expiresAt: string } | null> };
  openOwnerGrant(owner: string): Promise<ExoActivatedGrant | null>;
}

/**
 * Removes one owner's Exo rows: owner-space requests and jobs, backend-space mirror jobs, and
 * durable ledger rows. Idempotent: missing keys are not errors, so a retry after a partial failure
 * finishes the work. Does not remove the grant record; the caller removes it last.
 *
 * Owner-space rows are reachable only through an activated grant. A stored grant that has expired
 * cannot be activated by anyone, so its owner-space rows are left alone and the teardown proceeds.
 * A stored grant that is still live but cannot be activated refuses the teardown before any delete:
 * the caller retries until the grant expires, so owner-space rows are never orphaned.
 */
export async function clearExoOwnerState(
  deps: ExoTeardownDeps,
  rawOwner: string,
): Promise<{ ownerSpace: boolean }> {
  // Store keys are built from the lowercased owner (stores.ts ownerKey); normalize here so any caller matches.
  const owner = rawOwner.toLowerCase();
  const stored = await deps.grantStore.load(owner);
  const live = stored !== null && Date.parse(stored.expiresAt) > Date.now();
  const grant = await deps.openOwnerGrant(owner);
  if (grant) {
    for (const path of await grant.requestsList(EXO_REQUESTS_PREFIX)) await grant.requestsRemove(path);
    for (const path of await grant.jobsList(EXO_JOBS_PREFIX)) await grant.jobsRemove(path);
  } else if (live) {
    throw new Error("Exo owner grant is live but cannot be activated; teardown refused until it expires");
  }
  await deleteUnder(deps.kv, `${EXO_MIRROR_JOBS_PREFIX}${owner}/`);
  await deleteUnder(deps.kv, `${EXO_NAMESPACE}/ledger/${owner}/`);
  return { ownerSpace: grant !== null };
}

/**
 * Connector disconnect for one source. Removes the ledger rows of capabilities that read only this
 * source. Capabilities that read several sources (sync-meetings) keep their rows, because the other
 * connector still uses them. Source locks are not touched: a lock held by a running sync must keep
 * its mutual exclusion and expires on its own TTL.
 */
export async function clearExoSourceState(
  kv: Pick<ExoBackendKv, "delete">,
  rawOwner: string,
  source: string,
): Promise<void> {
  const owner = rawOwner.toLowerCase();
  for (const capability of EXO_CAPABILITIES) {
    const sources = SOURCES_BY_CAPABILITY[capability];
    if (sources.length === 1 && sources[0] === source) await deleteKey(kv, ledgerKey(owner, capability));
  }
}

async function deleteKey(kv: Pick<ExoBackendKv, "delete">, key: string): Promise<void> {
  const result = await kv.delete(key);
  if (!isKvMissingKeyResult(result, key)) assertKvResult(result);
}

async function deleteUnder(kv: Pick<ExoBackendKv, "list" | "delete">, prefix: string): Promise<void> {
  const keys = extractKeys(assertKvResult(await kv.list(prefix)));
  for (const key of keys) {
    if (!key.startsWith(prefix)) throw new Error("Exo teardown listing returned a key outside its prefix");
    await deleteKey(kv, key);
  }
}
