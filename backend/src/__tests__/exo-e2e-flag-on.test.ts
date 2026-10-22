import { describe, expect, test } from "bun:test";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { EXO_SYNC_GRANT_KIND } from "@tinyboilerplate/server";
import { createExoActivatedGrant, type ExoKvAccess } from "../exo/activated-grant.js";
import { EXO_JOBS_PREFIX } from "../delegation-verify.js";
import { GrantHolderIndex } from "../exo/grant-holders.js";
import {
  EXO_NAMESPACE,
  type ExecutorUpdate,
  type ExoCapability,
  type ExoJobRecord,
  type SyncExecutor,
} from "../exo/mailbox.js";
import { createExoStorePorts, type ExoBackendKv } from "../exo/stores.js";
import { WakeQueue } from "../exo/wake-intake.js";
import { createExoMailboxRouter } from "../routes/exo-mailbox.js";

// Flag-on path end to end: real store ports, real router over HTTP, real durable ledger.
// Substitutions: the owner grant is an activated grant over an in-process owner-space fake (not a
// live node), and the executor is a recorder. Both KV fakes honour `ifMatch` (etag) and
// `ifNoneMatch: "*"`. Only the lock-conflict test overrides the connector gate; every other test
// uses the real gate fed by a per-owner webhook config.

const NOW = 1_700_000_000_000;
const MINUTE = 60_000;
const OWNER_A = `0x${"a".repeat(40)}`;
const OWNER_B = `0x${"b".repeat(40)}`;
const OWNER_NO_GRANT = `0x${"c".repeat(40)}`;
const R1 = "6f1c2a4e-8b3d-4c5e-9f70-1a2b3c4d5e6f";
const R2 = "7a2b3c4d-1e2f-4a5b-8c9d-0e1f2a3b4c5d";
const R3 = "8b3c4d5e-2f3a-4b6c-9d0e-1f2a3b4c5d6e";

const PRECONDITION = {
  ok: false,
  error: { code: "KV_PRECONDITION_FAILED", service: "kv", message: "precondition failed" },
};

interface OwnerSpace extends ExoKvAccess {
  entries: Map<string, unknown>;
  reads: string[];
}

/** One owner's KV space. Values are stored as given; `ifNoneMatch` is create-only. */
function ownerSpace(): OwnerSpace {
  const entries = new Map<string, unknown>();
  const space: OwnerSpace = {
    entries,
    reads: [],
    async get(key) {
      space.reads.push(key);
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
  return space;
}

interface BackendSpace extends ExoBackendKv {
  entries: Map<string, { value: unknown; version: number }>;
}

/** Backend-space KV with etags: every write bumps the version, and `ifMatch` compares it. */
function backendSpace(): BackendSpace {
  const entries = new Map<string, { value: unknown; version: number }>();
  const kv: BackendSpace = {
    entries,
    async get(key) {
      const row = entries.get(key);
      if (!row) {
        return { ok: false, error: { code: "KV_NOT_FOUND", service: "kv", message: `Key not found: ${key}` } };
      }
      return { ok: true, data: { data: row.value, headers: { etag: `"${row.version}"` } } };
    },
    async list(prefix) {
      return { ok: true, data: { keys: [...entries.keys()].filter((key) => key.startsWith(prefix)) } };
    },
    async put(key, value, options) {
      const row = entries.get(key);
      if (options?.ifNoneMatch === "*" && row) return PRECONDITION;
      if (options?.ifMatch !== undefined && (!row || `"${row.version}"` !== options.ifMatch)) return PRECONDITION;
      entries.set(key, { value, version: (row?.version ?? 0) + 1 });
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

interface Run {
  job: ExoJobRecord;
  report: (update: ExecutorUpdate) => Promise<void>;
}

/** Everything that survives a restart: KV spaces, webhook configs, the clock, and the executor's starts. */
interface World {
  clock: { now: number };
  backend: BackendSpace;
  spaces: Map<string, OwnerSpace>;
  configs: Map<string, { source: string }>;
  runs: Run[];
}

function newWorld(owners: string[]): World {
  const spaces = new Map<string, OwnerSpace>();
  for (const owner of owners) spaces.set(owner, ownerSpace());
  return { clock: { now: NOW }, backend: backendSpace(), spaces, configs: new Map(), runs: [] };
}

function grantOf(address: string) {
  return {
    policy: "exo-sync" as const,
    ownerAddress: address,
    chainId: 1,
    spaceId: `tinycloud:pkh:eip155:1:${address}:applications`,
  };
}

interface Stack {
  app: express.Express;
  queue: WakeQueue;
}

interface StackOptions {
  /** Replaces the connector gate with "every source is on". Only the lock-conflict test uses this. */
  connectorsAllOn?: boolean;
}

/** Builds the flag-on mailbox from the durable state in `world`. Calling it again simulates a restart. */
async function buildStack(world: World, options: StackOptions = {}): Promise<Stack> {
  const grantHolders = new GrantHolderIndex(
    {
      list: async () => ({
        ok: true,
        data: { keys: [...world.spaces.keys()].map((address) => `${EXO_SYNC_GRANT_KIND.keyPrefix}${address}`) },
      }),
    },
    () => world.clock.now,
  );
  await grantHolders.refresh();
  const ports = createExoStorePorts({
    backendKv: world.backend,
    openOwnerGrant: async (address) => {
      const space = world.spaces.get(address);
      return space ? createExoActivatedGrant({ kv: space }, grantOf(address)) : null;
    },
    webhooks: { config: async (address) => world.configs.get(address) ?? null },
    controls: { readDisabled: async () => null },
    grantHolders,
    frontendOrigin: "https://app.example.test",
    now: () => world.clock.now,
  });
  const connectors = options.connectorsAllOn
    ? { ...ports.connectors, isOn: async () => true }
    : ports.connectors;
  const executor: SyncExecutor = {
    start: async (job, report) => {
      world.runs.push({ job, report });
    },
  };
  const queue = new WakeQueue();
  const app = express();
  app.use("/api/exo/v1", createExoMailboxRouter({ ...ports, connectors, executor }, grantHolders, { queue }));
  return { app, queue };
}

async function withServer<T>(stack: Stack, run: (base: string) => Promise<T>): Promise<T> {
  const bound = await new Promise<Server>((resolve) => {
    const started: Server = stack.app.listen(0, "127.0.0.1", () => resolve(started));
  });
  const { port } = bound.address() as AddressInfo;
  try {
    return await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => {
      bound.closeAllConnections();
      bound.close(() => resolve());
    });
  }
}

async function post(base: string, owner: string, requestId: string) {
  const res = await fetch(`${base}/api/exo/v1/requests`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ owner: `did:pkh:eip155:1:${owner}`, requestId }),
  });
  return {
    status: res.status,
    headers: [...res.headers].filter(([name]) => name !== "date"),
    body: await res.text(),
  };
}

/** Waits for the wake lanes, then one macrotask so starts scheduled after a lane task have run. */
async function settle(stack: Stack): Promise<void> {
  await stack.queue.idle();
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function seedRequest(world: World, owner: string, capability: ExoCapability, requestId: string): void {
  world.spaces.get(owner)!.entries.set(`${EXO_NAMESPACE}/requests/${capability}/${requestId}`, {
    v: 1,
    capability,
  });
}

function ownerJob(world: World, owner: string, jobId: string): ExoJobRecord | undefined {
  return world.spaces.get(owner)!.entries.get(`${EXO_JOBS_PREFIX}${jobId}`) as ExoJobRecord | undefined;
}

function ownerJobKeys(world: World, owner: string): string[] {
  return [...world.spaces.get(owner)!.entries.keys()].filter((key) => key.startsWith(EXO_JOBS_PREFIX));
}

function mirrorJob(world: World, owner: string, jobId: string): ExoJobRecord | undefined {
  return world.backend.entries.get(`${EXO_NAMESPACE}/mirror/jobs/${owner}/${jobId}`)?.value as
    | ExoJobRecord
    | undefined;
}

describe("exo flag-on end to end (real stores, real router, recording executor)", () => {
  test("found and not-found replies are byte-identical, and only the found request starts", async () => {
    const world = newWorld([OWNER_A]);
    world.configs.set(OWNER_A, { source: "google-meet" });
    seedRequest(world, OWNER_A, "sync-google", R1);
    const stack = await buildStack(world);
    await withServer(stack, async (base) => {
      const found = await post(base, OWNER_A, R1);
      const missing = await post(base, OWNER_A, R2);
      const unknownOwner = await post(base, OWNER_NO_GRANT, R1);
      await settle(stack);
      expect(found.status).toBe(202);
      expect(missing).toEqual(found);
      expect(unknownOwner).toEqual(found);
      expect(world.runs.map((run) => run.job.jobId)).toEqual([R1]);
    });
  });

  test("replaying one requestId yields one job record and one start", async () => {
    const world = newWorld([OWNER_A]);
    world.configs.set(OWNER_A, { source: "google-meet" });
    seedRequest(world, OWNER_A, "sync-google", R1);
    const stack = await buildStack(world);
    await withServer(stack, async (base) => {
      await post(base, OWNER_A, R1);
      await settle(stack);
      await post(base, OWNER_A, R1);
      await settle(stack);
      expect(world.runs.length).toBe(1);
      expect(ownerJobKeys(world, OWNER_A)).toEqual([`${EXO_JOBS_PREFIX}${R1}`]);
      expect(ownerJob(world, OWNER_A, R1)?.state).toBe("pending");
    });
  });

  test("a request is never read from another owner's space", async () => {
    const world = newWorld([OWNER_A, OWNER_B]);
    world.configs.set(OWNER_B, { source: "google-meet" });
    seedRequest(world, OWNER_A, "sync-google", R1);
    const stack = await buildStack(world);
    await withServer(stack, async (base) => {
      const spaceA = world.spaces.get(OWNER_A)!;
      spaceA.reads.length = 0;
      const reply = await post(base, OWNER_B, R1);
      await settle(stack);
      expect(reply.status).toBe(202);
      expect(spaceA.reads).toEqual([]);
      expect(world.runs.length).toBe(0);
      expect(ownerJobKeys(world, OWNER_B)).toEqual([]);
    });
  });

  test("the terminal report settles the record and its mirror, and releases the capability", async () => {
    const world = newWorld([OWNER_A]);
    seedRequest(world, OWNER_A, "sync-meetings", R1);
    seedRequest(world, OWNER_A, "sync-meetings", R2);
    const stack = await buildStack(world, { connectorsAllOn: true });
    await withServer(stack, async (base) => {
      await post(base, OWNER_A, R1);
      await settle(stack);
      expect(world.runs.length).toBe(1);
      await world.runs[0]!.report({ state: "done", code: "done" });
      expect(ownerJob(world, OWNER_A, R1)).toMatchObject({ state: "done", code: "done" });
      expect(mirrorJob(world, OWNER_A, R1)).toMatchObject({ state: "done", code: "done" });

      await post(base, OWNER_A, R2);
      await settle(stack);
      expect(world.runs.length).toBe(2);
      expect(world.runs[1]!.job.jobId).toBe(R2);
    });
  });

  test("a second capability on a source held by a live run is refused, not attached", async () => {
    const world = newWorld([OWNER_A]);
    seedRequest(world, OWNER_A, "sync-fireflies", R1);
    seedRequest(world, OWNER_A, "sync-meetings", R2);
    const stack = await buildStack(world, { connectorsAllOn: true });
    await withServer(stack, async (base) => {
      await post(base, OWNER_A, R1);
      await settle(stack);
      expect(world.runs.length).toBe(1);
      await post(base, OWNER_A, R2);
      await settle(stack);
      expect(world.runs.length).toBe(1);
      expect(ownerJob(world, OWNER_A, R2)).toMatchObject({ state: "error", code: "rate_limited" });
      expect(ownerJob(world, OWNER_A, R1)?.state).toBe("pending");
    });
  });

  test("the same capability attaches to the live run and settles with it", async () => {
    const world = newWorld([OWNER_A]);
    seedRequest(world, OWNER_A, "sync-meetings", R1);
    seedRequest(world, OWNER_A, "sync-meetings", R2);
    const stack = await buildStack(world, { connectorsAllOn: true });
    await withServer(stack, async (base) => {
      await post(base, OWNER_A, R1);
      await settle(stack);
      await post(base, OWNER_A, R2);
      await settle(stack);
      expect(world.runs.length).toBe(1);
      expect(ownerJob(world, OWNER_A, R2)?.state).toBe("pending");
      await world.runs[0]!.report({ state: "done", code: "done" });
      expect(ownerJob(world, OWNER_A, R1)?.state).toBe("done");
      expect(ownerJob(world, OWNER_A, R2)?.state).toBe("done");
    });
  });

  test("restart keeps the cooldown and the held terminal state, and a replay does not start again", async () => {
    const world = newWorld([OWNER_A]);
    world.configs.set(OWNER_A, { source: "google-meet" });
    seedRequest(world, OWNER_A, "sync-google", R1);
    seedRequest(world, OWNER_A, "sync-google", R2);
    seedRequest(world, OWNER_A, "sync-google", R3);

    const before = await buildStack(world);
    await withServer(before, async (base) => {
      await post(base, OWNER_A, R1);
      await settle(before);
    });
    expect(world.runs.length).toBe(1);
    await world.runs[0]!.report({ state: "done", code: "done" });

    // Restart: rebuild every in-memory piece over the same durable KV state.
    world.clock.now = NOW + MINUTE;
    const after = await buildStack(world);
    await withServer(after, async (base) => {
      await post(base, OWNER_A, R2);
      await settle(after);
      expect(world.runs.length).toBe(1);
      expect(ownerJob(world, OWNER_A, R2)).toMatchObject({ state: "error", code: "rate_limited" });

      await post(base, OWNER_A, R1);
      await settle(after);
      expect(world.runs.length).toBe(1);
      expect(ownerJob(world, OWNER_A, R1)).toMatchObject({ state: "done", code: "done" });

      world.clock.now = NOW + 31 * MINUTE;
      await post(base, OWNER_A, R3);
      await settle(after);
      expect(world.runs.length).toBe(2);
      expect(world.runs[1]!.job.jobId).toBe(R3);
    });
  });
});
