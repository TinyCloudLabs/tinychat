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
import { createExoWakeLimiters } from "../rate-limits.js";
import { createExoMailboxRouter, drainExoWakes } from "../routes/exo-mailbox.js";

const OWNER = `0x${"b".repeat(40)}`;
const OWNER_DID = `did:pkh:eip155:1:${OWNER}`;
const REQ1 = "6f1c2a4e-8b3d-4c5e-9f70-1a2b3c4d5e6f";
const MISSING = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const UNIFORM = { error: "exo_sync_unavailable" };
const ACCEPTED = { status: "accepted" };
const T0 = Date.UTC(2026, 0, 1, 12);
const MINUTE_MS = 60_000;

type Fixture = {
  ports: ExoMailboxPorts;
  jobs: Map<string, ExoJobRecord>;
  runs: number;
  seed(requestId: string, capability: "sync-google" | "sync-fireflies"): void;
};

/**
 * A verifiable owner with one request record per seeded id. Jobs and runs are recorded so tests can read
 * the outcome the route no longer returns.
 */
function fixture(options: { snapshot?: ExoLedgerSnapshot; storeFails?: boolean } = {}): Fixture {
  const requests = new Map<string, unknown>();
  const jobs = new Map<string, ExoJobRecord>();
  const fixture: Fixture = {
    jobs,
    runs: 0,
    seed(requestId, capability) {
      requests.set(`${OWNER}|${EXO_NAMESPACE}/requests/${capability}/${requestId}`, { v: 1, capability });
    },
    ports: undefined as unknown as ExoMailboxPorts,
  };
  const ledger = createMemoryExoLedger();
  fixture.ports = {
    grants: { isActive: async () => true },
    requests: { get: async (owner, path) => requests.get(`${owner}|${path}`) },
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

async function withWakeServer<T>(
  run: (base: string) => Promise<T>,
  ports: ExoMailboxPorts,
  limiters: Parameters<typeof createExoMailboxRouter>[1] = createExoWakeLimiters(),
): Promise<T> {
  const app = express();
  app.use("/api/exo/v1", createExoMailboxRouter(ports, limiters));
  const listening = Promise.withResolvers<Server>();
  const server = app.listen(0, "127.0.0.1", () => listening.resolve(server));
  const bound = await listening.promise;
  const { port } = bound.address() as AddressInfo;
  try {
    return await run(`http://127.0.0.1:${port}`);
  } finally {
    const closed = Promise.withResolvers<void>();
    bound.closeAllConnections();
    bound.close(() => closed.resolve());
    await closed.promise;
  }
}

async function post(base: string, body: string, contentType = "application/json") {
  const response = await fetch(`${base}/api/exo/v1/requests`, {
    method: "POST",
    headers: { "content-type": contentType },
    body,
  });
  // The reply is sent before the wake is recorded. Wait so callers can read the job record.
  await drainExoWakes();
  return response;
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
      const unknown = await post(base, JSON.stringify({ owner: OWNER_DID, requestId: MISSING }));
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
      const response = await post(base, JSON.stringify({ owner: OWNER_DID, requestId: REQ1 }));
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
      const response = await post(base, JSON.stringify({ owner: OWNER_DID, requestId: REQ1 }));
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
      const response = await post(base, JSON.stringify({ owner: OWNER_DID, requestId: REQ1 }));
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
      const response = await post(base, JSON.stringify({ owner: OWNER_DID, requestId: REQ1 }));
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
      const response = await fetch(`${base}/api/exo/v1/requests`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ owner: OWNER_DID, requestId: REQ1 }),
      });
      expect(response.status).toBe(202);
      expect(f.jobs.size).toBe(0);
      gate.resolve();
      await drainExoWakes();
      expect(f.jobs.size).toBe(1);
    }, f.ports);
  });
});

describe("Exo wake route: rate limits", () => {
  test("the 121st request from one IP in a minute is 429 with Retry-After 60", async () => {
    const f = fixture();
    await withWakeServer(async (base) => {
      const body = JSON.stringify({ owner: OWNER_DID, requestId: MISSING });
      for (let i = 0; i < 120; i += 1) {
        expect((await post(base, body)).status).toBe(202);
      }
      const limited = await post(base, body);
      expect(limited.status).toBe(429);
      expect(limited.headers.get("retry-after")).toBe("60");
      expect(await limited.json()).toEqual({ error: "rate_limited" });
    }, f.ports);
  });

  test("the 31st verified wake for one owner in a minute is recorded rate_limited with retryAfterSec 60 and starts nothing", async () => {
    const f = fixture();
    const ids = Array.from({ length: 31 }, () => crypto.randomUUID());
    for (const id of ids) f.seed(id, "sync-fireflies");
    await withWakeServer(async (base) => {
      for (const id of ids) {
        const response = await post(base, JSON.stringify({ owner: OWNER_DID, requestId: id }));
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
        const id = crypto.randomUUID();
        expect((await post(base, JSON.stringify({ owner: OWNER_DID, requestId: id }))).status).toBe(202);
      }
      expect((await post(base, JSON.stringify({ owner: OWNER_DID, requestId: REQ1 }))).status).toBe(202);
    }, f.ports);
    expect(f.jobs.get(`${OWNER}|${REQ1}`)).toMatchObject({ state: "pending" });
    expect(f.runs).toBe(1);
  });
});

describe("Exo wake route: unwired ports fail closed", () => {
  test("with no executor and no grant store, a verified-shaped wake is accepted and nothing is recorded", async () => {
    await withWakeServer(async (base) => {
      const response = await post(base, JSON.stringify({ owner: OWNER_DID, requestId: REQ1 }));
      expect(response.status).toBe(202);
      expect(await response.json()).toEqual(ACCEPTED);
    }, createUnwiredExoPorts("https://app.example.test"));
  });
});

describe("Exo wake route: every state-dependent outcome is the same response", () => {
  const bodyFor = (requestId: string) => JSON.stringify({ owner: OWNER_DID, requestId });
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

  // Everything a caller can see: status, every header except Date (sorted by name), and the body bytes.
  async function wireOf(response: Response): Promise<string> {
    const headers = [...response.headers.entries()]
      .filter(([name]) => name !== "date")
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const body = Buffer.from(await response.arrayBuffer()).toString("hex");
    return JSON.stringify({ status: response.status, headers, body });
  }

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

  test("every well-formed wake reads the grant and all three request paths, in the same order, whatever the state", async () => {
    const paths = ["grant", "request sync-meetings", "request sync-fireflies", "request sync-google"];
    const states: Array<{ label: string; active: boolean; seeded: boolean }> = [
      { label: "unknown owner", active: false, seeded: false },
      { label: "no grant", active: false, seeded: true },
      { label: "no record", active: true, seeded: false },
      { label: "verified", active: true, seeded: true },
    ];
    for (const state of states) {
      const f = fixture();
      if (state.seeded) f.seed(REQ1, "sync-google");
      const reads: string[] = [];
      const ports: ExoMailboxPorts = {
        ...f.ports,
        grants: {
          isActive: async () => {
            reads.push("grant");
            return state.active;
          },
        },
        requests: {
          get: async (owner, path) => {
            reads.push(`request ${path.split("/").at(-2)}`);
            return f.ports.requests.get(owner, path);
          },
        },
      };
      await withWakeServer(async (base) => {
        expect((await post(base, bodyFor(REQ1))).status).toBe(202);
      }, ports);
      expect([state.label, reads]).toEqual([state.label, paths]);
    }
  });

  test("a limiter error answers the same 202 wire as an unverified request, and starts nothing", async () => {
    const f = fixture();
    f.seed(REQ1, "sync-google");
    const failing = (_req: unknown, _res: unknown, next: (err?: unknown) => void) => next(new Error("limiter failed"));
    const reference = await withWakeServer(async (base) => wireOf(await post(base, bodyFor(MISSING))), fixture().ports);
    const failed = await withWakeServer(
      async (base) => wireOf(await post(base, bodyFor(REQ1))),
      f.ports,
      { ...createExoWakeLimiters(), ip: failing },
    );
    expect(failed).toBe(reference);
    expect(f.jobs.size).toBe(0);
    expect(f.runs).toBe(0);
  });
});
