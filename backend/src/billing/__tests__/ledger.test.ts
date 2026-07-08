import { afterEach, describe, expect, mock, test } from "bun:test";
import { LedgerFlusher, type LedgerUsageRecord } from "../ledger-flusher.js";
import { LedgerRehydrator } from "../ledger-rehydrate.js";
import { TIERS } from "../tiers.js";
import { _resetUsage, getUsage, startOfUtcDay, startOfAnchoredWeek } from "../usage.js";

const ORIGINAL_FETCH = globalThis.fetch;

const BASE_RECORD = {
  account: "0xabc123",
  window_start: 1_000_000,
  window_kind: "utc_day" as const,
  credits: 10,
  model: "test/model",
  prompt_tokens: 100,
  completion_tokens: 50,
  occurred_at: 1_000_000,
  signed_token_count: null,
};

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  _resetUsage();
});

// ── (a) enqueue → flush commits batch ────────────────────────────────────────

describe("LedgerFlusher", () => {
  test("(a) enqueue + flush: batch posted, outbox cleared on 200", async () => {
    const captured: Array<{ url: string; body: unknown }> = [];
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : String(input);
      captured.push({ url, body: JSON.parse((init?.body as string) ?? "{}") });
      return new Response(JSON.stringify({ applied: 1, windows: [] }), { status: 200 });
    }) as typeof fetch;

    const flusher = new LedgerFlusher("http://sidecar", "secret");
    flusher.enqueue(BASE_RECORD);
    expect(flusher.outboxSize).toBe(1);

    await flusher.flush();

    expect(flusher.outboxSize).toBe(0);
    expect(captured).toHaveLength(1);
    expect(captured[0].url).toBe("http://sidecar/api/usage/ingest");
    const body = captured[0].body as { report_id: string; records: LedgerUsageRecord[] };
    expect(body.records).toHaveLength(1);
    expect(body.records[0].account).toBe(BASE_RECORD.account);
    expect(body.records[0].credits).toBe(BASE_RECORD.credits);
    expect(typeof body.records[0].record_id).toBe("string");
    expect(body.records[0].record_id.length).toBeGreaterThan(0);
    expect(body.records[0].signed_token_count).toBeNull();
  });

  // ── (b) outage: fetch rejects → outbox grows, no throw ───────────────────

  test("(b) outage: network error → outbox preserved, no throw", async () => {
    globalThis.fetch = mock(async () => {
      throw new Error("network error");
    }) as typeof fetch;

    const flusher = new LedgerFlusher("http://sidecar", "secret");
    flusher.enqueue(BASE_RECORD);
    flusher.enqueue({ ...BASE_RECORD, credits: 5 });

    expect(flusher.outboxSize).toBe(2);
    await expect(flusher.flush()).resolves.toBeUndefined(); // must not throw
    expect(flusher.outboxSize).toBe(2); // records retained
  });

  test("(b) non-200 response → outbox preserved", async () => {
    globalThis.fetch = mock(async () => {
      return new Response("internal error", { status: 500 });
    }) as typeof fetch;

    const flusher = new LedgerFlusher("http://sidecar", "secret");
    flusher.enqueue(BASE_RECORD);
    await flusher.flush();
    expect(flusher.outboxSize).toBe(1);
  });

  // ── (c) drain: fetch recovers → records posted once, no double-count ─────

  test("(c) drain after outage: same record_id posted once", async () => {
    let callCount = 0;
    const postedIds: string[] = [];
    globalThis.fetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      callCount++;
      if (callCount === 1) throw new Error("network down");
      const body = JSON.parse((init?.body as string) ?? "{}") as {
        records: LedgerUsageRecord[];
      };
      postedIds.push(...body.records.map((r) => r.record_id));
      return new Response(JSON.stringify({ applied: body.records.length, windows: [] }), {
        status: 200,
      });
    }) as typeof fetch;

    const flusher = new LedgerFlusher("http://sidecar", "secret");
    flusher.enqueue(BASE_RECORD);

    // First flush fails
    await flusher.flush();
    expect(flusher.outboxSize).toBe(1);

    // Second flush succeeds — the same record (same record_id) is sent once
    await flusher.flush();
    expect(flusher.outboxSize).toBe(0);
    expect(postedIds).toHaveLength(1); // posted exactly once, no double-count
  });

  // ── outbox cap ─────────────────────────────────────────────────────────────

  test("outbox overflow: oldest record dropped, size stays at cap", () => {
    globalThis.fetch = mock(async () => {
      throw new Error("unused");
    }) as typeof fetch;

    const flusher = new LedgerFlusher("http://sidecar", "secret");
    // Fill to cap
    for (let i = 0; i < 5000; i++) {
      flusher.enqueue({ ...BASE_RECORD, credits: i });
    }
    expect(flusher.outboxSize).toBe(5000);
    // One more: oldest should be dropped
    flusher.enqueue({ ...BASE_RECORD, credits: 9999 });
    expect(flusher.outboxSize).toBe(5000);
  });

  test("start/stop: interval starts and can be stopped without error", () => {
    const flusher = new LedgerFlusher("http://sidecar", "secret");
    flusher.start();
    flusher.start(); // idempotent
    flusher.stop();
    flusher.stop(); // idempotent
  });
});

// ── (d) rehydrate seeds counter to committed ─────────────────────────────────

describe("LedgerRehydrator", () => {
  test("(d) rehydrate seeds in-memory counter to committed_credits", async () => {
    const now = Date.now();
    const ws = startOfUtcDay(now);
    const committedCredits = 150;

    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : String(input);
      expect(url).toContain("/api/credit-entitlement/");
      expect(url).toContain(`window_start=${ws}`);
      return new Response(
        JSON.stringify({
          account: "0xtest",
          credit_limit: 500,
          period_anchor: "utc_day",
          window_start: ws,
          committed_credits: committedCredits,
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const rehydrator = new LedgerRehydrator("http://sidecar", "secret");
    const tier = TIERS.free; // budgetWindow: "day"

    const atLimit = await rehydrator.rehydrateIfNeeded("0xtest", tier, null, now);
    expect(atLimit).toBe(false);

    const usage = getUsage("0xtest", tier, null, now);
    expect(usage.used).toBe(committedCredits);
  });

  test("(d) rehydrate is idempotent: fires once per (address, window)", async () => {
    let fetchCalls = 0;
    globalThis.fetch = mock(async () => {
      fetchCalls++;
      return new Response(
        JSON.stringify({
          account: "0xtest2",
          credit_limit: 500,
          period_anchor: "utc_day",
          window_start: 0,
          committed_credits: 50,
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const now = Date.now();
    const rehydrator = new LedgerRehydrator("http://sidecar", "secret");
    const tier = TIERS.free;

    await rehydrator.rehydrateIfNeeded("0xtest2", tier, null, now);
    await rehydrator.rehydrateIfNeeded("0xtest2", tier, null, now); // same window → skip
    await rehydrator.rehydrateIfNeeded("0xtest2", tier, null, now); // again → skip

    expect(fetchCalls).toBe(1);
  });

  test("(d) committed < local → no change to counter", async () => {
    const now = Date.now();
    const tier = TIERS.free;
    // Pre-seed local counter to 200
    const { recordUsage } = await import("../usage.js");
    recordUsage("0xtest3", tier, 200, null, now);
    expect(getUsage("0xtest3", tier, null, now).used).toBe(200);

    globalThis.fetch = mock(async () => {
      return new Response(
        JSON.stringify({
          account: "0xtest3",
          credit_limit: 500,
          period_anchor: "utc_day",
          window_start: startOfUtcDay(now),
          committed_credits: 100, // less than local 200
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const rehydrator = new LedgerRehydrator("http://sidecar", "secret");
    await rehydrator.rehydrateIfNeeded("0xtest3", tier, null, now);

    // Counter should not decrease
    expect(getUsage("0xtest3", tier, null, now).used).toBe(200);
  });

  test("(d) committed_credits null → counter unchanged", async () => {
    const now = Date.now();
    const tier = TIERS.free;

    globalThis.fetch = mock(async () => {
      return new Response(
        JSON.stringify({
          account: "0xtest4",
          credit_limit: 500,
          period_anchor: "utc_day",
          window_start: null,
          committed_credits: null,
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const rehydrator = new LedgerRehydrator("http://sidecar", "secret");
    await rehydrator.rehydrateIfNeeded("0xtest4", tier, null, now);

    expect(getUsage("0xtest4", tier, null, now).used).toBe(0);
  });

  // ── (e) K-cap: 200 failing rehydrates → 201st degrades to at-limit ────────

  test("(e) K-cap: after 200 failing first-touch rehydrates a new address degrades", async () => {
    globalThis.fetch = mock(async () => {
      throw new Error("sidecar unreachable");
    }) as typeof fetch;

    const rehydrator = new LedgerRehydrator("http://sidecar", "secret");
    const tier = TIERS.free;
    const now = Date.now();

    // 200 distinct addresses, each failing first-touch → all served (atLimit false)
    for (let i = 0; i < 200; i++) {
      const addr = `0x${i.toString(16).padStart(40, "0")}`;
      const atLimit = await rehydrator.rehydrateIfNeeded(addr, tier, null, now);
      expect(atLimit).toBe(false);
    }
    expect(rehydrator.unrehydratedServesCount).toBe(200);

    // 201st distinct address — unrehydratedServes exceeds K=200 → degrade
    const addr201 = `0x${"f".repeat(40)}`;
    const atLimit201 = await rehydrator.rehydrateIfNeeded(addr201, tier, null, now);
    expect(atLimit201).toBe(true);
    expect(rehydrator.unrehydratedServesCount).toBe(201);
  });

  test("(e) K-cap: successful rehydrate does not increment counter", async () => {
    globalThis.fetch = mock(async () => {
      return new Response(
        JSON.stringify({
          account: "0xok",
          credit_limit: 500,
          period_anchor: "utc_day",
          window_start: 0,
          committed_credits: 10,
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const rehydrator = new LedgerRehydrator("http://sidecar", "secret");
    await rehydrator.rehydrateIfNeeded("0xok", TIERS.free, null);
    expect(rehydrator.unrehydratedServesCount).toBe(0);
  });

  test("(d) anchored-week window_start matches usage.ts startOfAnchoredWeek", async () => {
    const anchor = Date.UTC(2026, 0, 1); // 2026-01-01 as anchor
    const now = Date.UTC(2026, 0, 5, 12); // 5 days later
    const expectedWs = startOfAnchoredWeek(anchor, now);

    let queriedUrl = "";
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      queriedUrl = typeof input === "string" ? input : String(input);
      return new Response(
        JSON.stringify({
          account: "0xweek",
          credit_limit: 12000,
          period_anchor: "anchored_week",
          window_start: expectedWs,
          committed_credits: 500,
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const rehydrator = new LedgerRehydrator("http://sidecar", "secret");
    await rehydrator.rehydrateIfNeeded("0xweek", TIERS.plus, anchor, now);

    expect(queriedUrl).toContain(`window_start=${expectedWs}`);
    // Counter seeded to 500
    const usage = getUsage("0xweek", TIERS.plus, anchor, now);
    expect(usage.used).toBe(500);
  });
});
