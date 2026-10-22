import { describe, expect, test } from "bun:test";
import {
  createMemoryExoLedger,
  EXO_JOB_RETENTION_MS,
  EXO_NAMESPACE,
  exoCapabilitiesEnabled,
  handleWake,
  sweepExpiredJobs,
  type ExecutorUpdate,
  type ExoCapability,
  type ExoJobRecord,
  type ExoMailboxPorts,
} from "../exo/mailbox.js";

const OWNER = `0x${"a".repeat(40)}`;
const OWNER_DID = `did:pkh:eip155:1:${OWNER}`;
const REQ1 = "6f1c2a4e-8b3d-4c5e-9f70-1a2b3c4d5e6f";
const REQ2 = "7a2d3b5f-9c4e-4d6f-8a81-2b3c4d5e6f70";
const REQ_MISSING = "9c4f5d7b-1e6a-4f8b-8ca3-4d5e6f708192";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 0, 1, 12);
const ORIGIN = "https://app.example.test";

type Run = { job: ExoJobRecord; report: (update: ExecutorUpdate) => Promise<void> };

function harness(options: { grant?: boolean; connectorOn?: boolean; webhook?: boolean; executor?: "ok" | "absent" | "fails" } = {}) {
  const state = {
    now: T0,
    grant: options.grant ?? true,
    connectorOn: options.connectorOn ?? true,
    webhook: options.webhook ?? false,
  };
  const requests = new Map<string, unknown>();
  const jobs = new Map<string, unknown>();
  const runs: Run[] = [];
  const errorWritten = Promise.withResolvers<void>();
  const executorMode = options.executor ?? "ok";

  const ports: ExoMailboxPorts = {
    grants: { isActive: async () => state.grant },
    requests: { get: async (owner, path) => requests.get(`${owner}|${path}`) },
    jobs: {
      get: async (owner, jobId) => jobs.get(`${owner}|${jobId}`),
      putIfAbsent: async (owner, jobId, record) => {
        const key = `${owner}|${jobId}`;
        if (jobs.has(key)) return false;
        jobs.set(key, record);
        return true;
      },
      put: async (owner, jobId, record) => {
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

  return {
    state,
    errorWritten,
    jobs,
    runs,
    ports,
    seed(requestId: string, capability: ExoCapability, value?: unknown) {
      requests.set(`${OWNER}|${EXO_NAMESPACE}/requests/${capability}/${requestId}`, value ?? { v: 1, capability });
    },
    wake(requestId: string, owner = OWNER_DID) {
      return handleWake(ports, { owner, requestId });
    },
    job(requestId: string) {
      return jobs.get(`${OWNER}|${requestId}`) as ExoJobRecord | undefined;
    },
  };
}

const UNIFORM = { status: 409, body: { error: "exo_sync_unavailable" } };

describe("Exo wake refusals are one uniform 409 that creates no job", () => {
  test("a wake body with an extra key is refused", async () => {
    const h = harness();
    h.seed(REQ1, "sync-google");
    const result = await handleWake(h.ports, { owner: OWNER_DID, requestId: REQ1, capability: "sync-google" });
    expect(result).toEqual(UNIFORM);
    expect(h.runs).toHaveLength(0);
  });

  test("an owner without an active grant is refused", async () => {
    const h = harness({ grant: false });
    h.seed(REQ1, "sync-google");
    expect(await h.wake(REQ1)).toEqual(UNIFORM);
    expect(h.jobs.size).toBe(0);
  });

  test("a request id with no request record is refused", async () => {
    const h = harness();
    expect(await h.wake(REQ_MISSING)).toEqual(UNIFORM);
    expect(h.jobs.size).toBe(0);
  });

  test("a request record with an extra key is refused", async () => {
    const h = harness();
    h.seed(REQ1, "sync-google", { v: 1, capability: "sync-google", note: "x" });
    expect(await h.wake(REQ1)).toEqual(UNIFORM);
    expect(h.jobs.size).toBe(0);
  });

  test("a request record naming a different capability than its path is refused", async () => {
    const h = harness();
    h.seed(REQ1, "sync-fireflies", { v: 1, capability: "sync-google" });
    expect(await h.wake(REQ1)).toEqual(UNIFORM);
    expect(h.jobs.size).toBe(0);
  });

  test("a request id present under two capability paths is refused", async () => {
    const h = harness();
    h.seed(REQ1, "sync-google");
    h.seed(REQ1, "sync-fireflies");
    expect(await h.wake(REQ1)).toEqual(UNIFORM);
    expect(h.jobs.size).toBe(0);
  });

  test("a malformed owner is refused before any store is read", async () => {
    const h = harness();
    h.seed(REQ1, "sync-google");
    expect(await h.wake(REQ1, "not-an-address")).toEqual(UNIFORM);
  });
});

describe("Exo wake owner is a did:pkh DID", () => {
  test("a bare 0x address is refused; the did:pkh form with the same address is accepted", async () => {
    const h = harness();
    h.seed(REQ1, "sync-google");
    expect(await h.wake(REQ1, OWNER)).toEqual(UNIFORM);
    expect(h.jobs.size).toBe(0);
    expect(await h.wake(REQ1, OWNER_DID)).toMatchObject({ status: 202 });
    expect(h.job(REQ1)).toMatchObject({ jobId: REQ1 });
  });
});
describe("Exo wake request id is a lowercase UUIDv4", () => {
  test.each([
    ["a title-like id", "Some_Title-Meeting_Q3_Budget"],
    ["a UUIDv1", "6ba7b810-9dad-11d1-80b4-00c04fd430c8"],
    ["a UUIDv3", "3d6e0b2a-1f4c-3a7b-8e5d-9c0b1a2f3e4d"],
    ["an uppercase UUIDv4", "6F1C2A4E-8B3D-4C5E-9F70-1A2B3C4D5E6F"],
  ])("%s is refused even when a request record exists", async (_label, requestId) => {
    const h = harness();
    h.seed(requestId, "sync-google");
    expect(await h.wake(requestId)).toEqual(UNIFORM);
    expect(h.jobs.size).toBe(0);
  });
});

describe("Exo wake accepts an exact grant and request", () => {
  test("a valid wake creates one pending job and starts it once", async () => {
    const h = harness();
    h.seed(REQ1, "sync-google");
    const result = await h.wake(REQ1);
    expect(result).toEqual({
      status: 202,
      body: { jobId: REQ1, state: "pending", code: "accepted", statusKey: `${EXO_NAMESPACE}/jobs/${REQ1}` },
    });
    expect(h.job(REQ1)).toEqual({
      v: 1,
      jobId: REQ1,
      capability: "sync-google",
      state: "pending",
      code: "accepted",
      message: "Request accepted.",
      createdAt: new Date(T0).toISOString(),
      updatedAt: new Date(T0).toISOString(),
    });
    expect(h.runs).toHaveLength(1);
  });

  test("replaying a request id returns the existing job without a second start", async () => {
    const h = harness();
    h.seed(REQ1, "sync-google");
    await h.wake(REQ1);
    h.state.now = T0 + 10 * MINUTE;
    const replay = await h.wake(REQ1);
    expect(replay).toMatchObject({ status: 202, body: { jobId: REQ1, state: "pending" } });
    expect(h.runs).toHaveLength(1);
  });

  test("a second request while one job is active attaches to it with its own job record", async () => {
    const h = harness();
    h.seed(REQ1, "sync-google");
    h.seed(REQ2, "sync-google");
    await h.wake(REQ1);
    h.state.now = T0 + 10 * MINUTE;
    expect(await h.wake(REQ2)).toMatchObject({ status: 202, body: { jobId: REQ2, state: "pending" } });
    expect(h.job(REQ2)).toMatchObject({ jobId: REQ2, capability: "sync-google", state: "pending" });
    expect(h.runs).toHaveLength(1);
  });
});

describe("Exo coalesced wakes share one run", () => {
  test("two wakes that race for the same owner and capability start one run", async () => {
    const h = harness();
    h.seed(REQ1, "sync-google");
    h.seed(REQ2, "sync-google");
    const [first, second] = await Promise.all([h.wake(REQ1), h.wake(REQ2)]);
    expect(first).toMatchObject({ status: 202, body: { jobId: REQ1 } });
    expect(second).toMatchObject({ status: 202, body: { jobId: REQ2 } });
    expect(h.runs).toHaveLength(1);
    expect(h.job(REQ2)).toMatchObject({ jobId: REQ2, capability: "sync-google" });
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
    expect(h.job(REQ1)).toMatchObject({ state: "done" });
    expect(h.job(REQ2)).toMatchObject({ state: "done" });
  });

  test("a run takes at most twenty attached wakes; the next is refused with rate_limited", async () => {
    const h = harness();
    const ids = Array.from({ length: 22 }, () => crypto.randomUUID());
    for (const id of ids) h.seed(id, "sync-google");
    await h.wake(ids[0]);
    for (const id of ids.slice(1, 21)) {
      expect(await h.wake(id)).toMatchObject({ status: 202, body: { jobId: id } });
    }
    expect(await h.wake(ids[21])).toEqual({ status: 429, body: { error: "rate_limited", retryAfterSec: 60 } });
    expect(h.job(ids[21])).toBeUndefined();
  });
});

describe("Exo connector gate", () => {
  test("a fireflies request with the connector switched off is refused before any job exists", async () => {
    const h = harness({ connectorOn: false });
    h.seed(REQ1, "sync-fireflies");
    expect(await h.wake(REQ1)).toEqual({
      status: 409,
      body: { error: "connector_off", source: "fireflies", link: ORIGIN },
    });
    expect(h.jobs.size).toBe(0);
  });
});

describe("Exo per-source cooldowns (TC-1013 D9)", () => {
  test("fireflies without a webhook waits one hour between starts", async () => {
    const h = harness();
    h.seed(REQ1, "sync-fireflies");
    h.seed(REQ2, "sync-fireflies");
    await h.wake(REQ1);
    await h.runs[0].report({ state: "done", code: "done" });
    h.state.now = T0 + 30 * MINUTE;
    expect(await h.wake(REQ2)).toEqual({ status: 429, body: { error: "rate_limited", retryAfterSec: 1800 } });
    h.state.now = T0 + HOUR;
    expect(await h.wake(REQ2)).toMatchObject({ status: 202, body: { jobId: REQ2 } });
  });

  test("fireflies with a webhook waits six hours between starts", async () => {
    const h = harness({ webhook: true });
    h.seed(REQ1, "sync-fireflies");
    h.seed(REQ2, "sync-fireflies");
    await h.wake(REQ1);
    await h.runs[0].report({ state: "done", code: "done" });
    h.state.now = T0 + HOUR;
    expect(await h.wake(REQ2)).toEqual({ status: 429, body: { error: "rate_limited", retryAfterSec: 5 * 3600 } });
    h.state.now = T0 + 6 * HOUR;
    expect(await h.wake(REQ2)).toMatchObject({ status: 202 });
  });

  test("google waits thirty minutes between starts", async () => {
    const h = harness();
    h.seed(REQ1, "sync-google");
    h.seed(REQ2, "sync-google");
    await h.wake(REQ1);
    await h.runs[0].report({ state: "done", code: "done" });
    h.state.now = T0 + 29 * MINUTE;
    expect(await h.wake(REQ2)).toEqual({ status: 429, body: { error: "rate_limited", retryAfterSec: 60 } });
    h.state.now = T0 + 30 * MINUTE;
    expect(await h.wake(REQ2)).toMatchObject({ status: 202 });
  });

  test("a finished job no longer coalesces, so the next start still waits out the cooldown", async () => {
    const h = harness();
    h.seed(REQ1, "sync-google");
    h.seed(REQ2, "sync-google");
    await h.wake(REQ1);
    await h.runs[0].report({ state: "done", code: "done" });
    h.state.now = T0 + MINUTE;
    expect(await h.wake(REQ2)).toEqual({ status: 429, body: { error: "rate_limited", retryAfterSec: 29 * 60 } });
  });

  test("the daily cap refuses with budget_exhausted and points to the next UTC day", async () => {
    const h = harness();
    const ledger = createMemoryExoLedger();
    h.ports.ledger = {
      ...ledger,
      snapshot: async () => ({ startsToday: 300, lastStartedAt: undefined }),
    };
    h.seed(REQ1, "sync-google");
    const nextDay = Math.floor(T0 / DAY + 1) * DAY;
    expect(await h.wake(REQ1)).toEqual({
      status: 429,
      body: { error: "budget_exhausted", retryAfterSec: Math.ceil((nextDay - T0) / 1000) },
    });
    expect(h.jobs.size).toBe(0);
  });
});

describe("Exo executor wiring", () => {
  test("no executor wired refuses the wake before any job is created", async () => {
    const h = harness({ executor: "absent" });
    h.seed(REQ1, "sync-google");
    expect(await h.wake(REQ1)).toEqual(UNIFORM);
    expect(h.jobs.size).toBe(0);
  });

  test("an executor that fails to start marks the job error with a code", async () => {
    const h = harness({ executor: "fails" });
    h.seed(REQ1, "sync-google");
    expect(await h.wake(REQ1)).toMatchObject({ status: 202 });
    await h.errorWritten.promise;
    expect(h.job(REQ1)).toMatchObject({ state: "error", code: "unavailable" });
  });

  test("executor progress updates the stored job state", async () => {
    const h = harness();
    h.seed(REQ1, "sync-google");
    await h.wake(REQ1);
    await h.runs[0].report({ state: "running", code: "running" });
    expect(h.job(REQ1)).toMatchObject({ state: "running", code: "running", message: "Sync running." });
    await h.runs[0].report({ state: "error", code: "unavailable" });
    expect(h.job(REQ1)).toMatchObject({ state: "error", code: "unavailable", message: "Sync unavailable." });
  });

  test("a lost put-if-absent race fails closed and starts nothing", async () => {
    const h = harness();
    h.seed(REQ1, "sync-google");
    h.ports.jobs.putIfAbsent = async () => false;
    expect(await h.wake(REQ1)).toEqual(UNIFORM);
    expect(h.runs).toHaveLength(0);
  });

  test("an executor code outside the vocabulary settles the job as unavailable and replays as 202", async () => {
    const h = harness();
    h.seed(REQ1, "sync-google");
    await h.wake(REQ1);
    await h.runs[0].report({ state: "running", code: "Some Title" } as unknown as ExecutorUpdate);
    expect(h.job(REQ1)).toMatchObject({ state: "error", code: "unavailable", message: "Sync unavailable." });
    expect(await h.wake(REQ1)).toMatchObject({ status: 202, body: { jobId: REQ1, state: "error", code: "unavailable" } });
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
    expect(await h.wake(REQ1)).toMatchObject({ status: 202, body: { jobId: REQ1, state: "error", code: "unavailable" } });
    expect(h.job(REQ1)).toMatchObject({ state: "error", code: "unavailable", message: "Sync unavailable." });
    expect(h.runs).toHaveLength(0);
    expect(await h.wake(REQ1)).toMatchObject({ status: 202, body: { jobId: REQ1, state: "error", code: "unavailable" } });

    h.ports.ledger = ledger;
    expect(await h.wake(REQ2)).toMatchObject({ status: 202, body: { jobId: REQ2, state: "pending" } });
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
    expect((await h.wake(REQ2)).status).toBe(202);
    expect(h.job(REQ1)).toMatchObject({ state: "error", code: "unavailable", message: "Sync unavailable." });
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
    const removed = await sweepExpiredJobs(h.ports.jobs, OWNER, now);
    expect(removed).toBe(1);
    expect([...h.jobs.keys()].sort()).toEqual([`${OWNER}|fresh`, `${OWNER}|junk`]);
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
    expect(warnings).toHaveLength(2);
  });
});

describe("Exo sync-meetings gate", () => {
  test("sync-meetings is refused with connector_off when no source is on", async () => {
    const h = harness({ connectorOn: false });
    h.seed(REQ1, "sync-meetings");
    expect(await h.wake(REQ1)).toEqual({ status: 409, body: { error: "connector_off", link: ORIGIN } });
    expect(h.jobs.size).toBe(0);
    expect(h.runs.length).toBe(0);
  });

  test("sync-meetings starts one job when a source is on", async () => {
    const h = harness({ connectorOn: true });
    h.seed(REQ1, "sync-meetings");
    expect((await h.wake(REQ1)).status).toBe(202);
    expect(h.runs.length).toBe(1);
  });
});
