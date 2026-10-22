import { describe, expect, test } from "bun:test";
import { createExoActivatedGrant, type ExoActivatedGrant, type ExoKvAccess } from "../exo/activated-grant.js";
import { createOwnerGrantOpener, createExoStorePorts, type ExoBackendKv } from "../exo/stores.js";
import { EXO_NAMESPACE, JOB_MESSAGE, type ExoJobRecord } from "../exo/mailbox.js";
import { EXO_JOBS_PREFIX, EXO_REQUESTS_PREFIX } from "../delegation-verify.js";
import { EXO_SYNC_GRANT_KIND } from "@tinyboilerplate/server";
import { GrantHolderIndex } from "../exo/grant-holders.js";

// EIP-55 reference address (checksum case is part of the value).
const OWNER = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
const OWNER_LC = OWNER.toLowerCase();
const SPACE = `tinycloud:pkh:eip155:1:${OWNER}:applications`;
const GRANT = { policy: "exo-sync" as const, ownerAddress: OWNER_LC, chainId: 1, spaceId: SPACE };
const JOB_ID = "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed";
const JOB_ID_2 = "2c9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed";
const NOW = 1_700_000_000_000;
const MIRROR_KEY = `${EXO_NAMESPACE}/mirror/jobs/${OWNER_LC}/${JOB_ID}`;
const OWNER_JOB_KEY = `${EXO_JOBS_PREFIX}${JOB_ID}`;
const PRECONDITION = { ok: false, error: { code: "KV_PRECONDITION_FAILED", message: "exists" } };

interface OwnerKv extends ExoKvAccess {
  entries: Map<string, unknown>;
  getOptions: unknown[];
}

/** In-process owner-space KV with the accessor's envelopes and `ifNoneMatch` create-only semantics. */
function ownerKv(): OwnerKv {
  const entries = new Map<string, unknown>();
  const kv: OwnerKv = {
    entries,
    getOptions: [],
    async get(key, options) {
      kv.getOptions.push(options);
      return { ok: true, data: { data: entries.get(key) } };
    },
    async list({ prefix }) {
      return { ok: true, data: { keys: [...entries.keys()].filter((key) => key.startsWith(prefix)) } };
    },
    async put(key, value, options) {
      if (options?.ifNoneMatch === "*" && entries.has(key)) return PRECONDITION;
      entries.set(key, value);
      return { ok: true };
    },
    async delete(key) {
      entries.delete(key);
      return { ok: true };
    },
  };
  return kv;
}

interface BackendKv extends ExoBackendKv {
  entries: Map<string, unknown>;
  failPutKeys: Set<string>;
}

/** In-process backend-space KV. Missing-key deletes return the SDK's exact not-found shape. */
function backendKv(): BackendKv {
  const entries = new Map<string, unknown>();
  const kv: BackendKv = {
    entries,
    failPutKeys: new Set(),
    async get(key) {
      if (!entries.has(key)) {
        return { ok: false, error: { code: "KV_NOT_FOUND", service: "kv", message: `Key not found: ${key}` } };
      }
      return { ok: true, data: { data: entries.get(key), headers: { etag: "\"etag\"" } } };
    },
    async list(prefix) {
      return { ok: true, data: { keys: [...entries.keys()].filter((key) => key.startsWith(prefix)) } };
    },
    async put(key, value, options) {
      if (kv.failPutKeys.has(key)) return { ok: false, error: { code: "KV_UNAVAILABLE", message: "down" } };
      if (options?.ifNoneMatch === "*" && entries.has(key)) return PRECONDITION;
      entries.set(key, value);
      return { ok: true };
    },
    async delete(key) {
      if (!entries.has(key)) {
        return { ok: false, error: { code: "KV_NOT_FOUND", service: "kv", message: `Key not found: ${key}` } };
      }
      entries.delete(key);
      return { ok: true };
    },
  };
  return kv;
}

interface HarnessOptions {
  /** `undefined` uses the real activated grant over the owner fake; `null` means no active grant. */
  grant?: ExoActivatedGrant | null;
  configs?: Record<string, { source: string }>;
  disabled?: Set<string>;
  configThrows?: boolean;
  /** Holder index for the test; default lists the test owner as holding a grant. */
  holders?: Pick<GrantHolderIndex, "mayHold" | "remove">;
  /** Owner addresses the opener was asked for. */
  opened?: string[];
}

function harness(options: HarnessOptions = {}) {
  const owner = ownerKv();
  const grant = createExoActivatedGrant({ kv: owner }, GRANT);
  const backend = backendKv();
  const ports = createExoStorePorts({
    backendKv: backend,
    openOwnerGrant: async (address) => {
      options.opened?.push(address);
      return options.grant === undefined ? grant : options.grant;
    },
    webhooks: {
      config: async (address) => {
        if (options.configThrows) throw new Error("webhook store down");
        return options.configs?.[address] ?? null;
      },
    },
    controls: {
      readDisabled: async (address) =>
        options.disabled?.has(address) ? { revokedAt: "2026-01-01T00:00:00.000Z", source: "fireflies" } : null,
    },
    grantHolders:
      options.holders ??
      new GrantHolderIndex({ list: async () => ({ ok: true, data: { keys: [`${EXO_SYNC_GRANT_KIND.keyPrefix}${OWNER_LC}`] } }) }),
    frontendOrigin: "https://app.example",
    now: () => NOW,
  });
  return { owner, backend, ports };
}

function jobRecord(jobId = JOB_ID, state: ExoJobRecord["state"] = "pending"): ExoJobRecord {
  return {
    v: 1,
    jobId,
    capability: "sync-meetings",
    state,
    code: "accepted",
    message: JOB_MESSAGE.accepted,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("exo store ports: requests", () => {
  const requestPath = `${EXO_REQUESTS_PREFIX}sync-meetings/${JOB_ID}`;

  test("refuses to read a request when the owner grant is not active", async () => {
    const { ports } = harness({ grant: null });
    await expect(ports.requests.get(OWNER_LC, requestPath)).rejects.toThrow();
  });

  test("reads requests with a 16 KiB network response bound", async () => {
    const { owner, ports } = harness();
    owner.entries.set(requestPath, { note: "stored" });
    expect(await ports.requests.get(OWNER_LC, requestPath)).toEqual({ note: "stored" });
    expect(owner.getOptions[0]).toEqual({ source: "network", maxResponseBytes: 16 * 1024 });
  });

  test("removes a request record from the owner space", async () => {
    const { owner, ports } = harness();
    owner.entries.set(requestPath, { note: "stored" });
    await ports.requests.remove(OWNER_LC, requestPath);
    expect(owner.entries.has(requestPath)).toBe(false);
  });
});

describe("exo store ports: jobs", () => {
  test("writes the job to the owner space and mirrors it in backend space", async () => {
    const { owner, backend, ports } = harness();
    expect(await ports.jobs.putIfAbsent(OWNER_LC, JOB_ID, jobRecord())).toBe(true);
    expect(owner.entries.get(OWNER_JOB_KEY)).toEqual(jobRecord());
    expect(backend.entries.get(MIRROR_KEY)).toEqual(jobRecord());
  });

  test("creates a job once: a second create returns false and keeps the first record", async () => {
    const { owner, backend, ports } = harness();
    expect(await ports.jobs.putIfAbsent(OWNER_LC, JOB_ID, jobRecord())).toBe(true);
    expect(await ports.jobs.putIfAbsent(OWNER_LC, JOB_ID, jobRecord(JOB_ID, "running"))).toBe(false);
    expect(owner.entries.get(OWNER_JOB_KEY)).toEqual(jobRecord());
    expect(backend.entries.get(MIRROR_KEY)).toEqual(jobRecord());
  });

  test("repairs a missing mirror when a replayed create finds the owner record", async () => {
    const { owner, backend, ports } = harness();
    owner.entries.set(OWNER_JOB_KEY, jobRecord());
    expect(await ports.jobs.putIfAbsent(OWNER_LC, JOB_ID, jobRecord(JOB_ID, "running"))).toBe(false);
    expect(backend.entries.get(MIRROR_KEY)).toEqual(jobRecord());
  });

  test("fails closed when the mirror write fails", async () => {
    const { backend, ports } = harness();
    backend.failPutKeys.add(MIRROR_KEY);
    await expect(ports.jobs.putIfAbsent(OWNER_LC, JOB_ID, jobRecord())).rejects.toThrow();
  });

  test("put updates the owner record and the mirror", async () => {
    const { owner, backend, ports } = harness();
    await ports.jobs.putIfAbsent(OWNER_LC, JOB_ID, jobRecord());
    await ports.jobs.put(OWNER_LC, JOB_ID, jobRecord(JOB_ID, "done"));
    expect(owner.entries.get(OWNER_JOB_KEY)).toEqual(jobRecord(JOB_ID, "done"));
    expect(backend.entries.get(MIRROR_KEY)).toEqual(jobRecord(JOB_ID, "done"));
  });

  test("get reads the owner record", async () => {
    const { ports } = harness();
    await ports.jobs.put(OWNER_LC, JOB_ID, jobRecord());
    expect(await ports.jobs.get(OWNER_LC, JOB_ID)).toEqual(jobRecord());
  });

  test("list returns owner jobs keyed by jobId and skips keys that are not job ids", async () => {
    const { owner, ports } = harness();
    owner.entries.set(OWNER_JOB_KEY, jobRecord());
    owner.entries.set(`${EXO_JOBS_PREFIX}${JOB_ID_2}`, jobRecord(JOB_ID_2));
    owner.entries.set(`${EXO_JOBS_PREFIX}notes/stray`, { stray: true });
    const listed = await ports.jobs.list(OWNER_LC);
    expect(listed.map((entry) => entry.jobId).sort()).toEqual([JOB_ID, JOB_ID_2].sort());
  });

  test("remove deletes the owner record and the mirror", async () => {
    const { owner, backend, ports } = harness();
    await ports.jobs.putIfAbsent(OWNER_LC, JOB_ID, jobRecord());
    await ports.jobs.remove(OWNER_LC, JOB_ID);
    expect(owner.entries.has(OWNER_JOB_KEY)).toBe(false);
    expect(backend.entries.has(MIRROR_KEY)).toBe(false);
  });

  test("remove tolerates a missing mirror", async () => {
    const { owner, ports } = harness();
    owner.entries.set(OWNER_JOB_KEY, jobRecord());
    await ports.jobs.remove(OWNER_LC, JOB_ID);
    expect(owner.entries.has(OWNER_JOB_KEY)).toBe(false);
  });

  test("refuses every job operation when the owner grant is not active", async () => {
    const { ports } = harness({ grant: null });
    await expect(ports.jobs.get(OWNER_LC, JOB_ID)).rejects.toThrow();
    await expect(ports.jobs.put(OWNER_LC, JOB_ID, jobRecord())).rejects.toThrow();
    await expect(ports.jobs.putIfAbsent(OWNER_LC, JOB_ID, jobRecord())).rejects.toThrow();
    await expect(ports.jobs.list(OWNER_LC)).rejects.toThrow();
    await expect(ports.jobs.remove(OWNER_LC, JOB_ID)).rejects.toThrow();
  });

  test("refuses a malformed owner address before any write", async () => {
    const { owner, backend, ports } = harness();
    await expect(ports.jobs.putIfAbsent("not-an-address", JOB_ID, jobRecord())).rejects.toThrow();
    expect(owner.entries.size).toBe(0);
    expect(backend.entries.size).toBe(0);
  });

  test("refuses a job id that is not a UUID before any write", async () => {
    const { owner, backend, ports } = harness();
    await expect(ports.jobs.putIfAbsent(OWNER_LC, "../escape", jobRecord("../escape"))).rejects.toThrow();
    expect(owner.entries.size).toBe(0);
    expect(backend.entries.size).toBe(0);
  });
});

describe("exo store ports: connectors", () => {
  test("is on for the configured Fireflies source with no disabled marker", async () => {
    const { ports } = harness({ configs: { [OWNER_LC]: { source: "fireflies" } } });
    expect(await ports.connectors.isOn(OWNER_LC, "fireflies")).toBe(true);
    expect(await ports.connectors.hasFirefliesWebhook(OWNER_LC)).toBe(true);
  });

  test("maps the google source to the google-meet registry source", async () => {
    const { ports } = harness({ configs: { [OWNER_LC]: { source: "google-meet" } } });
    expect(await ports.connectors.isOn(OWNER_LC, "google")).toBe(true);
    expect(await ports.connectors.isOn(OWNER_LC, "fireflies")).toBe(false);
  });

  test("is off when the configured connector is a different source", async () => {
    const { ports } = harness({ configs: { [OWNER_LC]: { source: "granola" } } });
    expect(await ports.connectors.isOn(OWNER_LC, "fireflies")).toBe(false);
    expect(await ports.connectors.isOn(OWNER_LC, "google")).toBe(false);
  });

  test("is off when the owner has a disabled marker", async () => {
    const { ports } = harness({ configs: { [OWNER_LC]: { source: "fireflies" } }, disabled: new Set([OWNER_LC]) });
    expect(await ports.connectors.isOn(OWNER_LC, "fireflies")).toBe(false);
  });

  test("is off when the owner has no webhook config", async () => {
    const { ports } = harness();
    expect(await ports.connectors.isOn(OWNER_LC, "fireflies")).toBe(false);
  });

  test("fails closed when the webhook config read throws", async () => {
    const { ports } = harness({ configThrows: true });
    expect(await ports.connectors.isOn(OWNER_LC, "fireflies")).toBe(false);
  });
});

describe("exo store ports: grants", () => {
  test("reports an active grant when the opener yields one", async () => {
    const { ports } = harness();
    expect(await ports.grants.isActive(OWNER_LC)).toBe(true);
  });

  test("reports no active grant when the opener yields none", async () => {
    const { ports } = harness({ grant: null });
    expect(await ports.grants.isActive(OWNER_LC)).toBe(false);
  });

  test("refuses an owner the holder index does not list, without opening a grant", async () => {
    const opened: string[] = [];
    const holders = new GrantHolderIndex({ list: async () => ({ ok: true, data: { keys: [] } }) });
    const { ports } = harness({ holders, opened });
    expect(await ports.grants.isActive(OWNER_LC)).toBe(false);
    expect(opened).toEqual([]);
  });

  test("drops an owner from the index when its grant does not open", async () => {
    const removed: string[] = [];
    const holders = { mayHold: async () => true, remove: (address: string) => removed.push(address) };
    const { ports } = harness({ holders, grant: null });
    expect(await ports.grants.isActive(OWNER_LC)).toBe(false);
    expect(removed).toEqual([OWNER_LC]);
  });

  test("keeps an owner in the index when its grant opens", async () => {
    const removed: string[] = [];
    const holders = { mayHold: async () => true, remove: (address: string) => removed.push(address) };
    const { ports } = harness({ holders });
    expect(await ports.grants.isActive(OWNER_LC)).toBe(true);
    expect(removed).toEqual([]);
  });

  test("refuses a non-address owner without consulting the index", async () => {
    const consulted: string[] = [];
    const holders = {
      mayHold: async (address: string) => {
        consulted.push(address);
        return true;
      },
      remove: () => {},
    };
    const { ports } = harness({ holders });
    expect(await ports.grants.isActive("not-an-address")).toBe(false);
    expect(consulted).toEqual([]);
  });
});

describe("createOwnerGrantOpener", () => {
  // Only the CID hook is bound before the early refusals this block exercises.
  const unusedNode = { computeDelegationCid: async () => "cid" } as unknown as Parameters<typeof createOwnerGrantOpener>[0]["node"];

  test("yields no grant when no grant is stored", async () => {
    const open = createOwnerGrantOpener({
      node: unusedNode,
      backendDid: "did:key:backend",
      configuredHost: "https://host.example",
      grantStore: { load: async () => null },
      now: () => NOW,
    });
    expect(await open(OWNER_LC)).toBeNull();
  });

  test("yields no grant when the stored grant has expired", async () => {
    const open = createOwnerGrantOpener({
      node: unusedNode,
      backendDid: "did:key:backend",
      configuredHost: "https://host.example",
      grantStore: { load: async () => ({ expiresAt: "2020-01-01T00:00:00.000Z", serialized: "x" }) },
      now: () => NOW,
    });
    expect(await open(OWNER_LC)).toBeNull();
  });

  test("yields no grant when the stored grant names another backend", async () => {
    const open = createOwnerGrantOpener({
      node: unusedNode,
      backendDid: "did:key:backend",
      configuredHost: "https://host.example",
      grantStore: {
        load: async () => ({ expiresAt: "2099-01-01T00:00:00.000Z", serialized: "x", delegateDid: "did:key:other" }),
      },
      now: () => NOW,
    });
    expect(await open(OWNER_LC)).toBeNull();
  });
});
