import type { TinyCloudNode } from "@tinycloud/node-sdk";
import { assertKvResult, isKvMissingKeyResult } from "@tinyboilerplate/server";
import { EXO_JOBS_PREFIX, parseStoredGrant } from "../delegation-verify.js";
import { activateVerifiedDelegation } from "../portable-delegation.js";
import { storedDelegationMatchesBackend } from "../routes/delegations.js";
import {
  createExoActivatedGrant,
  type ExoActivatedGrant,
  type ExoKvGetOptions,
  type ExoKvPutOptions,
} from "./activated-grant.js";
import {
  EXO_NAMESPACE,
  parseJobRecord,
  REQUEST_ID_RE,
  type ConnectorSource,
  type ExoJobRecord,
  type ExoMailboxPorts,
} from "./mailbox.js";
import { createDurableExoLedger } from "./durable-ledger.js";

/** Backend-space KV used only for job mirrors. The owner space stays authoritative. */
export interface ExoBackendKv {
  get(key: string, options: ExoKvGetOptions): Promise<unknown>;
  put(key: string, value: unknown, options?: ExoKvPutOptions): Promise<unknown>;
  delete(key: string): Promise<unknown>;
}

export interface ExoStoreDeps {
  backendKv: ExoBackendKv;
  /** Resolves the owner's activated grant, or null when no grant is active. Must not mutate storage. */
  openOwnerGrant(owner: string): Promise<ExoActivatedGrant | null>;
  webhooks: { config(address: string): Promise<{ source: string } | null> };
  /** Only presence matters: a non-null result means the connector is disabled for this owner. */
  controls: { readDisabled(address: string): Promise<unknown> };
  frontendOrigin: string;
  now?: () => number;
}

/** Registry source id for each connector source the wake can name. */
const REGISTRY_SOURCE: Record<ConnectorSource, string> = { fireflies: "fireflies", google: "google-meet" };
const OWNER_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

function normalizeOwner(owner: string): string {
  if (!OWNER_ADDRESS_RE.test(owner)) throw new Error("Exo owner address refused");
  return owner.toLowerCase();
}

function ownerJobPath(jobId: string): string {
  return `${EXO_JOBS_PREFIX}${jobId}`;
}

function mirrorJobKey(owner: string, jobId: string): string {
  return `${EXO_NAMESPACE}/mirror/jobs/${owner}/${jobId}`;
}

function assertJobId(jobId: string): string {
  if (!REQUEST_ID_RE.test(jobId)) throw new Error("Exo job id refused");
  return jobId;
}

/**
 * Store ports over the owner's activated grant. Every request and job operation resolves the
 * grant first and fails closed when none is active. Job state lives in the owner space; the
 * backend-space mirror is written after it and repaired on replay.
 */
export function createExoStorePorts(deps: ExoStoreDeps): Omit<ExoMailboxPorts, "executor"> {
  const now = deps.now ?? Date.now;

  async function requireGrant(owner: string): Promise<{ address: string; grant: ExoActivatedGrant }> {
    const address = normalizeOwner(owner);
    const grant = await deps.openOwnerGrant(address);
    if (!grant) throw new Error("Exo owner grant is not active");
    return { address, grant };
  }

  async function writeMirror(address: string, jobId: string, record: unknown): Promise<void> {
    assertKvResult(await deps.backendKv.put(mirrorJobKey(address, jobId), record));
  }

  return {
    grants: {
      isActive: async (owner) => {
        if (!OWNER_ADDRESS_RE.test(owner)) return false;
        return (await deps.openOwnerGrant(owner.toLowerCase())) !== null;
      },
    },
    requests: {
      get: async (owner, path) => (await requireGrant(owner)).grant.requestsGet(path),
      remove: async (owner, path) => {
        await (await requireGrant(owner)).grant.requestsRemove(path);
      },
    },
    jobs: {
      get: async (owner, jobId) => {
        const { grant } = await requireGrant(owner);
        return grant.jobsGet(ownerJobPath(assertJobId(jobId)));
      },
      putIfAbsent: async (owner, jobId, record: ExoJobRecord) => {
        const { address, grant } = await requireGrant(owner);
        const id = assertJobId(jobId);
        const created = await grant.jobsPutIfAbsent(ownerJobPath(id), record);
        if (created) {
          await writeMirror(address, id, record);
          return true;
        }
        // Replay of a create whose mirror write did not land: the owner record is authoritative.
        const existing = parseJobRecord(await grant.jobsGet(ownerJobPath(id)));
        if (existing) await writeMirror(address, id, existing);
        return false;
      },
      put: async (owner, jobId, record: ExoJobRecord) => {
        const { address, grant } = await requireGrant(owner);
        const id = assertJobId(jobId);
        await grant.jobsPut(ownerJobPath(id), record);
        await writeMirror(address, id, record);
      },
      list: async (owner) => {
        const { grant } = await requireGrant(owner);
        const out: Array<{ jobId: string; value: unknown }> = [];
        for (const key of await grant.jobsList(EXO_JOBS_PREFIX)) {
          const jobId = key.slice(EXO_JOBS_PREFIX.length);
          if (!REQUEST_ID_RE.test(jobId)) continue;
          out.push({ jobId, value: await grant.jobsGet(key) });
        }
        return out;
      },
      remove: async (owner, jobId) => {
        const { address, grant } = await requireGrant(owner);
        const id = assertJobId(jobId);
        // Mirror first: if the owner delete then fails, the owner record survives and replay repairs the mirror.
        const mirror = mirrorJobKey(address, id);
        const mirrorResult = await deps.backendKv.delete(mirror);
        if (!isKvMissingKeyResult(mirrorResult, mirror)) assertKvResult(mirrorResult);
        await grant.jobsRemove(ownerJobPath(id));
      },
    },
    connectors: {
      isOn: async (owner, source) => {
        try {
          const address = normalizeOwner(owner);
          const config = await deps.webhooks.config(address);
          if (config?.source !== REGISTRY_SOURCE[source]) return false;
          return (await deps.controls.readDisabled(address)) === null;
        } catch {
          return false;
        }
      },
      hasFirefliesWebhook: async (owner) => {
        try {
          const address = normalizeOwner(owner);
          const config = await deps.webhooks.config(address);
          return config?.source === REGISTRY_SOURCE.fireflies;
        } catch {
          return false;
        }
      },
    },
    ledger: createDurableExoLedger(deps.backendKv),
    now,
    frontendOrigin: deps.frontendOrigin,
  };
}

export interface StoredGrantRecord {
  expiresAt: string;
  serialized: string;
  policyHash?: string;
  delegateDid?: string;
}

export interface OwnerGrantOpenerConfig {
  node: TinyCloudNode;
  backendDid: string;
  configuredHost: string;
  grantStore: { load(address: string): Promise<StoredGrantRecord | null | undefined> };
  now?: () => number;
}

/**
 * Resolves an owner's stored exo grant into an activated accessor. Mirrors the GET route's checks
 * (expiry, backend match, verification) but never removes a stale grant; the route owns removal.
 * Any failure yields null, so the owner reads as inactive.
 */
export function createOwnerGrantOpener(config: OwnerGrantOpenerConfig): (owner: string) => Promise<ExoActivatedGrant | null> {
  const now = config.now ?? Date.now;
  const deps = { computeDelegationCid: config.node.computeDelegationCid.bind(config.node) };
  return async (owner) => {
    try {
      const address = normalizeOwner(owner);
      const stored = await config.grantStore.load(address);
      if (!stored) return null;
      if (Date.parse(stored.expiresAt) <= now()) return null;
      if (!storedDelegationMatchesBackend(stored, config.backendDid)) return null;
      const parsed = await parseStoredGrant(
        address,
        stored.serialized,
        { backendDid: config.backendDid, configuredHost: config.configuredHost, policy: "exo-sync", now: now() },
        deps,
      );
      if (!parsed.ok) return null;
      if (parsed.verified.ownerAddress !== address) return null;
      const access = await activateVerifiedDelegation(config.node, parsed.verified, { host: config.configuredHost });
      return createExoActivatedGrant({ kv: access.kv }, parsed.verified);
    } catch {
      return null;
    }
  };
}
