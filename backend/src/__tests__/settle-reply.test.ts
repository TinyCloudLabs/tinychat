import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { settleReply, type ReplyOutcome } from "../billing/settle.js";
import { LedgerFlusher, type LedgerUsageRecordInput } from "../billing/ledger-flusher.js";
import { _resetUsage, getUsage, recordUsage, startOfAnchoredWeek, startOfUtcDay } from "../billing/usage.js";
import * as usageModule from "../billing/usage.js";
import { TIERS } from "../billing/tiers.js";
import type { ModelRates } from "../billing/credits.js";

const address = "0xsettle";
const LIMIT = 1000;
const DAY = 24 * 60 * 60 * 1000;
const startedAt = Date.UTC(2026, 10, 9, 12);
// One credit per completion token, free prompt: raw credits == completion tokens.
const rates: ModelRates = { creditsPerKInput: 0, creditsPerKOutput: 1000, fallback: false };
const originalEnv = { ...process.env };
let info: ReturnType<typeof spyOn>;
let enqueued: LedgerUsageRecordInput[];
const flusher = { enqueue: (record: LedgerUsageRecordInput) => { enqueued.push(record); } };

beforeEach(() => {
  process.env.CREDIT_BUDGET_FREE = String(LIMIT);
  _resetUsage();
  enqueued = [];
  info = spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => { process.env = { ...originalEnv }; info.mockRestore(); _resetUsage(); });

const usedAt = (at = startedAt) => getUsage(address, TIERS.free, null, at).used;
function settle(over: { allowance: number; observed: number; outcome: ReplyOutcome; delivered?: boolean; executionId?: string; at?: number }) {
  return settleReply({
    address, tier: TIERS.free, anchor: null, startedAt: over.at ?? startedAt, allowance: over.allowance, model: "m",
    usage: { promptTokens: 0, completionTokens: over.observed }, rates, outcome: over.outcome,
    deliveredOutput: over.delivered ?? true, executionId: over.executionId ?? crypto.randomUUID(), flusher,
  });
}
const loggedRaw = () => info.mock.calls.map((call: unknown[]) => call[1] as Record<string, unknown> | undefined).find(entry => entry && "rawCredits" in entry);

describe("rule (a): the user is never charged above the limit", () => {
  test("late usage above the allowance after a limit stop charges at most the allowance, and the excess stays in the raw log", () => {
    recordUsage(address, TIERS.free, 500, null, startedAt);
    const settled = settle({ allowance: 500, observed: 1450, outcome: "limit_stop" });
    expect(settled.charged).toBe(500);
    expect(usedAt()).toBe(LIMIT);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].credits).toBe(500);
    expect(enqueued[0].completion_tokens).toBe(1450);
    expect(loggedRaw()).toMatchObject({ rawCredits: 1450, charged: 500 });
  });

  test("a normal reply under the allowance is charged what it used", () => {
    const settled = settle({ allowance: 500, observed: 120, outcome: "success" });
    expect(settled.charged).toBe(120);
    expect(usedAt()).toBe(120);
  });

  test("a stale allowance cannot push the window past the limit", () => {
    recordUsage(address, TIERS.free, 950, null, startedAt);
    const settled = settle({ allowance: 500, observed: 400, outcome: "success" });
    expect(settled.charged).toBe(50);
    expect(usedAt()).toBe(LIMIT);
  });

  test("two replies admitted together near the limit charge exactly the limit in total", () => {
    recordUsage(address, TIERS.free, 950, null, startedAt);
    const first = settle({ allowance: 50, observed: 50, outcome: "success" });
    const second = settle({ allowance: 50, observed: 50, outcome: "success" });
    expect([first.charged, second.charged]).toEqual([50, 0]);
    expect(usedAt()).toBe(LIMIT);
    // A fully clamped reply leaves no ledger record.
    expect(enqueued).toHaveLength(1);
  });
});

describe("rule (b): a reply that fails before any output reached the user is free", () => {
  test("failure with nothing delivered charges nothing and enqueues nothing, but logs the raw usage", () => {
    const settled = settle({ allowance: 500, observed: 300, outcome: "failed", delivered: false });
    expect(settled.charged).toBe(0);
    expect(usedAt()).toBe(0);
    expect(enqueued).toEqual([]);
    expect(loggedRaw()).toMatchObject({ rawCredits: 300, charged: 0 });
  });

  test("failure after content was delivered is charged, clamped to the allowance", () => {
    expect(settle({ allowance: 500, observed: 300, outcome: "failed", delivered: true }).charged).toBe(300);
    _resetUsage();
    expect(settle({ allowance: 500, observed: 1450, outcome: "failed", delivered: true }).charged).toBe(500);
  });

  test("a reply stopped before any provider call used nothing and is free", () => {
    const settled = settle({ allowance: 500, observed: 0, outcome: "limit_stop", delivered: false });
    expect(settled.charged).toBe(0);
    expect(enqueued).toEqual([]);
  });

  test("a limit stop after a provider call is charged even when nothing was delivered", () => {
    expect(settle({ allowance: 500, observed: 700, outcome: "limit_stop", delivered: false }).charged).toBe(500);
  });
});

describe("rule (c): a timed-out reply is charged at most the allowance it started with", () => {
  test.each([[300, 300], [1450, 500]])("observed %i credits -> charged %i", (observed, charged) => {
    expect(settle({ allowance: 500, observed, outcome: "timed_out", delivered: false }).charged).toBe(charged);
    expect(usedAt()).toBe(charged);
  });

  test("a cancelled reply is charged like a finished one, clamped", () => {
    expect(settle({ allowance: 500, observed: 1450, outcome: "cancelled" }).charged).toBe(500);
  });
});

describe("window at reply start", () => {
  // Settlement happens a minute after the next UTC midnight; only `startedAt` says where the reply began.
  let clock: ReturnType<typeof spyOn>;
  beforeEach(() => { clock = spyOn(Date, "now").mockReturnValue(startedAt + DAY + 60_000); });
  afterEach(() => clock.mockRestore());

  test("a reply that settles after midnight charges the window it started in", () => {
    const settled = settle({ allowance: 500, observed: 300, outcome: "success" });
    expect(settled).toMatchObject({ charged: 300, windowKind: "day", windowStart: startOfUtcDay(startedAt) });
    expect(usedAt(startedAt)).toBe(300);
    expect(usedAt(startedAt + DAY)).toBe(0);
    expect(enqueued[0]).toMatchObject({ window_start: startOfUtcDay(startedAt), window_kind: "utc_day", occurred_at: startedAt + DAY + 60_000 });
  });

  test("a newer window's usage stays intact; the old window is charged through the ledger only, clamped to the allowance", () => {
    recordUsage(address, TIERS.free, 120, null, startedAt + DAY);
    const settled = settle({ allowance: 500, observed: 1450, outcome: "success" });
    expect(settled.charged).toBe(500);
    expect(usedAt(startedAt + DAY)).toBe(120);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]).toMatchObject({ credits: 500, window_start: startOfUtcDay(startedAt), window_kind: "utc_day" });
  });

  test("replies admitted before midnight cannot push the old window past its limit once the record has rolled", () => {
    recordUsage(address, TIERS.free, 950, null, startedAt);
    const z = settle({ allowance: 50, observed: 50, outcome: "success" });
    // A reply after midnight rolls the single current record to the new day.
    recordUsage(address, TIERS.free, 10, null, startedAt + DAY);
    const x = settle({ allowance: 50, observed: 50, outcome: "success" });
    expect([z.charged, x.charged]).toEqual([50, 0]);
    const oldWindow = enqueued.filter(record => record.window_start === startOfUtcDay(startedAt));
    expect(950 + oldWindow.reduce((sum, record) => sum + record.credits, 0)).toBe(LIMIT);
    expect(usedAt(startedAt + DAY)).toBe(10);
  });

  test("a paid reply reports the anchored week it was charged to", () => {
    const anchor = Date.UTC(2026, 10, 3, 8);
    const settled = settleReply({
      address, tier: TIERS.plus, anchor, startedAt, allowance: 500, model: "m", usage: { promptTokens: 0, completionTokens: 40 },
      rates, outcome: "success", deliveredOutput: true, executionId: "paid", flusher,
    });
    expect(settled).toMatchObject({ charged: 40, windowKind: "week", windowStart: startOfAnchoredWeek(anchor, startedAt) });
    expect(enqueued[0]).toMatchObject({ window_kind: "anchored_week", window_start: startOfAnchoredWeek(anchor, startedAt) });
  });
});

describe("a window whose record has moved aside is still bounded by its limit", () => {
  const twice = () => [settle({ allowance: 1000, observed: 800, outcome: "success" }), settle({ allowance: 1000, observed: 800, outcome: "success" })];

  test("a record rolled forward before anything was recorded for the reply's window", () => {
    // The reply's day has no record at all; a later day's reply already rolled the single record.
    recordUsage(address, TIERS.free, 10, null, startedAt + DAY);
    expect(twice().map(settled => settled.charged)).toEqual([800, 200]);
    expect(usedAt(startedAt + DAY)).toBe(10);
  });

  test.each([
    ["a week record that started before the day", Date.UTC(2026, 10, 6)],
    ["a week record that starts at the same instant as the day", startOfUtcDay(startedAt)],
  ])("a tier switch (%s) keeps the day's usage and the week's usage", (_name, anchor) => {
    recordUsage(address, TIERS.free, 400, null, startedAt);
    // The switch moves the day record aside and makes the week record current.
    recordUsage(address, TIERS.plus, 10, anchor, startedAt);
    const [first, second] = [settle({ allowance: 600, observed: 900, outcome: "success" }), settle({ allowance: 600, observed: 900, outcome: "success" })];
    expect([first.charged, second.charged]).toEqual([600, 0]);
    expect(getUsage(address, TIERS.plus, anchor, startedAt).used).toBe(10);
  });
});

describe("exactly once per reply", () => {
  test("one local record and one ledger record carrying the execution id", () => {
    const executionId = "6d2c36e5-9c1d-4a38-a3ff-0e1f8c1c5a11";
    settle({ allowance: 500, observed: 120, outcome: "success", executionId });
    expect(usedAt()).toBe(120);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].record_id).toBe(executionId);
  });

  test("a ledger enqueue failure never loses the local charge, throws, or repeats it, and logs what reconciliation needs", () => {
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      const settled = settleReply({
        address, tier: TIERS.free, anchor: null, startedAt, allowance: 500, model: "m", usage: { promptTokens: 0, completionTokens: 120 },
        rates, outcome: "success", deliveredOutput: true, executionId: "x", flusher: { enqueue() { throw new Error("outbox down: private prompt text"); } },
      });
      expect(settled.charged).toBe(120);
      expect(usedAt()).toBe(120);
      expect(error).toHaveBeenCalledTimes(1);
      expect(error.mock.calls[0][1]).toEqual({ executionId: "x", account: address, model: "m", charged: 120, rawCredits: 120, windowKind: "day", windowStart: startOfUtcDay(startedAt) });
      expect(JSON.stringify(error.mock.calls)).not.toMatch(/outbox down|private prompt/);
    } finally { error.mockRestore(); }
  });

  test("a throwing local record does not skip the ledger enqueue", () => {
    const error = spyOn(console, "error").mockImplementation(() => {});
    const record = spyOn(usageModule, "recordUsage").mockImplementation(() => { throw new Error("counter broke"); });
    try {
      const settled = settle({ allowance: 500, observed: 120, outcome: "success", executionId: "y" });
      expect(settled.charged).toBe(120);
      expect(enqueued).toHaveLength(1);
      expect(enqueued[0]).toMatchObject({ record_id: "y", credits: 120 });
      expect(error.mock.calls[0][1]).toMatchObject({ executionId: "y", charged: 120 });
      expect(JSON.stringify(error.mock.calls)).not.toContain("counter broke");
    } finally { record.mockRestore(); error.mockRestore(); }
  });
});

describe("ledger record id", () => {
  async function flushedIds(records: Array<Partial<LedgerUsageRecordInput> & { record_id?: string }>) {
    const originalFetch = globalThis.fetch;
    let sent: Array<{ record_id: string }> = [];
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => { sent = JSON.parse(String(init?.body)).records; return new Response("{}"); }) as typeof fetch;
    try {
      const ledger = new LedgerFlusher("https://ledger.test", "secret");
      for (const record of records) ledger.enqueue({ account: "a", window_start: 0, window_kind: "utc_day", credits: 1, model: "m", prompt_tokens: 0, completion_tokens: 1, occurred_at: 0, signed_token_count: null, ...record });
      await ledger.flush();
      return sent.map(record => record.record_id);
    } finally { globalThis.fetch = originalFetch; }
  }

  test("a supplied record id is kept so a replayed enqueue is the same record", async () => {
    expect(await flushedIds([{ record_id: "execution-1" }])).toEqual(["execution-1"]);
  });

  test("records without one still get distinct ids", async () => {
    const [a, b] = await flushedIds([{}, {}]);
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThan(0);
  });
});
