import { describe, expect, test } from "bun:test";
import {
  createMemoryExoLedger,
  EXO_JOB_RETENTION_MS,
  EXO_NAMESPACE,
  exoCapabilitiesEnabled,
  parseWakeBody,
  startWake,
  sweepExpiredJobs,
  verifyWake,
  type ExecutorUpdate,
  type ExoCapability,
  type ExoJobRecord,
  type ExoMailboxPorts,
} from "../exo/mailbox.js";
import { FixedWindowBudget } from "../exo/wake-intake.js";

const OWNER = `0x${"a".repeat(40)}`;
const OWNER_DID = `did:pkh:eip155:1:${OWNER}`;
const OTHER_DID = `did:pkh:eip155:1:0x${"c".repeat(40)}`;
const REQ1 = "6f1c2a4e-8b3d-4c5e-9f70-1a2b3c4d5e6f";
const REQ2 = "7a2d3b5f-9c4e-4d6f-8a81-2b3c4d5e6f70";
const REQ3 = "8d3e4f6a-0b1c-4d2e-9f3a-5b6c7d8e9f01";
const REQ_MISSING = "9c4f5d7b-1e6a-4f8b-8ca3-4d5e6f708192";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 0, 1, 12);
const ORIGIN = "https://app.example.test";

type Run = { job: ExoJobRecord; report: (update: ExecutorUpdate) => Promise<void> };

/**
 * The wake as the route runs it: parse, verify, then start. Undefined when the wake is refused before any
 * job exists. Every other outcome is a job record in the store, which is what the tests read.
 */
function harness(options: { grant?: boolean; connectorOn?: boolean; webhook?: boolean; executor?: "ok" | "absent" | "fails"; removeFails?: boolean } = {}) {
  const state = {
    now: T0,
    grant: options.grant ?? true,
    connectorOn: options.connectorOn ?? true,
    webhook: options.webhook ?? false,
    putFailures: 0,
    removeFails: options.removeFails ?? false,
  };
  const requests = new Map<string, unknown>();
  const jobs = new Map<string, unknown>();
  const runs: Run[] = [];
  const errorWritten = Promise.withResolvers<void>();
  const executorMode = options.executor ?? "ok";

  const ports: ExoMailboxPorts = {
    grants: { isActive: async () => state.grant },
    requests: {
      get: async (owner, path) => requests.get(`${owner}|${path}`),
      remove: async (owner, path) => {
        if (state.removeFails) throw new Error("request delete failed");
        requests.delete(`${owner}|${path}`);
      },
    },
    jobs: {
      get: async (owner, jobId) => jobs.get(`${owner}|${jobId}`),
      putIfAbsent: async (owner, jobId, record) => {
        const key = `${owner}|${jobId}`;
        if (jobs.has(key)) return false;
        jobs.set(key, record);
        return true;
      },
      put: async (owner, jobId, record) => {
        if (state.putFailures > 0) {
          state.putFailures -= 1;
          throw new Error("store write failed");
        }
        jobs.set(`${owner}|${jobId}`, record);
        if (record.state === "error") errorWritten.resolve();
      },
      list: async (owner) =>
        [...jobs.entries()]
          .filter(([key]) => key.startsWith(`${owner}|`))
          .map(([key, value]) => ({ jobId: key.slice(owner.length + 1), value })),
      remove: async (owner, jobId) => {
        jobs.delete(`${owner}|${jobId}`);
      },
    },
    connectors: {
      isOn: async () => state.connectorOn,
      hasFirefliesWebhook: async () => state.webhook,
    },
    executor:
      executorMode === "absent"
        ? undefined
        : {
            start: async (job, report) => {
              runs.push({ job, report });
              if (executorMode === "fails") throw new Error("boom");
            },
          },
    ledger: createMemoryExoLedger(),
    now: () => state.now,
    frontendOrigin: ORIGIN,
  };

  const job = (requestId: string) => jobs.get(`${OWNER}|${requestId}`) as ExoJobRecord | undefined;

  const wake = async (requestId: string, did = OWNER_DID): Promise<ExoJobRecord | undefined> => {
    const parsed = parseWakeBody({ owner: did, requestId });
    if (!parsed) return undefined;
    const verified = await verifyWake(ports, parsed);
    if (!verified) return undefined;
    await startWake(ports, verified, new FixedWindowBudget(1000, MINUTE));
    return job(requestId);
  };

  return {
    requests,
    state,
    errorWritten,
    jobs,
    runs,
    ports,
    job,
    wake,
    seed(requestId: string, capability: ExoCapability, value?: unknown) {
      requests.set(`${OWNER}|${EXO_NAMESPACE}/requests/${capability}/${requestId}`, value ?? { v: 1, capability });
    },
  };
}

describe("Exo wake body is strict: exactly {owner, requestId} with a did:pkh owner and a lowercase UUIDv4", () => {
  test("the did:pkh form is accepted and its address is lowercased", () => {
    expect(parseWakeBody({ owner: `did:pkh:eip155:1:0x${"A".repeat(40)}`, requestId: REQ1 })).toEqual({
      owner: OWNER,
      requestId: REQ1,
    });
  });

  test.each([
    ["an extra key", { owner: OWNER_DID, requestId: REQ1, capability: "sync-google" }],
    ["a bare 0x address as owner", { owner: OWNER, requestId: REQ1 }],
    ["a missing requestId", { owner: OWNER_DID }],
    ["a title-like request id", { owner: OWNER_DID, requestId: "Some_Title-Meeting_Q3_Budget" }],
    ["a UUIDv1 request id", { owner: OWNER_DID, requestId: "6ba7b810-9dad-11d1-80b4-00c04fd430c8" }],
    ["a UUIDv3 request id", { owner: OWNER_DID, requestId: "3d6e0b2a-1f4c-3a7b-8e5d-9c0b1a2f3e4d" }],
    ["an uppercase UUIDv4 request id", { owner: OWNER_DID, requestId: "6F1C2A4E-8B3D-4C5E-9F70-1A2B3C4D5E6F" }],
    ["an array", [OWNER_DID, REQ1]],
    ["null", null],
  ])("%s is refused", (_label, body) => {
    expect(parseWakeBody(body)).toBeUndefined();
  });
});

describe("Exo wake verification refuses before any job exists", () => {
  test("an owner without an active grant", async () => {
    const h = harness({ grant: false });
    h.seed(REQ1, "sync-google");
    expect(await h.wake(REQ1)).toBeUndefined();
    expect(h.jobs.size).toBe(0);
  });

  test("a request id with no request record", async () => {
    const h = harness();
    expect(await h.wake(REQ_MISSING)).toBeUndefined();
    expect(h.jobs.size).toBe(0);
  });

  test("a request record with an extra key", async () => {
    const h = harness();
    h.seed(REQ1, "sync-google", { v: 1, capability: "sync-google", note: "x" });
    expect(await h.wake(REQ1)).toBeUndefined();
    expect(h.jobs.size).toBe(0);
  });

  test("a request record naming a different capability than its path", async () => {
    const h = harness();
    h.seed(REQ1, "sync-fireflies", { v: 1, capability: "sync-google" });
    expect(await h.wake(REQ1)).toBeUndefined();
    expect(h.jobs.size).toBe(0);
  });

  test("a request id present under two capability paths", async () => {
    const h = harness();
    h.seed(REQ1, "sync-google");
    h.seed(REQ1, "sync-fireflies");
    expect(await h.wake(REQ1)).toBeUndefined();
    expect(h.jobs.size).toBe(0);
  });

  test("a request record stored under another owner is not visible", async () => {
    const h = harness();
    h.seed(REQ1, "sync-google");
    expect(await h.wake(REQ1, OTHER_DID)).toBeUndefined();
    expect(h.jobs.size).toBe(0);
  });

  test("a store read that throws refuses rather than rejecting", async () => {
    const h = harness();
    h.seed(REQ1, "sync-google");
    h.ports.requests.get = async () => {
      throw new Error("kv down");
    };
    expect(await h.wake(REQ1)).toBeUndefined();
    expect(h.jobs.size).toBe(0);
  });

  test("a valid request verifies to its capability", async () => {
    const h = harness();
    h.seed(REQ1, "sync-fireflies");
    expect(await verifyWake(h.ports, { owner: OWNER, requestId: REQ1 })).toEqual({
      owner: OWNER,
      requestId: REQ1,
      capability: "sync-fireflies",
    });
  });
});

describe("Exo wake creates one job and one run", () => {
  test("a valid wake creates one pending job and starts it once", async () => {
    const h = harness();
    h.seed(REQ1, "sync-google");
    expect(await h.wake(REQ1)).toEqual({
      v: 1,
      jobId: REQ1,
      capability: "sync-google",
      state: "pending",
      code: "accepted",
      message: expect.any(String),
      createdAt: new Date(T0).toISOString(),
      updatedAt: new Date(T0).toISOString(),
    });
    expect(h.runs).toHaveLength(1);
  });

  test("replaying a consumed request id starts nothing and leaves the job as it was", async () => {
    const h = harness();
    h.seed(REQ1, "sync-google");
    await h.wake(REQ1);
    h.state.now = T0 + 10 * MINUTE;
    expect(await h.wake(REQ1)).toBeUndefined();
    expect(h.job(REQ1)).toMatchObject({ jobId: REQ1, state: "pending" });
    expect(h.runs).toHaveLength(1);
  });

  test("a second request while one job is active attaches to it with its own job record", async () => {
    const h = harness();
    h.seed(REQ1, "sync-google");
    h.seed(REQ2, "sync-google");
    await h.wake(REQ1);
    h.state.now = T0 + 10 * MINUTE;
    expect(await h.wake(REQ2)).toMatchObject({ jobId: REQ2, capability: "sync-google", state: "pending" });
    expect(h.runs).toHaveLength(1);
  });
});

describe("Exo coalesced wakes share one run", () => {
  test("two wakes that race for the same owner and capability start one run", async () => {
    const h = harness();
    h.seed(REQ1, "sync-google");
    h.seed(REQ2, "sync-google");
    const [first, second] = await Promise.all([h.wake(REQ1), h.wake(REQ2)]);
    expect(first).toMatchObject({ jobId: REQ1, state: "pending" });
    expect(second).toMatchObject({ jobId: REQ2, capability: "sync-google" });
    expect(h.runs).toHaveLength(1);
  });

  test("a coalesced wake's record follows the run and settles with it", async () => {
    const h = harness();
    h.seed(REQ1, "sync-google");
    h.seed(REQ2, "sync-google");
    await h.wake(REQ1);
    await h.wake(REQ2);
    await h.runs[0].report({ state: "running", code: "running" });
    expect(h.job(REQ2)).toMatchObject({ state: "running", code: "running" });
    await h.runs[0].report({ state: "done", code: "done" });
    expect(h.job(REQ1)).toMatchObject({ state: "done", code: "done" });
    expect(h.job(REQ2)).toMatchObject({ state: "done", code: "done" });
  });

  test("a run takes at most twenty attached wakes; the next is recorded rate_limited and attaches to nothing", async () => {
    const h = harness();
    const ids = Array.from({ length: 22 }, () => crypto.randomUUID());
    for (const id of ids) h.seed(id, "sync-google");
    await h.wake(ids[0]);
    for (const id of ids.slice(1, 21)) {
      expect(await h.wake(id)).toMatchObject({ jobId: id, state: "pending", code: "accepted" });
    }
    expect(await h.wake(ids[21])).toMatchObject({ state: "error", code: "rate_limited", retryAfterSec: 60 });
    expect(h.runs).toHaveLength(1);
  });
});

describe("Exo connector gate", () => {
  test("a fireflies request with the connector off is recorded connector_off with the source and link", async () => {
    const h = harness({ connectorOn: false });
    h.seed(REQ1, "sync-fireflies");
    expect(await h.wake(REQ1)).toMatchObject({
      state: "error",
      code: "connector_off",
      source: "fireflies",
      link: ORIGIN,
    });
    expect(h.runs).toHaveLength(0);
  });

  test("sync-meetings with no source on is recorded connector_off with the link and no source", async () => {
    const h = harness({ connectorOn: false });
    h.seed(REQ1, "sync-meetings");
    const job = await h.wake(REQ1);
    expect(job).toMatchObject({ state: "error", code: "connector_off", link: ORIGIN });
    expect(job).not.toHaveProperty("source");
    expect(h.runs).toHaveLength(0);
  });

  test("sync-meetings starts one run when a source is on", async () => {
    const h = harness({ connectorOn: true });
    h.seed(REQ1, "sync-meetings");
    expect(await h.wake(REQ1)).toMatchObject({ state: "pending" });
    expect(h.runs).toHaveLength(1);
  });
});

describe("Exo per-source cooldowns (TC-1013 D9)", () => {
  test("fireflies without a webhook waits one hour between starts", async () => {
    const h = harness();
    h.seed(REQ1, "sync-fireflies");
    h.seed(REQ2, "sync-fireflies");
    h.seed(REQ3, "sync-fireflies");
    await h.wake(REQ1);
    await h.runs[0].report({ state: "done", code: "done" });
    h.state.now = T0 + 30 * MINUTE;
    expect(await h.wake(REQ2)).toMatchObject({ state: "error", code: "rate_limited", retryAfterSec: 1800 });
    h.state.now = T0 + HOUR;
    expect(await h.wake(REQ3)).toMatchObject({ state: "pending" });
    expect(h.runs).toHaveLength(2);
  });

  test("fireflies with a webhook waits six hours between starts", async () => {
    const h = harness({ webhook: true });
    h.seed(REQ1, "sync-fireflies");
    h.seed(REQ2, "sync-fireflies");
    h.seed(REQ3, "sync-fireflies");
    await h.wake(REQ1);
    await h.runs[0].report({ state: "done", code: "done" });
    h.state.now = T0 + HOUR;
    expect(await h.wake(REQ2)).toMatchObject({ code: "rate_limited", retryAfterSec: 5 * 3600 });
    h.state.now = T0 + 6 * HOUR;
    expect(await h.wake(REQ3)).toMatchObject({ state: "pending" });
    expect(h.runs).toHaveLength(2);
  });

  test("google waits thirty minutes between starts", async () => {
    const h = harness();
    h.seed(REQ1, "sync-google");
    h.seed(REQ2, "sync-google");
    h.seed(REQ3, "sync-google");
    await h.wake(REQ1);
    await h.runs[0].report({ state: "done", code: "done" });
    h.state.now = T0 + 29 * MINUTE;
    expect(await h.wake(REQ2)).toMatchObject({ code: "rate_limited", retryAfterSec: 60 });
    h.state.now = T0 + 30 * MINUTE;
    expect(await h.wake(REQ3)).toMatchObject({ state: "pending" });
    expect(h.runs).toHaveLength(2);
  });

  test("a finished job no longer coalesces, so the next start still waits out the cooldown", async () => {
    const h = harness();
    h.seed(REQ1, "sync-google");
    h.seed(REQ2, "sync-google");
    await h.wake(REQ1);
    await h.runs[0].report({ state: "done", code: "done" });
    h.state.now = T0 + MINUTE;
    expect(await h.wake(REQ2)).toMatchObject({ code: "rate_limited", retryAfterSec: 29 * 60 });
    expect(h.runs).toHaveLength(1);
  });

  test("a meetings run stamps google, so a google start inside its cooldown is rate_limited", async () => {
    const h = harness();
    h.seed(REQ1, "sync-meetings");
    h.seed(REQ2, "sync-google");
    expect(await h.wake(REQ1)).toMatchObject({ state: "pending" });
    await h.runs[0].report({ state: "done", code: "done" });
    h.state.now = T0 + 10 * MINUTE;
    expect(await h.wake(REQ2)).toMatchObject({ state: "error", code: "rate_limited", retryAfterSec: 20 * 60 });
    expect(h.runs).toHaveLength(1);
  });

  test("a fireflies start stamps fireflies, so a meetings start inside its cooldown is rate_limited", async () => {
    const h = harness();
    h.seed(REQ1, "sync-fireflies");
    h.seed(REQ2, "sync-meetings");
    expect(await h.wake(REQ1)).toMatchObject({ state: "pending" });
    await h.runs[0].report({ state: "done", code: "done" });
    h.state.now = T0 + 10 * MINUTE;
    expect(await h.wake(REQ2)).toMatchObject({ state: "error", code: "rate_limited", retryAfterSec: 50 * 60 });
    expect(h.runs).toHaveLength(1);
  });

  test("the daily cap records budget_exhausted with the seconds to the next UTC day", async () => {
    const h = harness();
    const ledger = createMemoryExoLedger();
    h.ports.ledger = {
      ...ledger,
      snapshot: async () => ({ startsToday: 300, lastStartedAt: undefined }),
    };
    h.seed(REQ1, "sync-google");
    const nextDay = (Math.floor(T0 / DAY) + 1) * DAY;
    expect(await h.wake(REQ1)).toMatchObject({
      state: "error",
      code: "budget_exhausted",
      retryAfterSec: Math.ceil((nextDay - T0) / 1000),
    });
    expect(h.runs).toHaveLength(0);
  });

  test("an owner past the wake budget is recorded rate_limited before the ledger is read", async () => {
    const h = harness();
    const ledger = h.ports.ledger;
    h.ports.ledger = {
      ...ledger,
      snapshot: async () => {
        throw new Error("ledger must not be read for an owner over budget");
      },
    };
    h.seed(REQ1, "sync-google");
    const verified = await verifyWake(h.ports, { owner: OWNER, requestId: REQ1 });
    if (!verified) throw new Error("fixture did not verify");
    await startWake(h.ports, verified, new FixedWindowBudget(0, MINUTE));
    expect(h.job(REQ1)).toMatchObject({ state: "error", code: "rate_limited", retryAfterSec: 60 });
    expect(h.runs).toHaveLength(0);
  });
});

describe("Exo terminal report survives a failed store write", () => {
  test("one failed write on a terminal report still releases the run; a new wake starts and a replay of the old id does not", async () => {
    const h = harness();
    h.seed(REQ1, "sync-google");
    h.seed(REQ2, "sync-google");
    await h.wake(REQ1);
    h.state.putFailures = 1;
    await h.runs[0].report({ state: "done", code: "done" });
    h.state.now = T0 + 31 * MINUTE;
    expect(await h.wake(REQ2)).toMatchObject({ state: "pending" });
    expect(h.runs).toHaveLength(2);
    await h.wake(REQ1);
    expect(h.runs).toHaveLength(2);
  });

  test("every store write failing on a terminal report still releases the run without rejecting", async () => {
    const h = harness();
    h.seed(REQ1, "sync-google");
    h.seed(REQ2, "sync-google");
    await h.wake(REQ1);
    h.state.putFailures = Number.POSITIVE_INFINITY;
    await expect(h.runs[0].report({ state: "done", code: "done" })).resolves.toBeUndefined();
    h.state.now = T0 + 31 * MINUTE;
    expect(await h.wake(REQ2)).toMatchObject({ state: "pending" });
    expect(h.runs).toHaveLength(2);
  });

  test("a store write that fails while a wake settles keeps that request id from starting a run", async () => {
    const h = harness();
    const ledger = createMemoryExoLedger();
    h.ports.ledger = {
      ...ledger,
      recordStart: async () => {
        throw new Error("ledger down");
      },
    };
    h.seed(REQ1, "sync-google");
    h.state.putFailures = Number.POSITIVE_INFINITY;
    await h.wake(REQ1);
    await h.wake(REQ1);
    expect(h.runs).toHaveLength(0);
  });

  test("a ledger that refuses the start settles the request rate_limited and never calls the executor", async () => {
    const h = harness();
    const ledger = createMemoryExoLedger();
    h.ports.ledger = {
      ...ledger,
      recordStart: async () => ({ started: false, reason: "active", retryAfterMs: 0 }),
    };
    h.seed(REQ1, "sync-google");
    expect(await h.wake(REQ1)).toMatchObject({ state: "error", code: "rate_limited" });
    expect(h.runs).toHaveLength(0);
  });

  test("a pending job that no live run accounts for settles unavailable once older than the active-run TTL", async () => {
    const h = harness();
    h.seed(REQ1, "sync-google");
    h.jobs.set(`${OWNER}|${REQ1}`, {
      v: 1,
      jobId: REQ1,
      capability: "sync-google",
      state: "pending",
      code: "accepted",
      message: "Request accepted.",
      createdAt: new Date(T0).toISOString(),
      updatedAt: new Date(T0).toISOString(),
    });
    h.state.now = T0 + 10 * MINUTE;
    expect(await h.wake(REQ1)).toMatchObject({ state: "pending" });
    h.state.now = T0 + 31 * MINUTE;
    expect(await h.wake(REQ1)).toMatchObject({ state: "error", code: "unavailable" });
    expect(await h.wake(REQ1)).toMatchObject({ state: "error", code: "unavailable" });
    expect(h.runs).toHaveLength(0);
  });
});

describe("Exo executor wiring", () => {
  test("no executor wired records unavailable without starting anything", async () => {
    const h = harness({ executor: "absent" });
    h.seed(REQ1, "sync-google");
    expect(await h.wake(REQ1)).toMatchObject({ state: "error", code: "unavailable" });
    expect(h.runs).toHaveLength(0);
  });

  test("an executor that fails to start marks the job error with a code", async () => {
    const h = harness({ executor: "fails" });
    h.seed(REQ1, "sync-google");
    await h.wake(REQ1);
    await h.errorWritten.promise;
    expect(h.job(REQ1)).toMatchObject({ state: "error", code: "unavailable" });
  });

  test("executor progress updates the stored job state and code", async () => {
    const h = harness();
    h.seed(REQ1, "sync-google");
    await h.wake(REQ1);
    await h.runs[0].report({ state: "running", code: "running" });
    expect(h.job(REQ1)).toMatchObject({ state: "running", code: "running" });
    await h.runs[0].report({ state: "error", code: "unavailable" });
    expect(h.job(REQ1)).toMatchObject({ state: "error", code: "unavailable" });
  });

  test("a lost put-if-absent race starts nothing and records nothing", async () => {
    const h = harness();
    h.seed(REQ1, "sync-google");
    h.ports.jobs.putIfAbsent = async () => false;
    expect(await h.wake(REQ1)).toBeUndefined();
    expect(h.runs).toHaveLength(0);
  });

  test("an executor code outside the vocabulary settles the job as unavailable and stays settled", async () => {
    const h = harness();
    h.seed(REQ1, "sync-google");
    await h.wake(REQ1);
    await h.runs[0].report({ state: "running", code: "Some Title" } as unknown as ExecutorUpdate);
    expect(h.job(REQ1)).toMatchObject({ state: "error", code: "unavailable" });
    await h.wake(REQ1);
    expect(h.job(REQ1)).toMatchObject({ state: "error", code: "unavailable" });
  });

  test("a report whose store write fails resolves instead of rejecting into the executor", async () => {
    const h = harness();
    h.seed(REQ1, "sync-google");
    await h.wake(REQ1);
    h.ports.jobs.put = async () => {
      throw new Error("store down");
    };
    await expect(h.runs[0].report({ state: "running", code: "running" })).resolves.toBeUndefined();
  });

  test("a ledger write that fails at start settles the job as unavailable and frees the request id", async () => {
    const h = harness();
    h.seed(REQ1, "sync-google");
    h.seed(REQ2, "sync-google");
    const ledger = h.ports.ledger;
    h.ports.ledger = {
      ...ledger,
      recordStart: async () => {
        throw new Error("store down");
      },
    };
    expect(await h.wake(REQ1)).toMatchObject({ state: "error", code: "unavailable" });
    expect(h.runs).toHaveLength(0);
    expect(await h.wake(REQ1)).toBeUndefined();
    expect(h.job(REQ1)).toMatchObject({ state: "error", code: "unavailable" });

    h.ports.ledger = ledger;
    expect(await h.wake(REQ2)).toMatchObject({ state: "pending" });
    expect(h.runs).toHaveLength(1);
  });
});

describe("Exo active run TTL", () => {
  test("a run that never reports is settled as unavailable after the TTL, and the next wake starts", async () => {
    const h = harness();
    h.seed(REQ1, "sync-google");
    h.seed(REQ2, "sync-google");
    await h.wake(REQ1);
    h.state.now = T0 + 31 * MINUTE;
    expect(await h.wake(REQ2)).toMatchObject({ state: "pending" });
    expect(h.job(REQ1)).toMatchObject({ state: "error", code: "unavailable" });
    expect(h.runs).toHaveLength(2);
  });
});

describe("Exo job retention sweep", () => {
  const record = (jobId: string, updatedAt: number): ExoJobRecord => ({
    v: 1,
    jobId,
    capability: "sync-google",
    state: "done",
    code: "done",
    message: "Sync complete.",
    createdAt: new Date(updatedAt).toISOString(),
    updatedAt: new Date(updatedAt).toISOString(),
  });

  test("removes records last updated more than 30 days ago and keeps newer or unparseable ones", async () => {
    const h = harness();
    const now = T0;
    h.jobs.set(`${OWNER}|old`, record("old", now - EXO_JOB_RETENTION_MS - DAY));
    h.jobs.set(`${OWNER}|fresh`, record("fresh", now - DAY));
    h.jobs.set(`${OWNER}|junk`, { v: 1, jobId: "junk" });
    const removed = await sweepExpiredJobs(h.ports, OWNER, now);
    expect(removed).toBe(1);
    expect([...h.jobs.keys()].sort()).toEqual([`${OWNER}|fresh`, `${OWNER}|junk`]);
  });
});

describe("Exo request consume", () => {
  const key = (requestId: string, capability = "sync-google") => `${OWNER}|${EXO_NAMESPACE}/requests/${capability}/${requestId}`;

  test("a started wake consumes its own request record and no other", async () => {
    const h = harness();
    h.seed(REQ1, "sync-google");
    h.seed(REQ2, "sync-google");
    await h.wake(REQ1);
    expect(h.requests.has(key(REQ1))).toBe(false);
    expect(h.requests.has(key(REQ2))).toBe(true);
  });

  test("a refused wake consumes its request record too, since its job record now exists", async () => {
    const h = harness();
    h.seed(REQ1, "sync-google");
    h.seed(REQ2, "sync-google");
    await h.wake(REQ1);
    await h.runs[0].report({ state: "done", code: "done" });
    h.state.now = T0 + MINUTE;
    expect(await h.wake(REQ2)).toMatchObject({ state: "error", code: "rate_limited" });
    expect(h.requests.has(key(REQ2))).toBe(false);
  });

  test("a failed consume leaves the started job pending and the request record in place", async () => {
    const h = harness({ removeFails: true });
    h.seed(REQ1, "sync-google");
    expect(await h.wake(REQ1)).toMatchObject({ state: "pending" });
    expect(h.runs).toHaveLength(1);
    expect(h.requests.has(key(REQ1))).toBe(true);
  });

  test("after the job is swept, a replay of its request id starts nothing", async () => {
    const h = harness();
    h.seed(REQ1, "sync-google");
    await h.wake(REQ1);
    await h.runs[0].report({ state: "done", code: "done" });
    h.state.now = T0 + EXO_JOB_RETENTION_MS + DAY;
    expect(await sweepExpiredJobs(h.ports, OWNER, h.state.now)).toBe(1);
    expect(await h.wake(REQ1)).toBeUndefined();
    expect(h.jobs.size).toBe(0);
    expect(h.runs).toHaveLength(1);
  });

  test("a sweep whose request removal fails keeps the job, and a replay of the request starts nothing", async () => {
    const h = harness();
    h.seed(REQ1, "sync-google");
    h.state.removeFails = true;
    expect(await h.wake(REQ1)).toMatchObject({ state: "pending" });
    await h.runs[0].report({ state: "done", code: "done" });
    h.state.now = T0 + EXO_JOB_RETENTION_MS + DAY;
    await expect(sweepExpiredJobs(h.ports, OWNER, h.state.now)).rejects.toThrow();
    expect(h.jobs.size).toBe(1);
    expect(h.requests.has(key(REQ1))).toBe(true);
    h.state.removeFails = false;
    await h.wake(REQ1);
    expect(h.runs).toHaveLength(1);
    expect(h.jobs.size).toBe(1);
  });

  test("a sweep whose job removal fails after the request is removed leaves a job that a replay does not start", async () => {
    const h = harness();
    h.seed(REQ1, "sync-google");
    await h.wake(REQ1);
    await h.runs[0].report({ state: "done", code: "done" });
    h.state.now = T0 + EXO_JOB_RETENTION_MS + DAY;
    const realRemove = h.ports.jobs.remove;
    h.ports.jobs.remove = async () => {
      throw new Error("job remove failed");
    };
    await expect(sweepExpiredJobs(h.ports, OWNER, h.state.now)).rejects.toThrow("job remove failed");
    h.ports.jobs.remove = realRemove;
    expect(h.requests.has(key(REQ1))).toBe(false);
    expect(h.jobs.size).toBe(1);
    await h.wake(REQ1);
    expect(h.runs).toHaveLength(1);
  });
});

describe("Exo flag parsing", () => {
  test("enables only for the exact value true", () => {
    const warnings: string[] = [];
    const warn = (message: string) => warnings.push(message);
    expect(exoCapabilitiesEnabled({ EXO_CAPABILITIES_ENABLED: "true" }, warn)).toBe(true);
    expect(exoCapabilitiesEnabled({ EXO_CAPABILITIES_ENABLED: "false" }, warn)).toBe(false);
    expect(exoCapabilitiesEnabled({ EXO_CAPABILITIES_ENABLED: "" }, warn)).toBe(false);
    expect(exoCapabilitiesEnabled({}, warn)).toBe(false);
    expect(warnings).toHaveLength(0);
    expect(exoCapabilitiesEnabled({ EXO_CAPABILITIES_ENABLED: "TRUE" }, warn)).toBe(false);
    expect(exoCapabilitiesEnabled({ EXO_CAPABILITIES_ENABLED: "1" }, warn)).toBe(false);
    expect(exoCapabilitiesEnabled({ EXO_CAPABILITIES_ENABLED: " true " }, warn)).toBe(false);
    expect(warnings).toHaveLength(3);
  });
});

describe("Exo per-source locks (TC-1013 D9)", () => {
  test("a meetings run refuses a fireflies start on the same source until its terminal report", async () => {
    const h = harness();
    h.seed(REQ1, "sync-meetings");
    h.seed(REQ2, "sync-fireflies");
    h.seed(REQ3, "sync-fireflies");
    expect(await h.wake(REQ1)).toMatchObject({ state: "pending" });
    expect(await h.wake(REQ2)).toMatchObject({ state: "error", code: "rate_limited", retryAfterSec: 3600 });
    await h.runs[0].report({ state: "done", code: "done" });
    h.state.now = T0 + HOUR;
    expect(await h.wake(REQ3)).toMatchObject({ state: "pending" });
    expect(h.runs).toHaveLength(2);
  });

  test("a fireflies run refuses a meetings start on the same source", async () => {
    const h = harness();
    h.seed(REQ1, "sync-fireflies");
    h.seed(REQ2, "sync-meetings");
    expect(await h.wake(REQ1)).toMatchObject({ state: "pending" });
    expect(await h.wake(REQ2)).toMatchObject({ state: "error", code: "rate_limited" });
    expect(h.runs).toHaveLength(1);
  });

  test("an error terminal report also releases the meetings run's source locks", async () => {
    const h = harness();
    h.seed(REQ1, "sync-meetings");
    h.seed(REQ2, "sync-google");
    expect(await h.wake(REQ1)).toMatchObject({ state: "pending" });
    await h.runs[0].report({ state: "error", code: "unavailable" });
    h.state.now = T0 + 30 * MINUTE;
    expect(await h.wake(REQ2)).toMatchObject({ state: "pending" });
  });

  test("a meetings run that never reports releases its source locks after the active-run TTL", async () => {
    const h = harness();
    h.seed(REQ1, "sync-meetings");
    h.seed(REQ2, "sync-google");
    h.seed(REQ3, "sync-google");
    expect(await h.wake(REQ1)).toMatchObject({ state: "pending" });
    h.state.now = T0 + 30 * MINUTE - 1;
    expect(await h.wake(REQ2)).toMatchObject({ state: "error", code: "rate_limited" });
    h.state.now = T0 + 30 * MINUTE;
    expect(await h.wake(REQ3)).toMatchObject({ state: "pending" });
    expect(h.runs).toHaveLength(2);
  });
});
