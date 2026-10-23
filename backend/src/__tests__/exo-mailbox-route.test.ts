import { describe, expect, test } from "bun:test";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createUnwiredExoPorts } from "../exo/default-ports.js";
import {
  createMemoryExoLedger,
  EXO_NAMESPACE,
  type ExoJobRecord,
  type ExoLedgerSnapshot,
  type ExoMailboxPorts,
} from "../exo/mailbox.js";
import { WakeQueue } from "../exo/wake-intake.js";
import { createExoMailboxRouter, type ExoWakeOptions } from "../routes/exo-mailbox.js";
import { EXO_SYNC_GRANT_KIND } from "@tinyboilerplate/server";
import { GRANT_HOLDER_REFRESH_MS, GrantHolderIndex } from "../exo/grant-holders.js";

const OWNER = `0x${"b".repeat(40)}`;
const OWNER_DID = `did:pkh:eip155:1:${OWNER}`;
const OTHER = `0x${"c".repeat(40)}`;
const OTHER_DID = `did:pkh:eip155:1:${OTHER}`;
const REQ1 = "6f1c2a4e-8b3d-4c5e-9f70-1a2b3c4d5e6f";
const REQ2 = "2d9e8f7a-6b5c-4d3e-8f2a-1b0c9d8e7f6a";
const MISSING = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const UNIFORM = { error: "exo_sync_unavailable" };
const ACCEPTED = { status: "accepted" };
const T0 = Date.UTC(2026, 0, 1, 12);
const MINUTE_MS = 60_000;

type Fixture = {
  ports: ExoMailboxPorts;
  jobs: Map<string, ExoJobRecord>;
  runs: number;
  seed(requestId: string, capability: "sync-google" | "sync-fireflies", owner?: string): void;
};

/**
 * Verifiable owners with one request record per seeded id. Jobs and runs are recorded so tests can read the
 * outcome the route no longer returns.
 */
function fixture(options: { snapshot?: ExoLedgerSnapshot; storeFails?: boolean; removeFails?: boolean } = {}): Fixture {
  const requests = new Map<string, unknown>();
  const jobs = new Map<string, ExoJobRecord>();
  const fixture: Fixture = {
    jobs,
    runs: 0,
    seed(requestId, capability, owner = OWNER) {
      requests.set(`${owner}|${EXO_NAMESPACE}/requests/${capability}/${requestId}`, { v: 1, capability });
    },
    ports: undefined as unknown as ExoMailboxPorts,
  };
  const ledger = createMemoryExoLedger();
  fixture.ports = {
    grants: { isActive: async () => true },
    requests: {
      get: async (owner, path) => requests.get(`${owner}|${path}`),
      remove: async (owner, path) => {
        if (options.removeFails) throw new Error("request delete failed");
        requests.delete(`${owner}|${path}`);
      },
    },
    jobs: {
      get: async (owner, jobId) => jobs.get(`${owner}|${jobId}`),
      putIfAbsent: async (owner, jobId, record) => {
        if (options.storeFails) throw new Error("store write failed");
        if (jobs.has(`${owner}|${jobId}`)) return false;
        jobs.set(`${owner}|${jobId}`, record);
        return true;
      },
      put: async (owner, jobId, record) => {
        jobs.set(`${owner}|${jobId}`, record);
      },
      list: async () => [],
      remove: async () => {},
    },
    connectors: { isOn: async () => true, hasFirefliesWebhook: async () => false },
    executor: {
      start: async () => {
        fixture.runs += 1;
      },
    },
    ledger: options.snapshot ? { ...ledger, snapshot: async () => options.snapshot! } : ledger,
    now: () => T0,
    frontendOrigin: "https://app.example.test",
  };
  return fixture;
}

/** Live servers, keyed by base URL, so `post` can wait for that server's wake queue. */
const queues = new Map<string, WakeQueue>();

async function withWakeServer<T>(
  run: (base: string) => Promise<T>,
  ports: ExoMailboxPorts,
  options: ExoWakeOptions = {},
  holders: Pick<GrantHolderIndex, "mayHold" | "refreshIfStale"> = { mayHold: () => true, refreshIfStale: () => {} },
): Promise<T> {
  const queue = options.queue ?? new WakeQueue();
  const app = express();
  app.use("/api/exo/v1", createExoMailboxRouter(ports, holders, { ...options, queue }));
  const listening = Promise.withResolvers<Server>();
  const server = app.listen(0, "127.0.0.1", () => listening.resolve(server));
  const bound = await listening.promise;
  const { port } = bound.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  queues.set(base, queue);
  try {
    return await run(base);
  } finally {
    queues.delete(base);
    const closed = Promise.withResolvers<void>();
    bound.closeAllConnections();
    bound.close(() => closed.resolve());
    await closed.promise;
  }
}

/** One request, no wait for the wake to finish. */
function send(base: string, body: string, contentType = "application/json"): Promise<Response> {
  return fetch(`${base}/api/exo/v1/requests`, {
    method: "POST",
    headers: { "content-type": contentType },
    body,
  });
}

async function idleAt(base: string): Promise<void> {
  await queues.get(base)!.idle();
}

/** One request, then wait until its wake has finished, so callers can read the job record. */
async function post(base: string, body: string, contentType = "application/json"): Promise<Response> {
  const response = await send(base, body, contentType);
  await idleAt(base);
  return response;
}

const bodyFor = (requestId: string, owner = OWNER_DID) => JSON.stringify({ owner, requestId });

// Everything a caller can see: status, every header except Date (sorted by name), and the body bytes.
async function wireOf(response: Response): Promise<string> {
  const headers = [...response.headers.entries()]
    .filter(([name]) => name !== "date")
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const body = Buffer.from(await response.arrayBuffer()).toString("hex");
  return JSON.stringify({ status: response.status, headers, body });
}

function within<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}: no reply within ${ms} ms`)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

describe("Exo wake route: malformed requests are the uniform 409 and touch no store", () => {
  const malformed: Array<[string, string, string]> = [
    ["malformed JSON", "{not json", "application/json"],
    ["an extra key", JSON.stringify({ owner: OWNER_DID, requestId: REQ1, capability: "sync-google" }), "application/json"],
    ["a bare 0x owner", JSON.stringify({ owner: OWNER, requestId: REQ1 }), "application/json"],
    ["a non-UUIDv4 request id", JSON.stringify({ owner: OWNER_DID, requestId: "not-a-uuid" }), "application/json"],
    ["a wrong content type", JSON.stringify({ owner: OWNER_DID, requestId: REQ1 }), "text/plain"],
    ["a body over 1 KB", JSON.stringify({ owner: OWNER_DID, requestId: REQ1, pad: "x".repeat(2000) }), "application/json"],
  ];

  test.each(malformed)("%s returns 409 with exactly the uniform body", async (_label, body, contentType) => {
    const f = fixture();
    f.seed(REQ1, "sync-google");
    await withWakeServer(async (base) => {
      const response = await post(base, body, contentType);
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual(UNIFORM);
    }, f.ports);
    expect(f.jobs.size).toBe(0);
    expect(f.runs).toBe(0);
  });
});

describe("Exo wake route: every answer after the shape check is 202 accepted", () => {
  test("an unverified request (no grant or no record) is accepted with no job", async () => {
    const f = fixture();
    await withWakeServer(async (base) => {
      const unknown = await post(base, bodyFor(MISSING));
      expect(unknown.status).toBe(202);
      expect(await unknown.json()).toEqual(ACCEPTED);
    }, f.ports);
    expect(f.jobs.size).toBe(0);
    expect(f.runs).toBe(0);
  });

  test("a verified wake starts one run and is accepted", async () => {
    const f = fixture();
    f.seed(REQ1, "sync-google");
    await withWakeServer(async (base) => {
      const response = await post(base, bodyFor(REQ1));
      expect(response.status).toBe(202);
      expect(await response.json()).toEqual(ACCEPTED);
    }, f.ports);
    expect(f.jobs.get(`${OWNER}|${REQ1}`)).toMatchObject({ state: "pending", capability: "sync-google" });
    expect(f.runs).toBe(1);
  });
});

describe("Exo wake route: the outcome is in the job record, not the response", () => {
  test("a Google cooldown is recorded rate_limited with the seconds remaining", async () => {
    const f = fixture({ snapshot: { startsToday: 1, lastStartedAt: T0 - MINUTE_MS } });
    f.seed(REQ1, "sync-google");
    await withWakeServer(async (base) => {
      const response = await post(base, bodyFor(REQ1));
      expect(response.status).toBe(202);
    }, f.ports);
    // Google cooldown is 30 min; the last start was 1 min ago, so 29 min (1740 s) remain.
    expect(f.jobs.get(`${OWNER}|${REQ1}`)).toMatchObject({
      state: "error",
      code: "rate_limited",
      retryAfterSec: 1740,
    });
    expect(f.runs).toBe(0);
  });

  test("the Google daily cap is recorded budget_exhausted with seconds to UTC midnight", async () => {
    const f = fixture({ snapshot: { startsToday: 300 } });
    f.seed(REQ1, "sync-google");
    await withWakeServer(async (base) => {
      const response = await post(base, bodyFor(REQ1));
      expect(response.status).toBe(202);
    }, f.ports);
    // T0 is 12:00 UTC, so 12 h (43200 s) remain until the next UTC day.
    expect(f.jobs.get(`${OWNER}|${REQ1}`)).toMatchObject({
      state: "error",
      code: "budget_exhausted",
      retryAfterSec: 43200,
    });
    expect(f.runs).toBe(0);
  });

  test("a store failure while the job is written is still accepted, with the uniform body and no detail", async () => {
    const f = fixture({ storeFails: true });
    f.seed(REQ1, "sync-google");
    await withWakeServer(async (base) => {
      const response = await post(base, bodyFor(REQ1));
      const text = await response.text();
      expect(response.status).toBe(202);
      expect(JSON.parse(text)).toEqual(ACCEPTED);
      expect(text).not.toContain("store");
      expect(text).not.toContain("at ");
    }, f.ports);
    expect(f.runs).toBe(0);
  });

  test("the reply is sent before the job record is written", async () => {
    const f = fixture();
    f.seed(REQ1, "sync-google");
    const writeJob = f.ports.jobs.putIfAbsent;
    const gate = Promise.withResolvers<void>();
    f.ports.jobs.putIfAbsent = async (owner, jobId, record) => {
      await gate.promise;
      return writeJob(owner, jobId, record);
    };
    await withWakeServer(async (base) => {
      const response = await send(base, bodyFor(REQ1));
      expect(response.status).toBe(202);
      expect(f.jobs.size).toBe(0);
      gate.resolve();
      await idleAt(base);
      expect(f.jobs.size).toBe(1);
    }, f.ports);
  });
});

describe("Exo wake route: owner budget and no-429 contract", () => {
  test("the 31st verified wake for one owner in a minute is recorded rate_limited with retryAfterSec 60 and starts nothing", async () => {
    const f = fixture();
    const ids = Array.from({ length: 31 }, () => crypto.randomUUID());
    for (const id of ids) f.seed(id, "sync-fireflies");
    await withWakeServer(async (base) => {
      for (const id of ids) {
        const response = await post(base, bodyFor(id));
        expect(response.status).toBe(202);
      }
    }, f.ports);
    expect(f.jobs.get(`${OWNER}|${ids[30]}`)).toMatchObject({
      state: "error",
      code: "rate_limited",
      retryAfterSec: 60,
    });
  });

  test("refused unverified wakes naming an owner do not spend that owner's budget", async () => {
    const f = fixture();
    f.seed(REQ1, "sync-google");
    await withWakeServer(async (base) => {
      for (let i = 0; i < 40; i += 1) {
        expect((await post(base, bodyFor(crypto.randomUUID()))).status).toBe(202);
      }
      expect((await post(base, bodyFor(REQ1))).status).toBe(202);
    }, f.ports);
    expect(f.jobs.get(`${OWNER}|${REQ1}`)).toMatchObject({ state: "pending" });
    expect(f.runs).toBe(1);
  });

  test("(e) N replays of one id, then the owner's own new wake, is still accepted", async () => {
    // With a failed consume the request record survives, so each replay reaches the replay branch.
    // With a working consume, replays fail verification and never reach it.
    const f = fixture({ removeFails: true });
    f.seed(REQ1, "sync-fireflies");
    f.seed(REQ2, "sync-fireflies");
    const ports = { ...f.ports, connectors: { isOn: async () => true, hasFirefliesWebhook: async () => true } };
    await withWakeServer(async (base) => {
      for (let i = 0; i < 40; i += 1) expect((await post(base, bodyFor(REQ1))).status).toBe(202);
      expect((await post(base, bodyFor(REQ2))).status).toBe(202);
    }, ports);
    expect(f.jobs.get(`${OWNER}|${REQ2}`)).toMatchObject({ state: "pending" });
    // REQ1's fireflies run stays active (the fake executor never finishes), so REQ2 attaches to it: one run.
    expect(f.runs).toBe(1);
  });

  test("a failed request consume still answers 202 and leaves the started job pending", async () => {
    const f = fixture({ removeFails: true });
    f.seed(REQ1, "sync-google");
    await withWakeServer(async (base) => {
      expect((await post(base, bodyFor(REQ1))).status).toBe(202);
    }, f.ports);
    expect(f.jobs.get(`${OWNER}|${REQ1}`)).toMatchObject({ state: "pending" });
    expect(f.runs).toBe(1);
  });

  test("(f) the wake route never answers 429, even under a flood from one client", async () => {
    const f = fixture();
    const statuses = await withWakeServer(async (base) => {
      const responses = await Promise.all(
        Array.from({ length: 300 }, () => send(base, bodyFor(crypto.randomUUID()))),
      );
      await idleAt(base);
      return responses.map((response) => response.status);
    }, f.ports);
    expect([...new Set(statuses)]).toEqual([202]);
  });
});

describe("Exo wake route: flood isolation and bounded intake", () => {
  test("(a) one owner's flood does not delay another owner's genuine wake", async () => {
    const f = fixture();
    f.seed(REQ1, "sync-google", OTHER);
    const gate = Promise.withResolvers<void>();
    const reads: string[] = [];
    const ports: ExoMailboxPorts = {
      ...f.ports,
      grants: {
        isActive: async (owner) => {
          reads.push(owner);
          await gate.promise;
          return true;
        },
      },
    };
    await withWakeServer(async (base) => {
      for (let i = 0; i < 100; i += 1) {
        expect((await send(base, bodyFor(crypto.randomUUID()))).status).toBe(202);
      }
      expect((await send(base, bodyFor(REQ1, OTHER_DID))).status).toBe(202);
      gate.resolve();
      await idleAt(base);
    }, ports, { queue: new WakeQueue({ concurrency: 1 }) });
    // The first flood wake holds the single slot. Round-robin serves the other owner next.
    expect(reads.indexOf(OTHER)).toBeGreaterThanOrEqual(0);
    expect(reads.indexOf(OTHER)).toBeLessThanOrEqual(1);
    expect(f.jobs.get(`${OTHER}|${REQ1}`)).toMatchObject({ state: "pending" });
  });

  test("(b) pending never exceeds the cap under a 10x flood", async () => {
    const f = fixture();
    const gate = Promise.withResolvers<void>();
    const ports: ExoMailboxPorts = {
      ...f.ports,
      grants: {
        isActive: async () => {
          await gate.promise;
          return true;
        },
      },
    };
    const queue = new WakeQueue({ globalCap: 16, ownerCap: 4, concurrency: 1 });
    const owners = Array.from({ length: 40 }, (_, i) => `did:pkh:eip155:1:0x${i.toString(16).padStart(40, "0")}`);
    await withWakeServer(async (base) => {
      const flood = owners.flatMap((owner) => [0, 1, 2, 3].map(() => send(base, bodyFor(crypto.randomUUID(), owner))));
      const responses = await Promise.all(flood);
      expect(responses.every((response) => response.status === 202)).toBe(true);
      expect(queue.stats().pending).toBeLessThanOrEqual(16);
      expect(queue.stats().pending).toBeGreaterThan(0);
      gate.resolve();
      await idleAt(base);
    }, ports, { queue });
    expect(queue.stats()).toEqual({ pending: 0, running: 0 });
  });

  test("(c) the same (owner, id) 100 times leaves one pending entry", async () => {
    const f = fixture();
    const gate = Promise.withResolvers<void>();
    const ports: ExoMailboxPorts = {
      ...f.ports,
      grants: {
        isActive: async (owner) => {
          if (owner === OTHER) await gate.promise;
          return true;
        },
      },
    };
    const queue = new WakeQueue({ concurrency: 1 });
    await withWakeServer(async (base) => {
      // The other owner holds the single slot until the gate opens.
      expect((await send(base, bodyFor(REQ2, OTHER_DID))).status).toBe(202);
      for (let i = 0; i < 100; i += 1) expect((await send(base, bodyFor(REQ1))).status).toBe(202);
      expect(queue.stats()).toEqual({ pending: 1, running: 1 });
      gate.resolve();
      await idleAt(base);
    }, ports, { queue });
  });

  test("(d) the reply does not wait on the store: a known owner gets the same reply while its grant read is still open", async () => {
    const f = fixture();
    f.seed(REQ1, "sync-google");
    const gate = Promise.withResolvers<void>();
    const ports: ExoMailboxPorts = {
      ...f.ports,
      grants: {
        isActive: async (owner) => {
          if (owner === OWNER) await gate.promise;
          return owner === OWNER;
        },
      },
    };
    await withWakeServer(async (base) => {
      const known = await within(send(base, bodyFor(REQ1)), 2000, "known owner");
      expect(f.jobs.size).toBe(0);
      const unknown = await within(send(base, bodyFor(MISSING, OTHER_DID)), 2000, "unknown owner");
      expect(await wireOf(known)).toBe(await wireOf(unknown));
      gate.resolve();
      await idleAt(base);
    }, ports);
    expect(f.jobs.get(`${OWNER}|${REQ1}`)).toMatchObject({ state: "pending" });
  });
});

describe("Exo wake route: unwired ports fail closed", () => {
  test("with no executor and no grant store, a verified-shaped wake is accepted and nothing is recorded", async () => {
    await withWakeServer(async (base) => {
      const response = await post(base, bodyFor(REQ1));
      expect(response.status).toBe(202);
      expect(await response.json()).toEqual(ACCEPTED);
    }, createUnwiredExoPorts("https://app.example.test"));
  });
});

describe("Exo wake route: every state-dependent outcome is the same response", () => {
  const throwing = async (): Promise<never> => {
    throw new Error("port failed");
  };

  type Built = { f: Fixture; ids: string[] };
  type Case = {
    label: string;
    build: () => Built;
    // Job codes the last request may be recorded with. undefined means no job record is written.
    records: Array<string | undefined>;
  };

  function seeded(f: Fixture, ids: string[], capability: "sync-google" | "sync-fireflies"): Built {
    for (const id of ids) f.seed(id, capability);
    return { f, ids };
  }
  const newIds = (count: number) => Array.from({ length: count }, () => crypto.randomUUID());

  const cases: Case[] = [
    { label: "unverified", build: () => ({ f: fixture(), ids: [MISSING] }), records: [undefined] },
    { label: "verified start", build: () => seeded(fixture(), [REQ1], "sync-google"), records: ["accepted"] },
    { label: "replay", build: () => seeded(fixture(), [REQ1, REQ1], "sync-google"), records: ["accepted"] },
    { label: "owner limited", build: () => seeded(fixture(), newIds(31), "sync-fireflies"), records: ["rate_limited"] },
    { label: "attach limited", build: () => seeded(fixture(), newIds(22), "sync-fireflies"), records: ["rate_limited"] },
    {
      label: "cooldown",
      build: () => seeded(fixture({ snapshot: { startsToday: 1, lastStartedAt: T0 - MINUTE_MS } }), [REQ1], "sync-google"),
      records: ["rate_limited"],
    },
    {
      label: "daily budget",
      build: () => seeded(fixture({ snapshot: { startsToday: 300 } }), [REQ1], "sync-google"),
      records: ["budget_exhausted"],
    },
    {
      label: "connector off",
      build: () => {
        const built = seeded(fixture(), [REQ1], "sync-google");
        built.f.ports.connectors = { isOn: async () => false, hasFirefliesWebhook: async () => false };
        return built;
      },
      records: ["connector_off"],
    },
    {
      label: "no executor",
      build: () => {
        const built = seeded(fixture(), [REQ1], "sync-google");
        built.f.ports.executor = undefined;
        return built;
      },
      records: ["unavailable"],
    },
    { label: "job store write fails", build: () => seeded(fixture({ storeFails: true }), [REQ1], "sync-google"), records: [undefined] },
    {
      label: "grant check throws",
      build: () => {
        const built = seeded(fixture(), [REQ1], "sync-google");
        built.f.ports.grants = { isActive: throwing };
        return built;
      },
      records: [undefined],
    },
    {
      label: "request read throws",
      build: () => {
        const built = seeded(fixture(), [REQ1], "sync-google");
        built.f.ports.requests = { get: throwing };
        return built;
      },
      records: [undefined],
    },
    {
      label: "connector check throws",
      build: () => {
        const built = seeded(fixture(), [REQ1], "sync-google");
        built.f.ports.connectors = { isOn: throwing, hasFirefliesWebhook: async () => false };
        return built;
      },
      records: ["unavailable"],
    },
    {
      label: "ledger snapshot throws",
      build: () => {
        const built = seeded(fixture(), [REQ1], "sync-google");
        built.f.ports.ledger = { ...createMemoryExoLedger(), snapshot: throwing };
        return built;
      },
      records: ["unavailable"],
    },
    {
      label: "ledger start write throws",
      build: () => {
        const built = seeded(fixture(), [REQ1], "sync-google");
        built.f.ports.ledger = { ...createMemoryExoLedger(), recordStart: throwing };
        return built;
      },
      records: ["unavailable"],
    },
    {
      label: "executor start throws",
      build: () => {
        const built = seeded(fixture(), [REQ1], "sync-google");
        built.f.ports.executor = { start: throwing };
        return built;
      },
      // The pending record is written before the executor runs, and the failure settles it asynchronously.
      records: ["accepted", "unavailable"],
    },
  ];

  async function answerTo(f: Fixture, ids: string[]) {
    const wire = await withWakeServer(async (base) => {
      let last = "";
      for (const id of ids) last = await wireOf(await post(base, bodyFor(id)));
      return last;
    }, f.ports);
    return { wire, record: f.jobs.get(`${OWNER}|${ids[ids.length - 1]}`)?.code };
  }

  test("every state-dependent outcome returns the same status, headers, and body", async () => {
    const results: Array<{ label: string; wire: string; record: string | undefined; records: Array<string | undefined> }> = [];
    for (const c of cases) {
      const { f, ids } = c.build();
      const { wire, record } = await answerTo(f, ids);
      results.push({ label: c.label, wire, record, records: c.records });
    }
    const reference = results[0].wire;
    const pinned = JSON.parse(reference);
    expect(pinned.status).toBe(202);
    expect(Buffer.from(pinned.body, "hex").toString()).toBe(JSON.stringify(ACCEPTED));
    for (const r of results) {
      // Whole wire form, so a header added in one branch fails that case by label.
      expect([r.label, r.wire]).toEqual([r.label, reference]);
      // Each case must reach the branch it names, so an identical answer is not a coincidence.
      expect([r.label, r.records.includes(r.record)]).toEqual([r.label, true]);
    }
  });

  test("a verify throw answers the same 202 wire as an unverified request, and records nothing", async () => {
    const f = fixture();
    f.seed(REQ1, "sync-google");
    f.ports.grants = { isActive: throwing };
    const reference = await withWakeServer(async (base) => wireOf(await post(base, bodyFor(MISSING))), fixture().ports);
    const failed = await withWakeServer(async (base) => wireOf(await post(base, bodyFor(REQ1))), f.ports);
    expect(failed).toBe(reference);
    expect(f.jobs.size).toBe(0);
    expect(f.runs).toBe(0);
  });
});

describe("Exo wake route: many unknown owners do not displace a held owner's wake", () => {
  // Unknown owners are answered 202 and never queued, so a held owner's wake is queued and runs.
  // The executor is gated so the queue would saturate if unknown owners were offered to it.
  for (const flood of [1024, 4096]) {
    test(`${flood} unknown owners leave a held owner's wake running`, async () => {
      let t = 0;
      const keys = [`${EXO_SYNC_GRANT_KIND.keyPrefix}${OWNER}`];
      const index = new GrantHolderIndex({ async list() { return { ok: true, data: { keys } }; } }, () => t);
      await index.refresh();
      t = GRANT_HOLDER_REFRESH_MS;

      const f = fixture();
      f.seed(REQ1, "sync-google");
      // Every request-store read takes 20 ms and records its owner. Unknown owners must never reach the store.
      const readOwners: string[] = [];
      const readRequest = f.ports.requests.get;
      f.ports.requests.get = async (owner, path) => {
        readOwners.push(owner);
        await new Promise((resolve) => setTimeout(resolve, 20));
        return readRequest(owner, path);
      };
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      f.ports.executor = {
        start: async () => {
          await gate;
          f.runs += 1;
        },
      };
      const unknownAddress = (i: number) => `0x${i.toString(16).padStart(40, "0")}`;
      const unknownDid = (i: number) => `did:pkh:eip155:1:${unknownAddress(i)}`;
      // Each unknown owner has a verifiable request, so an offered wake would hold a queue slot.
      for (let i = 1; i <= flood; i++) f.seed(REQ1, "sync-google", unknownAddress(i));
      const statusOf = async (base: string, body: string): Promise<number> => {
        const response = await send(base, body);
        await response.arrayBuffer();
        return response.status;
      };

      await withWakeServer(
        async (base) => {
          for (let start = 1; start <= flood; start += 256) {
            const batch: Promise<number>[] = [];
            for (let i = start; i < Math.min(start + 256, flood + 1); i++) batch.push(statusOf(base, bodyFor(REQ1, unknownDid(i))));
            for (const status of await Promise.all(batch)) expect(status).toBe(202);
          }
          expect(await statusOf(base, bodyFor(REQ1, OWNER_DID))).toBe(202);
          release();
          await idleAt(base);
          expect(f.runs).toBe(1);
          expect(readOwners.length).toBeGreaterThan(0);
          expect(readOwners.every((owner) => owner === OWNER)).toBe(true);
        },
        f.ports,
        {},
        index,
      );
    });
  }
});
