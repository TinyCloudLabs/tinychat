import { describe, expect, test } from "bun:test";
import { createDurableExoLedger } from "../exo/durable-ledger.js";
import { EXO_NAMESPACE, type ExoCapability } from "../exo/mailbox.js";
import { ACTIVE_RUN_TTL_MS, type ExoStartGate } from "../exo/ledger-model.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const T0 = Date.UTC(2026, 0, 10, 12, 0, 0);
const OWNER = "0xowner";
const CAPABILITY: ExoCapability = "sync-google";
const KEY = `${EXO_NAMESPACE}/ledger/${OWNER}/${CAPABILITY}`;
const GATE: ExoStartGate = { dailyCap: 150, minIntervalMs: HOUR_MS };

interface Row {
  value: string;
  version: number;
}

/** Backend KV that honours `ifMatch` and `ifNoneMatch` with the SDK's result envelopes. */
function fakeLedgerKv() {
  const rows = new Map<string, Row>();
  const precondition = { ok: false, error: { code: "KV_PRECONDITION_FAILED", service: "kv", message: "precondition failed" } };
  const kv = {
    rows,
    puts: [] as Array<{ key: string }>,
    /** Runs once, inside the next put, before its condition is checked. */
    beforePut: undefined as undefined | (() => Promise<void>),
    /** Makes every put fail its condition. */
    forceConflict: false,
    async get(key: string) {
      const row = rows.get(key);
      if (!row) return { ok: false, error: { code: "KV_NOT_FOUND", service: "kv", message: `Key not found: ${key}` } };
      return { ok: true, data: { data: row.value, headers: { etag: `"${row.version}"` } } };
    },
    async put(key: string, value: unknown, options: { ifMatch?: string; ifNoneMatch?: "*" } = {}) {
      kv.puts.push({ key });
      const hook = kv.beforePut;
      kv.beforePut = undefined;
      if (hook) await hook();
      const row = rows.get(key);
      if (kv.forceConflict) return precondition;
      if (options.ifNoneMatch === "*" && row) return precondition;
      if (options.ifMatch !== undefined && (!row || `"${row.version}"` !== options.ifMatch)) return precondition;
      rows.set(key, { value: JSON.stringify(value), version: (row?.version ?? 0) + 1 });
      return { ok: true };
    },
  };
  return kv;
}

describe("durable exo ledger", () => {
  test("cooldown, daily count, and the active run survive a restart", async () => {
    const kv = fakeLedgerKv();
    expect(await createDurableExoLedger(kv).recordStart(OWNER, CAPABILITY, "job-1", T0, GATE)).toEqual({ started: true });

    const restarted = createDurableExoLedger(kv);
    expect(await restarted.snapshot(OWNER, CAPABILITY, T0 + 1000)).toEqual({
      lastStartedAt: T0,
      startsToday: 1,
      activeJobId: "job-1",
      activeSince: T0,
      attachedJobIds: [],
    });
    expect(await restarted.recordStart(OWNER, CAPABILITY, "job-2", T0 + 2000, GATE)).toEqual({
      started: false,
      reason: "active",
      retryAfterMs: 0,
    });

    expect(await restarted.clearActive(OWNER, CAPABILITY, "job-1")).toEqual([]);
    expect(await restarted.recordStart(OWNER, CAPABILITY, "job-2", T0 + 30 * 60 * 1000, GATE)).toEqual({
      started: false,
      reason: "cooldown",
      retryAfterMs: 30 * 60 * 1000,
    });
    expect(await restarted.recordStart(OWNER, CAPABILITY, "job-2", T0 + HOUR_MS, GATE)).toEqual({ started: true });
  });

  test("the daily cap refuses until the UTC day rolls over", async () => {
    const ledger = createDurableExoLedger(fakeLedgerKv());
    const capped: ExoStartGate = { dailyCap: 2 };
    expect(await ledger.recordStart(OWNER, CAPABILITY, "job-1", T0, capped)).toEqual({ started: true });
    await ledger.clearActive(OWNER, CAPABILITY, "job-1");
    expect(await ledger.recordStart(OWNER, CAPABILITY, "job-2", T0 + 1000, capped)).toEqual({ started: true });
    await ledger.clearActive(OWNER, CAPABILITY, "job-2");
    const nextDayStart = (Math.floor(T0 / DAY_MS) + 1) * DAY_MS;
    expect(await ledger.recordStart(OWNER, CAPABILITY, "job-3", T0 + 2000, capped)).toEqual({
      started: false,
      reason: "budget",
      retryAfterMs: nextDayStart - (T0 + 2000),
    });
    expect(await ledger.recordStart(OWNER, CAPABILITY, "job-3", nextDayStart, capped)).toEqual({ started: true });
  });

  test("a lost compare-and-set re-reads and refuses on the run that won the race", async () => {
    const kv = fakeLedgerKv();
    const winner = createDurableExoLedger(kv);
    const loser = createDurableExoLedger(kv);
    // The first put is the loser's source-lock write. The competing writer commits between that read and its conditional put.
    kv.beforePut = async () => {
      expect(await winner.recordStart(OWNER, CAPABILITY, "job-winner", T0, GATE)).toEqual({ started: true });
    };

    expect(await loser.recordStart(OWNER, CAPABILITY, "job-loser", T0, GATE)).toEqual({
      started: false,
      reason: "active",
      retryAfterMs: 0,
    });
    // The loser's lock put lost the race and it re-read the winner's hold. Only the winner writes the ledger.
    expect(kv.puts.filter((put) => put.key === KEY)).toHaveLength(1);
    expect(JSON.parse(kv.rows.get(KEY)?.value ?? "null")).toMatchObject({ activeJobId: "job-winner" });
  });

  test("a lost compare-and-set on attach re-reads so neither coalesced wake is dropped", async () => {
    const kv = fakeLedgerKv();
    const ledger = createDurableExoLedger(kv);
    await ledger.recordStart(OWNER, CAPABILITY, "job-run", T0, GATE);
    const other = createDurableExoLedger(kv);
    kv.beforePut = async () => {
      await other.attach(OWNER, CAPABILITY, "job-other");
    };
    await ledger.attach(OWNER, CAPABILITY, "job-mine");
    expect(await ledger.snapshot(OWNER, CAPABILITY, T0 + 1)).toMatchObject({
      activeJobId: "job-run",
      attachedJobIds: ["job-other", "job-mine"],
    });
  });

  test("compare-and-set attempts are bounded and then throw, so the caller fails closed", async () => {
    const kv = fakeLedgerKv();
    kv.forceConflict = true;
    await expect(createDurableExoLedger(kv).recordStart(OWNER, CAPABILITY, "job-1", T0, GATE)).rejects.toThrow(
      "retries exhausted",
    );
    expect(kv.puts).toHaveLength(8);
  });

  test("a stored entry that does not parse throws rather than admitting a run", async () => {
    const kv = fakeLedgerKv();
    kv.rows.set(KEY, { value: JSON.stringify({ day: "not-a-number" }), version: 1 });
    const ledger = createDurableExoLedger(kv);
    await expect(ledger.snapshot(OWNER, CAPABILITY, T0)).rejects.toThrow();
    await expect(ledger.recordStart(OWNER, CAPABILITY, "job-1", T0, GATE)).rejects.toThrow();
    // No ledger write, and every source lock taken before the throw is released.
    expect(kv.puts.filter((put) => put.key === KEY)).toHaveLength(0);
    const lockRows = [...kv.rows].filter(([key]) => key.includes("/source-lock/"));
    expect(lockRows.length).toBeGreaterThan(0);
    for (const [, row] of lockRows) expect(JSON.parse(row.value).holder).toBeUndefined();
  });

  test("attach and clear without an active run write nothing", async () => {
    const kv = fakeLedgerKv();
    const ledger = createDurableExoLedger(kv);
    await ledger.attach(OWNER, CAPABILITY, "job-x");
    expect(await ledger.clearActive(OWNER, CAPABILITY, "job-x")).toEqual([]);
    expect(kv.puts).toHaveLength(0);
  });

  test("clearActive releases the coalesced wakes once", async () => {
    const kv = fakeLedgerKv();
    const ledger = createDurableExoLedger(kv);
    await ledger.recordStart(OWNER, CAPABILITY, "job-run", T0, GATE);
    await ledger.attach(OWNER, CAPABILITY, "job-w1");
    await ledger.attach(OWNER, CAPABILITY, "job-w2");
    expect(await ledger.clearActive(OWNER, CAPABILITY, "job-run")).toEqual(["job-w1", "job-w2"]);
    expect(await ledger.clearActive(OWNER, CAPABILITY, "job-run")).toEqual([]);
    expect(await ledger.snapshot(OWNER, CAPABILITY, T0 + 1)).toEqual({ startsToday: 1, lastStartedAt: T0 });
  });

  test("sync-meetings and a single-source capability on one source are serialized in both orders", async () => {
    const meetingsFirst = createDurableExoLedger(fakeLedgerKv());
    expect(await meetingsFirst.recordStart(OWNER, "sync-meetings", "job-m", T0, GATE)).toEqual({ started: true });
    expect(await meetingsFirst.recordStart(OWNER, "sync-fireflies", "job-f", T0 + 1000, GATE)).toEqual({
      started: false,
      reason: "source",
      retryAfterMs: ACTIVE_RUN_TTL_MS - 1000,
    });
    expect(await meetingsFirst.recordStart(OWNER, "sync-google", "job-g", T0 + 1000, GATE)).toEqual({
      started: false,
      reason: "source",
      retryAfterMs: ACTIVE_RUN_TTL_MS - 1000,
    });

    const singleFirst = createDurableExoLedger(fakeLedgerKv());
    expect(await singleFirst.recordStart(OWNER, "sync-fireflies", "job-f", T0, GATE)).toEqual({ started: true });
    expect(await singleFirst.recordStart(OWNER, "sync-meetings", "job-m", T0 + 1000, GATE)).toEqual({
      started: false,
      reason: "source",
      retryAfterMs: ACTIVE_RUN_TTL_MS - 1000,
    });
  });

  test("a second start of the same capability is refused as active and leaves the first run's source locks held", async () => {
    const ledger = createDurableExoLedger(fakeLedgerKv());
    expect(await ledger.recordStart(OWNER, "sync-meetings", "job-m1", T0, GATE)).toEqual({ started: true });
    expect(await ledger.recordStart(OWNER, "sync-meetings", "job-m2", T0 + 1000, GATE)).toEqual({
      started: false,
      reason: "active",
      retryAfterMs: 0,
    });
    expect(await ledger.recordStart(OWNER, "sync-fireflies", "job-f", T0 + 2000, GATE)).toEqual({
      started: false,
      reason: "source",
      retryAfterMs: ACTIVE_RUN_TTL_MS - 2000,
    });
  });

  test("a refused multi-source start frees the sources it already took", async () => {
    const ledger = createDurableExoLedger(fakeLedgerKv());
    // sync-google holds the google source. sync-meetings takes fireflies, is refused on google, and must free fireflies.
    expect(await ledger.recordStart(OWNER, "sync-google", "job-g", T0, GATE)).toEqual({ started: true });
    expect(await ledger.recordStart(OWNER, "sync-meetings", "job-m", T0 + 1000, GATE)).toEqual({
      started: false,
      reason: "source",
      retryAfterMs: ACTIVE_RUN_TTL_MS - 1000,
    });
    expect(await ledger.recordStart(OWNER, "sync-fireflies", "job-f", T0 + 1000, GATE)).toEqual({ started: true });
  });

  test("a source lock is taken over only after the active-run TTL", async () => {
    const ledger = createDurableExoLedger(fakeLedgerKv());
    expect(await ledger.recordStart(OWNER, "sync-meetings", "job-m", T0, GATE)).toEqual({ started: true });
    expect(await ledger.recordStart(OWNER, "sync-fireflies", "job-f", T0 + ACTIVE_RUN_TTL_MS - 1, GATE)).toEqual({
      started: false,
      reason: "source",
      retryAfterMs: 1,
    });
    expect(await ledger.recordStart(OWNER, "sync-fireflies", "job-f", T0 + ACTIVE_RUN_TTL_MS, GATE)).toEqual({ started: true });
  });

  test("clearActive on the holder releases every source lock it held", async () => {
    const ledger = createDurableExoLedger(fakeLedgerKv());
    expect(await ledger.recordStart(OWNER, "sync-meetings", "job-m", T0, GATE)).toEqual({ started: true });
    await ledger.clearActive(OWNER, "sync-meetings", "job-m");
    expect(await ledger.recordStart(OWNER, "sync-fireflies", "job-f", T0 + 1000, GATE)).toEqual({ started: true });
    expect(await ledger.recordStart(OWNER, "sync-google", "job-g", T0 + 1000, GATE)).toEqual({ started: true });
  });
});
