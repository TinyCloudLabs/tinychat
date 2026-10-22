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
    wake(requestId: string, owner = OWNER) {
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
    h.seed("req-1", "sync-google");
    const result = await handleWake(h.ports, { owner: OWNER, requestId: "req-1", capability: "sync-google" });
    expect(result).toEqual(UNIFORM);
    expect(h.runs).toHaveLength(0);
  });

  test("an owner without an active grant is refused", async () => {
    const h = harness({ grant: false });
    h.seed("req-1", "sync-google");
    expect(await h.wake("req-1")).toEqual(UNIFORM);
    expect(h.jobs.size).toBe(0);
  });

  test("a request id with no request record is refused", async () => {
    const h = harness();
    expect(await h.wake("req-missing")).toEqual(UNIFORM);
    expect(h.jobs.size).toBe(0);
  });

  test("a request record with an extra key is refused", async () => {
    const h = harness();
    h.seed("req-1", "sync-google", { v: 1, capability: "sync-google", note: "x" });
    expect(await h.wake("req-1")).toEqual(UNIFORM);
    expect(h.jobs.size).toBe(0);
  });

  test("a request record naming a different capability than its path is refused", async () => {
    const h = harness();
    h.seed("req-1", "sync-fireflies", { v: 1, capability: "sync-google" });
    expect(await h.wake("req-1")).toEqual(UNIFORM);
    expect(h.jobs.size).toBe(0);
  });

  test("a request id present under two capability paths is refused", async () => {
    const h = harness();
    h.seed("req-1", "sync-google");
    h.seed("req-1", "sync-fireflies");
    expect(await h.wake("req-1")).toEqual(UNIFORM);
    expect(h.jobs.size).toBe(0);
  });

  test("a request id with a non-hex owner is refused before any store is read", async () => {
    const h = harness();
    h.seed("req-1", "sync-google");
    expect(await h.wake("req-1", "not-an-address")).toEqual(UNIFORM);
  });
});

describe("Exo wake accepts an exact grant and request", () => {
  test("a valid wake creates one pending job and starts it once", async () => {
    const h = harness();
    h.seed("req-1", "sync-google");
    const result = await h.wake("req-1");
    expect(result).toEqual({
      status: 202,
      body: { jobId: "req-1", state: "pending", code: "accepted", statusKey: `${EXO_NAMESPACE}/jobs/req-1` },
    });
    expect(h.job("req-1")).toEqual({
      v: 1,
      jobId: "req-1",
      capability: "sync-google",
      state: "pending",
      createdAt: new Date(T0).toISOString(),
      updatedAt: new Date(T0).toISOString(),
    });
    expect(h.runs).toHaveLength(1);
  });

  test("replaying a request id returns the existing job without a second start", async () => {
    const h = harness();
    h.seed("req-1", "sync-google");
    await h.wake("req-1");
    h.state.now = T0 + 10 * MINUTE;
    const replay = await h.wake("req-1");
    expect(replay).toMatchObject({ status: 202, body: { jobId: "req-1", state: "pending" } });
    expect(h.runs).toHaveLength(1);
  });

  test("a second request while one job is active returns the active job", async () => {
    const h = harness();
    h.seed("req-1", "sync-google");
    h.seed("req-2", "sync-google");
    await h.wake("req-1");
    h.state.now = T0 + 31 * MINUTE;
    const second = await h.wake("req-2");
    expect(second).toMatchObject({ status: 202, body: { jobId: "req-1" } });
    expect(h.runs).toHaveLength(1);
  });
});

describe("Exo connector gate", () => {
  test("a fireflies request with the connector switched off is refused before any job exists", async () => {
    const h = harness({ connectorOn: false });
    h.seed("req-1", "sync-fireflies");
    expect(await h.wake("req-1")).toEqual({
      status: 409,
      body: { error: "connector_off", source: "fireflies", link: ORIGIN },
    });
    expect(h.jobs.size).toBe(0);
  });
});

describe("Exo per-source cooldowns (TC-1013 D9)", () => {
  test("fireflies without a webhook waits one hour between starts", async () => {
    const h = harness();
    h.seed("req-1", "sync-fireflies");
    h.seed("req-2", "sync-fireflies");
    await h.wake("req-1");
    await h.runs[0].report({ state: "done" });
    h.state.now = T0 + 30 * MINUTE;
    expect(await h.wake("req-2")).toEqual({ status: 429, body: { error: "rate_limited", retryAfterSec: 1800 } });
    h.state.now = T0 + HOUR;
    expect(await h.wake("req-2")).toMatchObject({ status: 202, body: { jobId: "req-2" } });
  });

  test("fireflies with a webhook waits six hours between starts", async () => {
    const h = harness({ webhook: true });
    h.seed("req-1", "sync-fireflies");
    h.seed("req-2", "sync-fireflies");
    await h.wake("req-1");
    await h.runs[0].report({ state: "done" });
    h.state.now = T0 + HOUR;
    expect(await h.wake("req-2")).toEqual({ status: 429, body: { error: "rate_limited", retryAfterSec: 5 * 3600 } });
    h.state.now = T0 + 6 * HOUR;
    expect(await h.wake("req-2")).toMatchObject({ status: 202 });
  });

  test("google waits thirty minutes between starts", async () => {
    const h = harness();
    h.seed("req-1", "sync-google");
    h.seed("req-2", "sync-google");
    await h.wake("req-1");
    await h.runs[0].report({ state: "done" });
    h.state.now = T0 + 29 * MINUTE;
    expect(await h.wake("req-2")).toEqual({ status: 429, body: { error: "rate_limited", retryAfterSec: 60 } });
    h.state.now = T0 + 30 * MINUTE;
    expect(await h.wake("req-2")).toMatchObject({ status: 202 });
  });

  test("a finished job no longer coalesces, so the next start still waits out the cooldown", async () => {
    const h = harness();
    h.seed("req-1", "sync-google");
    h.seed("req-2", "sync-google");
    await h.wake("req-1");
    await h.runs[0].report({ state: "done" });
    h.state.now = T0 + MINUTE;
    expect(await h.wake("req-2")).toEqual({ status: 429, body: { error: "rate_limited", retryAfterSec: 29 * 60 } });
  });

  test("the daily cap refuses with budget_exhausted and points to the next UTC day", async () => {
    const h = harness();
    const ledger = createMemoryExoLedger();
    h.ports.ledger = {
      ...ledger,
      snapshot: async () => ({ startsToday: 300, lastStartedAt: undefined }),
    };
    h.seed("req-1", "sync-google");
    const nextDay = Math.floor(T0 / DAY + 1) * DAY;
    expect(await h.wake("req-1")).toEqual({
      status: 429,
      body: { error: "budget_exhausted", retryAfterSec: Math.ceil((nextDay - T0) / 1000) },
    });
    expect(h.jobs.size).toBe(0);
  });
});

describe("Exo executor wiring", () => {
  test("no executor wired refuses the wake before any job is created", async () => {
    const h = harness({ executor: "absent" });
    h.seed("req-1", "sync-google");
    expect(await h.wake("req-1")).toEqual(UNIFORM);
    expect(h.jobs.size).toBe(0);
  });

  test("an executor that fails to start marks the job error with a code", async () => {
    const h = harness({ executor: "fails" });
    h.seed("req-1", "sync-google");
    expect(await h.wake("req-1")).toMatchObject({ status: 202 });
    await h.errorWritten.promise;
    expect(h.job("req-1")).toMatchObject({ state: "error", code: "unavailable" });
  });

  test("executor progress updates the stored job state", async () => {
    const h = harness();
    h.seed("req-1", "sync-google");
    await h.wake("req-1");
    await h.runs[0].report({ state: "running" });
    expect(h.job("req-1")).toMatchObject({ state: "running" });
    await h.runs[0].report({ state: "error", code: "source_failed", message: "upstream rejected" });
    expect(h.job("req-1")).toMatchObject({ state: "error", code: "source_failed", message: "upstream rejected" });
  });

  test("a put-if-absent race returns the record that won and starts nothing", async () => {
    const h = harness();
    h.seed("req-1", "sync-google");
    h.ports.jobs.putIfAbsent = async (owner, jobId, record) => {
      h.jobs.set(`${owner}|${jobId}`, { ...record, state: "running" });
      return false;
    };
    expect(await h.wake("req-1")).toMatchObject({ status: 202, body: { jobId: "req-1", state: "running" } });
    expect(h.runs).toHaveLength(0);
  });
});

describe("Exo job retention sweep", () => {
  const record = (jobId: string, updatedAt: number): ExoJobRecord => ({
    v: 1,
    jobId,
    capability: "sync-google",
    state: "done",
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
