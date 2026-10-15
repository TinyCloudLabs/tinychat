// Agent-host Fireflies runner (TC-1192): the real engine and store against fake-tinycloud and an
// in-memory Fireflies upstream, driven through runFirefliesAgentSync's guards.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as connectorStore from "../../frontend/src/lib/connectors/connectorStore";
import { _resetConnectorSchemaMemoForTests, firefliesAttemptKvKey } from "../../frontend/src/lib/connectors/connectorStore";
import {
  MAX_REQUESTS_PER_DAY,
  runFirefliesAgentSync,
  type AuditPort,
  type RunDeps,
} from "../../scripts/agent-sync/fireflies";
import { makeFakeTinyCloud, type FakeTinyCloud } from "./fake-tinycloud";
import { buildSeed } from "./mock-fireflies.mjs";

const KEY = "ff-agent-sync-test-key-0123456789abcdef";

interface SeedRow { id: string; date: number; sentences: unknown; summary: unknown; speakers: unknown; meeting_attendees: unknown }

interface Upstream {
  fetchImpl: typeof fetch;
  calls: { list: number; detail: number };
}

function upstream(seed: SeedRow[]): Upstream {
  const calls = { list: 0, detail: 0 };
  const fetchImpl = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request: { query: string; variables?: { id?: string; limit?: number; skip?: number } } = JSON.parse(String(init?.body));
    const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    if (request.query.includes("ListTranscripts")) {
      calls.list++;
      const skip = request.variables?.skip ?? 0;
      const limit = request.variables?.limit ?? 25;
      return json({
        data: {
          transcripts: seed.slice(skip, skip + limit).map(({ sentences: _s, summary: _m, speakers: _p, meeting_attendees: _a, ...row }) => row),
        },
      });
    }
    calls.detail++;
    return json({ data: { transcript: seed.find((item) => item.id === request.variables?.id) ?? null } });
  };
  return { fetchImpl: Object.assign(fetchImpl, { preconnect: fetch.preconnect }), calls };
}

function fakeAudit(fake: FakeTinyCloud): AuditPort {
  return {
    async tables() {
      return {
        counts: { connector_meeting: fake.sql.meetings.size, connector_state: fake.sql.states.size },
        schemaHash: [...fake.sql.createdTables].sort().join(","),
      };
    },
    async siblingsOf(id) {
      const own = fake.sql.meetings.get(id);
      if (!own) return [];
      return [...fake.sql.meetings.values()]
        .filter((row) => row.source === "fireflies" && row.source_id === own.source_id)
        .map((row) => row.id);
    },
    async deleteOwnRow(id) {
      fake.sql.meetings.delete(id);
    },
  };
}

let stateDir: string;
let fake: FakeTinyCloud;
let seed: SeedRow[];
let provider: Upstream;
let keyReads: number;

async function seedConnected(lastSyncedAt: string | null) {
  const schema = await connectorStore.ensureSchema(fake.tcw);
  expect(schema.ok).toBe(true);
  fake.sql.states.set("fireflies", {
    connector_id: "fireflies",
    status: "connected",
    last_synced_at: lastSyncedAt,
    last_sync_status: "ok",
    last_sync_error: null,
    item_count: 0,
    updated_at: "2026-10-13T20:05:40.921Z",
  });
}

function deps(overrides: Partial<RunDeps> = {}): RunDeps {
  return {
    tcw: fake.tcw,
    readApiKey: async () => {
      keyReads++;
      return KEY;
    },
    audit: fakeAudit(fake),
    stateDir,
    mode: "auto",
    fetchImpl: provider.fetchImpl,
    apiUrl: "https://fireflies.invalid/graphql",
    delayMs: 0,
    ...overrides,
  };
}

const later = (ms: number) => () => new Date(Date.now() + ms);

beforeEach(() => {
  _resetConnectorSchemaMemoForTests();
  stateDir = mkdtempSync(join(tmpdir(), "agent-sync-"));
  fake = makeFakeTinyCloud();
  seed = buildSeed();
  provider = upstream(seed);
  keyReads = 0;
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

describe("Fireflies agent runner", () => {
  test("a stale connector syncs every meeting; the next run is a no-op; the key never reaches the report", async () => {
    await seedConnected("2026-06-01T00:00:00.000Z");

    const first = await runFirefliesAgentSync(deps());
    expect(first.result).toBe("synced");
    expect(first.status).toBe("ok");
    expect(first.added).toBe(seed.length);
    expect(fake.sql.meetings.size).toBe(seed.length);
    expect(first.tableDeltas).toEqual({ connector_meeting: seed.length });
    expect(first.httpRequests).toBe(provider.calls.list + provider.calls.detail);
    expect(first.lastSyncedAt).not.toBe("2026-06-01T00:00:00.000Z");
    expect(first.lastRunAt).not.toBeNull();
    expect(JSON.stringify(first)).not.toContain(KEY);
    expect(readFileSync(join(stateDir, "fireflies-runner.json"), "utf8")).not.toContain(KEY);

    // Auto mode right after a sync: fresh, no key read, no upstream call.
    const calls = provider.calls.list + provider.calls.detail;
    const fresh = await runFirefliesAgentSync(deps());
    expect(fresh.result).toBe("fresh");
    expect(fresh.lastRunAt).toBe(first.lastRunAt);
    expect(keyReads).toBe(1);

    // On demand once the busy window has passed: runs, adds nothing, fetches no detail.
    const detailsBefore = provider.calls.detail;
    const again = await runFirefliesAgentSync(deps({ mode: "now", now: later(31 * 60 * 1000) }));
    expect(again.result).toBe("synced");
    expect(again.added).toBe(0);
    expect(again.tableDeltas).toEqual({});
    expect(provider.calls.detail).toBe(detailsBefore);
    expect(provider.calls.list + provider.calls.detail).toBeGreaterThan(calls);
  });

  test("a partial run leaves the watermark stale but reports when it ran", async () => {
    await seedConnected(null);
    fake.sql.nextMeetingWriteError = { code: "SQL_ERROR", message: "transient write failure" };
    const report = await runFirefliesAgentSync(deps());
    expect(report.result).toBe("partial");
    expect(report.lastSyncedAt).toBeNull();
    expect(report.lastRunAt).not.toBeNull();

    // The stale watermark still triggers the next auto run once the busy window has passed.
    const next = await runFirefliesAgentSync(deps({ now: later(31 * 60 * 1000) }));
    expect(next.result).toBe("synced");
  });

  test("a storage limit on the user's space is reported as storage_full", async () => {
    await seedConnected(null);
    fake.sql.nextMeetingWriteError = { code: "STORAGE_LIMIT_REACHED", message: "storage limit reached" };
    const report = await runFirefliesAgentSync(deps({ mode: "now" }));
    expect(report.result).toBe("storage_full");
  });

  test("a recent attempt record from another writer makes the run busy without reading the key", async () => {
    await seedConnected(null);
    fake.kv.entries.set(firefliesAttemptKvKey(), JSON.stringify({
      v: 1, last_attempt_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(), last_attempt_status: "running",
    }));
    const report = await runFirefliesAgentSync(deps({ mode: "now" }));
    expect(report.result).toBe("busy");
    expect(keyReads).toBe(0);
    expect(provider.calls.list + provider.calls.detail).toBe(0);
  });

  test("a disconnected connector is left alone", async () => {
    await seedConnected(null);
    fake.sql.states.get("fireflies")!.status = "disconnected";
    const report = await runFirefliesAgentSync(deps({ mode: "now" }));
    expect(report.result).toBe("not_connected");
    expect(keyReads).toBe(0);
  });

  test("the daily request budget counts every HTTP attempt and stops the run as capped", async () => {
    await seedConnected(null);
    const day = new Date().toISOString().slice(0, 10);
    writeFileSync(join(stateDir, "fireflies-runner.json"), JSON.stringify({ day, runs: 0, requests: MAX_REQUESTS_PER_DAY - 5, inserted: [] }));
    const report = await runFirefliesAgentSync(deps({ mode: "now" }));
    expect(report.result).toBe("capped");
    expect(report.httpRequests).toBe(5);
    expect(provider.calls.list + provider.calls.detail).toBe(5);
    expect(report.requestsToday).toBe(MAX_REQUESTS_PER_DAY);
    expect(report.status).not.toBe("ok");

    const next = await runFirefliesAgentSync(deps({ mode: "now", now: later(31 * 60 * 1000) }));
    expect(next.result).toBe("capped");
    expect(next.httpRequests).toBe(0);
  });

  test("a duplicate row inserted by the browser costs the runner its own row, never the browser's", async () => {
    await seedConnected(null);
    const first = await runFirefliesAgentSync(deps({ mode: "now" }));
    expect(first.result).toBe("synced");

    const [ownId, own] = [...fake.sql.meetings.entries()][0];
    fake.sql.meetings.set("browser-row", { ...own, id: "browser-row" });

    const second = await runFirefliesAgentSync(deps({ mode: "now", now: later(31 * 60 * 1000) }));
    expect(second.duplicateRowsRemoved).toBe(1);
    expect(fake.sql.meetings.has(ownId)).toBe(false);
    expect(fake.sql.meetings.has("browser-row")).toBe(true);
    expect(fake.sql.meetings.size).toBe(seed.length);
  });

  test("a recent meeting missing below the engine's listing window is re-queued and restored on the next run", async () => {
    // Three days old: older than the engine's watermark lag (24 h), inside the 7-day gap audit.
    seed.forEach((item, index) => { item.date = Date.now() - 3 * 24 * 3600_000 - index * 3600_000; });
    await seedConnected(null);
    expect((await runFirefliesAgentSync(deps({ mode: "now" }))).result).toBe("synced");

    const lost = [...fake.sql.meetings.values()].find((row) => row.source_id === seed[3].id)!;
    fake.sql.meetings.delete(lost.id);

    const audit = await runFirefliesAgentSync(deps({ mode: "now", now: later(31 * 60 * 1000) }));
    expect(audit.gapIds).toBe(1);
    expect(audit.requeued).toBe(1);
    expect(fake.sql.meetings.size).toBe(seed.length - 1);

    const restored = await runFirefliesAgentSync(deps({ mode: "now", now: later(62 * 60 * 1000) }));
    expect(restored.added).toBe(1);
    expect([...fake.sql.meetings.values()].some((row) => row.source_id === seed[3].id)).toBe(true);
  });

  test("a held lock blocks a second runner", async () => {
    await seedConnected(null);
    writeFileSync(join(stateDir, "fireflies.lock"), `1 ${new Date().toISOString()}\n`);
    const report = await runFirefliesAgentSync(deps({ mode: "now" }));
    expect(report.result).toBe("locked");
    expect(keyReads).toBe(0);
  });
});
