import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { TinyCloudNode } from "@tinycloud/node-sdk";

import type {
  ContentSink,
  ContentUpsertInput,
  RetentionGuard,
} from "../services/fetch-worker.js";
import {
  CONTENT_MASTER_ENV,
  ContentStore,
  InMemoryContentBlobStore,
  KvContentBlobStore,
  createContentIndexDirectory,
  MAX_MEETING_CONTENT_BYTES,
  MAX_USER_CONTENT_BYTES,
  MAX_USER_MEETINGS,
  RETENTION_WINDOW_DAYS,
  validateContentCustodyConfig,
  _resetContentMasterCache,
  type ContentBlobStore,
  type SealedBlob,
} from "../services/content-store.js";
import {
  IngestInstanceGuard,
  IngestInstanceSupervisor,
  type InstanceLeaseRecord,
  type InstanceLeaseStore,
} from "../services/ingest-instance.js";
import {
  IngestRetentionSweeper,
  type RetentionSweepTarget,
} from "../services/ingest-retention.js";
import { _resetWebhookTokenState } from "../services/webhook-tokens.js";
// test-ruling: TC-2778 (Naomi: 14-day meeting-ID retention)

/**
 * W4 — the SERVER CONTENT STORE (backend-ingest plan §8.1 W4; §8.2 delta items 6, 8, 10;
 * §9 anti-patterns 4, 6).
 *
 * This file is the acceptance suite for the second half of the operator-authorized reversal
 * (plan §11): for a cohort address the backend now holds a copy of the meeting itself. Every
 * property that made the old "the backend never receives the meeting" invariant unnecessary is
 * re-established here as a test.
 *
 *  - `[delta-06]` — *ordering / out-of-order: upsert by `(source, source_id)`; summary before or
 *    without a transcript must not throw.* Partial rows are legal, both orders are green, and a
 *    reconcile of a partial row does not throw.
 *  - `[delta-08]` — *per-user backpressure + explicit overflow policy.* Per-meeting cap
 *    (reject-and-log), per-user meeting/byte caps (oldest-drop), every drop counted and logged
 *    with a hashed id and no content.
 *  - `[delta-10]` — *write-result checking / fail-closed.* A rejected Result, a throw, or a shape
 *    that is not the success shape are the same thing: NOT stored, and never reported stored.
 *  - `[delta-05]` — rows and their retention markers expire at 14 days. A provider replay after
 *    the boundary may create one new row; the browser deduplicates against the user's own space.
 */

const ORIGINAL_ENV = { ...process.env };

const SOURCE = "fireflies";
const ADDRESS_A = "0x7d033300000000000000000000000000000073f2";
const ADDRESS_B = "0xb1b1b10000000000000000000000000000001111";
const CONTENT_MASTER = "R29vZE1hc3RlckZvckNvbnRlbnRFbnZlbG9wZXNBQTA9";
const CREDENTIAL_MASTER = "Zk9pQ2xUb0FzRHZFcldxTnBZeEhtQjNnU2o1dDBjMD0=";
const WEBHOOK_MASTER = "3H8Qk0m2yq1sZ0VjK5xPwq0nA6oJ2bL9dR4tW7uY1cM=";
const LOG_SALT = "aQ2wS3eD4rF5tG6yH7uJ8iK9oL0pZ1xC2vB3nM4kJ5h=";

/** The strings that must never reach the substrate in the clear, a log line or an error. */
const TRANSCRIPT_TEXT = "so about the Q3 layoffs — Dana said the legal review is blocking";
const SUMMARY_TEXT = "Legal review blocks the Q3 plan; Dana owns the follow-up";
const TITLE_TEXT = "Q3 planning sync (confidential)";

const T0 = Date.parse("2026-08-10T12:00:00.000Z");
const DAY_MS = 86_400_000;

beforeEach(() => {
  _resetWebhookTokenState();
  _resetContentMasterCache();
  process.env.LOG_HASH_SALT = LOG_SALT;
  process.env[CONTENT_MASTER_ENV] = CONTENT_MASTER;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  _resetWebhookTokenState();
  _resetContentMasterCache();
});

function captureLogs(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;
  const record = (...args: unknown[]) => {
    lines.push(
      args.map((a) => (typeof a === "string" ? a : String(a))).join(" "),
    );
  };
  console.log = record;
  console.warn = record;
  console.error = record;
  return {
    lines,
    restore: () => {
      console.log = originalLog;
      console.warn = originalWarn;
      console.error = originalError;
    },
  };
}

interface Harness {
  store: ContentStore;
  blobs: InMemoryContentBlobStore;
  clock: { now: number };
}

function harness(
  options: ConstructorParameters<typeof ContentStore>[1] = {},
): Harness {
  const blobs = new InMemoryContentBlobStore();
  const clock = { now: T0 };
  const store = new ContentStore(blobs, {
    now: () => clock.now,
    master: () => CONTENT_MASTER,
    ...options,
  });
  return { store, blobs, clock };
}
test("archive upsert refuses writes when the continuity lease is not held", async () => {
  const blobs = new InMemoryContentBlobStore();
  const options = Object.assign(
    { now: () => T0, master: () => CONTENT_MASTER },
    { mutationGuard: { isHolder: () => false } },
  );
  const store = new ContentStore(blobs, options);

  const result = await store.upsert(upsertInput({ sourceId: "guarded-meeting" }));

  expect(result).toEqual({ ok: false, code: "content_store_failed" });
  expect(await blobs.readIndex(SOURCE, ADDRESS_A)).toBeNull();
  expect(await blobs.listContentIds(SOURCE, ADDRESS_A)).toEqual([]);
});
test("archive purge rechecks the continuity lease before deleting stored meetings", async () => {
  let holder = true;
  const blobs = new InMemoryContentBlobStore();
  const options = Object.assign(
    { now: () => T0, master: () => CONTENT_MASTER },
    { mutationGuard: { isHolder: () => holder } },
  );
  const store = new ContentStore(blobs, options);
  await store.upsert(upsertInput({ sourceId: "guarded-purge" }));

  holder = false;
  await expect(store.purge(SOURCE, ADDRESS_A)).rejects.toThrow(
    "content continuity lease is not held",
  );

  expect(await store.get(SOURCE, ADDRESS_A, "guarded-purge")).not.toBeNull();
});

function upsertInput(
  overrides: Partial<ContentUpsertInput> & { sourceId: string },
): ContentUpsertInput {
  return {
    source: SOURCE,
    address: ADDRESS_A,
    kind: "transcript",
    content: { sentences: [TRANSCRIPT_TEXT] },
    fetchedAt: new Date(T0).toISOString(),
    receivedAt: new Date(T0 - 1_000).toISOString(),
    ...overrides,
  };
}

// ── delta 6: ordering, partial rows, upsert identity ─────────────────

describe("W4 content store — ordering and partial rows", () => {
  test("[delta-06] a summary that arrives first is stored as a partial row and reads back", async () => {
    const { store } = harness();

    const result = await store.upsert(
      upsertInput({
        sourceId: "mtg-1",
        kind: "summary",
        title: TITLE_TEXT,
        ts: new Date(T0 - 60_000).toISOString(),
        content: { overview: SUMMARY_TEXT },
      }),
    );

    expect(result).toEqual({ ok: true, stored: "created" });

    const stored = await store.get(SOURCE, ADDRESS_A, "mtg-1");
    expect(stored?.content.summary).toEqual({ overview: SUMMARY_TEXT });
    // Partial is LEGAL, not an error state: no transcript half exists yet.
    expect(stored?.content.transcript).toBeUndefined();
    expect(stored?.meta.summaryStoredAt).toBe(new Date(T0).toISOString());
    expect(stored?.meta.transcriptStoredAt).toBeUndefined();
    expect(stored?.meta.title).toBe(TITLE_TEXT);
  });

  test("[delta-06] a transcript arriving later merges into the SAME (source, source_id) row", async () => {
    const { store, clock } = harness();

    await store.upsert(
      upsertInput({
        sourceId: "mtg-1",
        kind: "summary",
        content: { overview: SUMMARY_TEXT },
      }),
    );
    clock.now = T0 + 5_000;
    const merged = await store.upsert(
      upsertInput({
        sourceId: "mtg-1",
        kind: "transcript",
        title: TITLE_TEXT,
        content: { sentences: [TRANSCRIPT_TEXT] },
      }),
    );

    expect(merged).toEqual({ ok: true, stored: "merged" });

    const list = await store.list(SOURCE, ADDRESS_A);
    expect(list.length).toBe(1);

    const stored = await store.get(SOURCE, ADDRESS_A, "mtg-1");
    expect(stored?.content.summary).toEqual({ overview: SUMMARY_TEXT });
    expect(stored?.content.transcript).toEqual({ sentences: [TRANSCRIPT_TEXT] });
    expect(stored?.meta.summaryStoredAt).toBe(new Date(T0).toISOString());
    expect(stored?.meta.transcriptStoredAt).toBe(
      new Date(T0 + 5_000).toISOString(),
    );
  });

  test("[delta-06] the reverse order is equally green — transcript first, summary merged after", async () => {
    const { store, clock } = harness();

    await store.upsert(
      upsertInput({ sourceId: "mtg-2", content: { sentences: [TRANSCRIPT_TEXT] } }),
    );
    clock.now = T0 + 5_000;
    const merged = await store.upsert(
      upsertInput({
        sourceId: "mtg-2",
        kind: "summary",
        content: { overview: SUMMARY_TEXT },
      }),
    );

    expect(merged).toEqual({ ok: true, stored: "merged" });
    const stored = await store.get(SOURCE, ADDRESS_A, "mtg-2");
    expect(stored?.content.transcript).toEqual({ sentences: [TRANSCRIPT_TEXT] });
    expect(stored?.content.summary).toEqual({ overview: SUMMARY_TEXT });
    expect((await store.list(SOURCE, ADDRESS_A)).length).toBe(1);
  });

  test("[delta-06] a PARTIAL row reconciles without throwing", async () => {
    const { store, clock } = harness();

    await store.upsert(
      upsertInput({
        sourceId: "mtg-3",
        kind: "summary",
        content: { overview: SUMMARY_TEXT },
      }),
    );
    clock.now = T0 + 1_000;

    expect(await store.markReconciled(SOURCE, ADDRESS_A, "mtg-3")).toBe(true);
    const stored = await store.get(SOURCE, ADDRESS_A, "mtg-3");
    expect(stored?.meta.reconciledAt).toBe(new Date(T0 + 1_000).toISOString());
    // Still partial, still readable — reconcile is a stamp, not a state transition that
    // completes the row.
    expect(stored?.content.transcript).toBeUndefined();
    expect(stored?.content.summary).toEqual({ overview: SUMMARY_TEXT });
  });

  test("[delta-06] content merged onto a reconciled row clears reconciledAt", async () => {
    const { store, clock } = harness();

    await store.upsert(
      upsertInput({
        sourceId: "mtg-4",
        kind: "summary",
        content: { overview: SUMMARY_TEXT },
      }),
    );
    await store.markReconciled(SOURCE, ADDRESS_A, "mtg-4");
    clock.now = T0 + 2_000;
    await store.upsert(
      upsertInput({ sourceId: "mtg-4", content: { sentences: [TRANSCRIPT_TEXT] } }),
    );

    // The user-space copy is now stale, so W6 must reconcile it again. Leaving the stamp would
    // strand the transcript half on the server for a browser that already ticked this meeting off.
    const stored = await store.get(SOURCE, ADDRESS_A, "mtg-4");
    expect(stored?.meta.reconciledAt).toBeUndefined();
  });

  test("[delta-06] a replayed identical delivery refreshes the row instead of duplicating it", async () => {
    const { store, clock } = harness();

    const input = upsertInput({ sourceId: "mtg-5" });
    await store.upsert(input);
    clock.now = T0 + 3_000;
    const again = await store.upsert(input);

    expect(again).toEqual({ ok: true, stored: "merged" });
    const list = await store.list(SOURCE, ADDRESS_A);
    expect(list.length).toBe(1);
    expect(list[0]?.updatedAt).toBe(new Date(T0 + 3_000).toISOString());
    // `storedAt` is the row's birth and does not move on a replay.
    expect(list[0]?.storedAt).toBe(new Date(T0).toISOString());
  });

  test("[delta-06] upsert identity is scoped by address: one source_id, two tenants, two rows", async () => {
    const { store } = harness();

    await store.upsert(upsertInput({ sourceId: "shared-id" }));
    await store.upsert(
      upsertInput({
        sourceId: "shared-id",
        address: ADDRESS_B,
        content: { sentences: ["b's meeting"] },
      }),
    );

    const a = await store.get(SOURCE, ADDRESS_A, "shared-id");
    const b = await store.get(SOURCE, ADDRESS_B, "shared-id");
    expect(a?.content.transcript).toEqual({ sentences: [TRANSCRIPT_TEXT] });
    expect(b?.content.transcript).toEqual({ sentences: ["b's meeting"] });
    expect((await store.list(SOURCE, ADDRESS_A)).length).toBe(1);
    expect((await store.list(SOURCE, ADDRESS_B)).length).toBe(1);
  });

  test("[delta-06] the store satisfies the worker's ContentSink and RetentionGuard ports", () => {
    const { store } = harness();
    const sink: ContentSink = store;
    const guard: RetentionGuard = store;
    expect(typeof sink.upsert).toBe("function");
    expect(typeof guard.tombstoned).toBe("function");
  });
});

// ── delta 8: caps and overflow policy ────────────────────────────────

describe("W4 content store — caps and overflow policy", () => {
  test("[delta-08] the shipped caps are the plan's proposal: 2 MB / 500 meetings / 200 MB", () => {
    expect(MAX_MEETING_CONTENT_BYTES).toBe(2 * 1024 * 1024);
    expect(MAX_USER_MEETINGS).toBe(500);
    expect(MAX_USER_CONTENT_BYTES).toBe(200 * 1024 * 1024);
  });

  test("[delta-08] a meeting over the per-meeting cap is rejected and logged, never truncated", async () => {
    const { store, blobs } = harness({ maxMeetingBytes: 512 });
    const capture = captureLogs();
    let result: Awaited<ReturnType<ContentStore["upsert"]>>;
    try {
      result = await store.upsert(
        upsertInput({
          sourceId: "mtg-big",
          title: TITLE_TEXT,
          content: { sentences: [TRANSCRIPT_TEXT.repeat(40)] },
        }),
      );
    } finally {
      capture.restore();
    }

    expect(result).toEqual({ ok: false, code: "content_too_large" });
    // Rejected means NOTHING landed — not a truncated row, not an empty one.
    expect(await store.get(SOURCE, ADDRESS_A, "mtg-big")).toBeNull();
    expect((await store.list(SOURCE, ADDRESS_A)).length).toBe(0);
    expect(store.stats().rejectedTooLarge).toBe(1);

    const dropLine = capture.lines.find((line) => line.includes("content_too_large"));
    expect(dropLine).toBeTruthy();
    expect(dropLine).not.toContain("mtg-big");
    expect(dropLine).not.toContain(ADDRESS_A);
    expect(dropLine).not.toContain(TITLE_TEXT);
    expect(dropLine).not.toContain(TRANSCRIPT_TEXT.slice(0, 24));
    expect(blobs.dump()).not.toContain(TRANSCRIPT_TEXT.slice(0, 24));
  });

  test("[delta-08] past the per-user meeting cap the OLDEST is dropped, counted and logged", async () => {
    const { store, clock, blobs } = harness({ maxUserMeetings: 3 });
    const capture = captureLogs();
    try {
      for (let i = 0; i < 4; i += 1) {
        clock.now = T0 + i * 1_000;
        await store.upsert(
          upsertInput({
            sourceId: `mtg-cap-${i}`,
            ts: new Date(T0 + i * 1_000).toISOString(),
          }),
        );
      }
    } finally {
      capture.restore();
    }

    const ids = (await store.list(SOURCE, ADDRESS_A)).map((m) => m.sourceId);
    expect(ids.length).toBe(3);
    expect(ids).not.toContain("mtg-cap-0");
    expect(ids).toContain("mtg-cap-3");
    expect(store.stats().droppedOverflow).toBe(1);
    expect(await blobs.read(SOURCE, ADDRESS_A, "mtg-cap-0")).toBeNull();

    const dropLine = capture.lines.find((line) => line.includes("reason=user_meeting_cap"));
    expect(dropLine).toBeTruthy();
    expect(dropLine).not.toContain("mtg-cap-0");
    expect(dropLine).not.toContain(ADDRESS_A);
  });

  test("[delta-08] overflow eviction is deliberately NON-permanent: an evicted id carries no tombstone", async () => {
    // Retention markers expire with their rows at 14 days; the purge ledger has its own bounded
    // clock. A cap eviction says only "this did not fit today", so a later delivery for the same
    // meeting may re-store it and evict the current oldest.
    const { store, clock } = harness({ maxUserMeetings: 2 });
    for (let i = 0; i < 3; i += 1) {
      clock.now = T0 + i * 1_000;
      await store.upsert(
        upsertInput({
          sourceId: `mtg-evict-${i}`,
          ts: new Date(T0 + i * 1_000).toISOString(),
        }),
      );
    }
    expect(store.stats().droppedOverflow).toBe(1);
    expect(
      await store.tombstoned({
        source: SOURCE,
        address: ADDRESS_A,
        meetingId: "mtg-evict-0",
        kind: "transcript",
      }),
    ).toBe(false);

    // A replay of the evicted meeting re-stores it — counted, logged, and NOT a refusal.
    clock.now = T0 + 4_000;
    const replay = await store.upsert(
      upsertInput({
        sourceId: "mtg-evict-0",
        ts: new Date(T0).toISOString(),
      }),
    );
    expect(replay).toEqual({ ok: true, stored: "created" });
    expect(store.stats().tombstoneRefusals).toBe(0);
    expect(store.stats().droppedOverflow).toBe(2);
  });

  test("[delta-08] past the per-user BYTE cap the oldest are dropped until the new row fits", async () => {
    const { store, clock } = harness({ maxUserBytes: 1_200 });
    const body = { sentences: ["x".repeat(400)] };

    for (let i = 0; i < 4; i += 1) {
      clock.now = T0 + i * 1_000;
      const result = await store.upsert(
        upsertInput({
          sourceId: `mtg-bytes-${i}`,
          ts: new Date(T0 + i * 1_000).toISOString(),
          content: body,
        }),
      );
      expect(result).toEqual({ ok: true, stored: "created" });
    }

    const metas = await store.list(SOURCE, ADDRESS_A);
    const total = metas.reduce((sum, m) => sum + m.sizeBytes, 0);
    expect(total).toBeLessThanOrEqual(1_200);
    expect(metas.map((m) => m.sourceId)).toContain("mtg-bytes-3");
    expect(metas.map((m) => m.sourceId)).not.toContain("mtg-bytes-0");
    expect(store.stats().droppedOverflow).toBeGreaterThan(0);
  });

  test("[delta-08] a MERGE into an existing row does not consume a slot in the meeting cap", async () => {
    const { store, clock } = harness({ maxUserMeetings: 2 });

    await store.upsert(upsertInput({ sourceId: "mtg-m1" }));
    clock.now = T0 + 1_000;
    await store.upsert(upsertInput({ sourceId: "mtg-m2" }));
    clock.now = T0 + 2_000;
    await store.upsert(
      upsertInput({
        sourceId: "mtg-m1",
        kind: "summary",
        content: { overview: SUMMARY_TEXT },
      }),
    );

    const ids = (await store.list(SOURCE, ADDRESS_A)).map((m) => m.sourceId);
    expect(ids.sort()).toEqual(["mtg-m1", "mtg-m2"]);
    expect(store.stats().droppedOverflow).toBe(0);
  });

  test("[delta-08] one user's overflow never evicts another user's meetings", async () => {
    const { store, clock } = harness({ maxUserMeetings: 2 });

    await store.upsert(upsertInput({ sourceId: "b-1", address: ADDRESS_B }));
    for (let i = 0; i < 3; i += 1) {
      clock.now = T0 + i * 1_000;
      await store.upsert(upsertInput({ sourceId: `a-${i}` }));
    }

    expect((await store.list(SOURCE, ADDRESS_B)).map((m) => m.sourceId)).toEqual([
      "b-1",
    ]);
    expect((await store.list(SOURCE, ADDRESS_A)).length).toBe(2);
  });
});

// ── delta 10: write-result checking / fail-closed ────────────────────

describe("W4 content store — fail closed", () => {
  /** A blob store whose chosen method throws, so a failure cannot be mistaken for a success. */
  class FailingBlobStore implements ContentBlobStore {
    constructor(
      private readonly inner: InMemoryContentBlobStore,
      private readonly failOn: "write" | "writeIndex" | "read" | "readIndex",
    ) {}

    readIndex(source: string, address: string): Promise<SealedBlob | null> {
      if (this.failOn === "readIndex") throw new Error("substrate read failed");
      return this.inner.readIndex(source, address);
    }

    writeIndex(source: string, address: string, blob: SealedBlob): Promise<void> {
      if (this.failOn === "writeIndex") throw new Error("substrate write failed");
      return this.inner.writeIndex(source, address, blob);
    }
    removeIndex(source: string, address: string): Promise<void> {
      return this.inner.removeIndex(source, address);
    }

    read(
      source: string,
      address: string,
      sourceId: string,
    ): Promise<SealedBlob | null> {
      if (this.failOn === "read") throw new Error("substrate read failed");
      return this.inner.read(source, address, sourceId);
    }

    write(
      source: string,
      address: string,
      sourceId: string,
      blob: SealedBlob,
    ): Promise<void> {
      if (this.failOn === "write") throw new Error("substrate write failed");
      return this.inner.write(source, address, sourceId, blob);
    }

    remove(source: string, address: string, sourceId: string): Promise<void> {
      return this.inner.remove(source, address, sourceId);
    }

    removeAll(source: string, address: string): Promise<void> {
      return this.inner.removeAll(source, address);
    }
  }

  test("[delta-10] a content write that THROWS is a failure — upsert answers {ok:false} and stores nothing", async () => {
    const inner = new InMemoryContentBlobStore();
    const store = new ContentStore(new FailingBlobStore(inner, "write"), {
      now: () => T0,
      master: () => CONTENT_MASTER,
    });

    const result = await store.upsert(upsertInput({ sourceId: "mtg-fail" }));

    expect(result.ok).toBe(false);
    expect(store.stats().writeFailures).toBe(1);
    expect(inner.dump()).not.toContain("mtg-fail");
  });

  test("[delta-10] an INDEX write that throws is the same failure — nothing is reported stored", async () => {
    const inner = new InMemoryContentBlobStore();
    const store = new ContentStore(new FailingBlobStore(inner, "writeIndex"), {
      now: () => T0,
      master: () => CONTENT_MASTER,
    });

    const result = await store.upsert(upsertInput({ sourceId: "mtg-fail-ix" }));

    expect(result.ok).toBe(false);
    expect(store.stats().writeFailures).toBe(1);
  });

  test("[delta-10] an unreadable index is a failure, never an empty archive", async () => {
    const inner = new InMemoryContentBlobStore();
    const store = new ContentStore(new FailingBlobStore(inner, "readIndex"), {
      now: () => T0,
      master: () => CONTENT_MASTER,
    });

    // Reading a failed index as "this user has no meetings" would drop every cap, let the
    // retention sweep report nothing to sweep, and let a replay re-store swept content.
    const result = await store.upsert(upsertInput({ sourceId: "mtg-x" }));
    expect(result.ok).toBe(false);
    await expect(store.list(SOURCE, ADDRESS_A)).rejects.toThrow();
  });

  test("a fingerprint-only mismatch refuses an otherwise valid sealed index", async () => {
    const { store, blobs } = harness();
    await store.upsert(upsertInput({ sourceId: "mtg-fingerprint" }));
    const original = await blobs.readIndex(SOURCE, ADDRESS_A);
    expect(original).not.toBeNull();
    if (original === null) return;

    // Keep the ciphertext and wrapped key intact so only the fingerprint check can reject it.
    await blobs.writeIndex(SOURCE, ADDRESS_A, {
      ...original,
      keyFingerprint: "0".repeat(64),
    });
    const storeWithMismatchedFingerprint = new ContentStore(blobs, {
      now: () => T0,
      master: () => CONTENT_MASTER,
    });

    await expect(
      storeWithMismatchedFingerprint.list(SOURCE, ADDRESS_A),
    ).rejects.toThrow("content index is unreadable");
    expect(
      await storeWithMismatchedFingerprint.sweepRetention({
        source: SOURCE,
        address: ADDRESS_A,
      }),
    ).toMatchObject({ swept: 0, unreadableIndex: true });
    expect(await blobs.read(SOURCE, ADDRESS_A, "mtg-fingerprint")).not.toBeNull();
  });

  test("[delta-10] the success arm is a LITERAL {ok:true} with a stored disposition", async () => {
    const { store } = harness();
    const result = await store.upsert(upsertInput({ sourceId: "mtg-shape" }));

    // Silent success is unrepresentable: the only success shape carries which disposition
    // happened, and the worker checks that literal rather than truthiness.
    expect(result).toEqual({ ok: true, stored: "created" });
    expect(Object.keys(result).sort()).toEqual(["ok", "stored"]);
  });

  test("[delta-10] markReconciled never reports success for a write that failed", async () => {
    const inner = new InMemoryContentBlobStore();
    const good = new ContentStore(inner, {
      now: () => T0,
      master: () => CONTENT_MASTER,
    });
    await good.upsert(upsertInput({ sourceId: "mtg-rec" }));

    // Blob-first / index-second: the first of the two writes is `writeMeeting`, so a substrate
    // failure there throws BEFORE any index mutation. The stamp lands in neither place.
    const failing = new ContentStore(new FailingBlobStore(inner, "write"), {
      now: () => T0,
      master: () => CONTENT_MASTER,
    });
    await expect(
      failing.markReconciled(SOURCE, ADDRESS_A, "mtg-rec"),
    ).rejects.toThrow();
    // And the stamp did NOT land — in the blob OR the index. A browser that saw a failure must
    // re-reconcile.
    expect((await good.get(SOURCE, ADDRESS_A, "mtg-rec"))?.meta.reconciledAt).toBeUndefined();
    expect(
      (await good.list(SOURCE, ADDRESS_A)).find((m) => m.sourceId === "mtg-rec")
        ?.reconciledAt,
    ).toBeUndefined();
  });

  test("[delta-10] a failed blob write keeps the row in the ?reconciled=false discovery queue and the next pass succeeds", async () => {
    // Blob FIRST, index SECOND: a partial failure between them must leave `list()` reporting the
    // row as unreconciled so W6's `?reconciled=false` filter keeps returning it and the browser
    // retries. The reverse ordering (index first) would stamp the row visible-to-list() but not
    // to get(), and W6 would drop it from the retry set — the exact regression the audit named.
    const inner = new InMemoryContentBlobStore();
    const good = new ContentStore(inner, {
      now: () => T0,
      master: () => CONTENT_MASTER,
    });
    await good.upsert(upsertInput({ sourceId: "mtg-retry" }));

    let failNextWrite = true;
    class FlakyWriteBlobStore implements ContentBlobStore {
      constructor(private readonly delegate: InMemoryContentBlobStore) {}
      readIndex(source: string, address: string) {
        return this.delegate.readIndex(source, address);
      }
      writeIndex(source: string, address: string, blob: SealedBlob) {
        return this.delegate.writeIndex(source, address, blob);
      }
      removeIndex(source: string, address: string) {
        return this.delegate.removeIndex(source, address);
      }
      readKeyFailureSince(source: string, address: string) {
        return this.delegate.readKeyFailureSince(source, address);
      }
      writeKeyFailureSince(
        source: string,
        address: string,
        firstFailureAt: string,
      ) {
        return this.delegate.writeKeyFailureSince(
          source,
          address,
          firstFailureAt,
        );
      }
      clearKeyFailureSince(source: string, address: string) {
        return this.delegate.clearKeyFailureSince(source, address);
      }
      read(source: string, address: string, sourceId: string) {
        return this.delegate.read(source, address, sourceId);
      }
      write(source: string, address: string, sourceId: string, blob: SealedBlob) {
        if (failNextWrite) {
          failNextWrite = false;
          return Promise.reject(new Error("substrate write failed"));
        }
        return this.delegate.write(source, address, sourceId, blob);
      }
      remove(source: string, address: string, sourceId: string) {
        return this.delegate.remove(source, address, sourceId);
      }
      removeAll(source: string, address: string) {
        return this.delegate.removeAll(source, address);
      }
    }

    const flaky = new ContentStore(new FlakyWriteBlobStore(inner), {
      now: () => T0,
      master: () => CONTENT_MASTER,
    });
    await expect(
      flaky.markReconciled(SOURCE, ADDRESS_A, "mtg-retry"),
    ).rejects.toThrow();

    // Still unreconciled in the index — the shape W6's ?reconciled=false filter reads.
    const listedAfterFailure = await flaky.list(SOURCE, ADDRESS_A);
    expect(listedAfterFailure.find((m) => m.sourceId === "mtg-retry")?.reconciledAt).toBeUndefined();

    // The next pass succeeds and NOW the stamp is durable everywhere.
    expect(await flaky.markReconciled(SOURCE, ADDRESS_A, "mtg-retry")).toBe(true);
    const listedAfterRetry = await flaky.list(SOURCE, ADDRESS_A);
    expect(listedAfterRetry.find((m) => m.sourceId === "mtg-retry")?.reconciledAt).toBe(
      new Date(T0).toISOString(),
    );
    expect(
      (await flaky.get(SOURCE, ADDRESS_A, "mtg-retry"))?.meta.reconciledAt,
    ).toBe(new Date(T0).toISOString());
  });
  test("a failed final index write cannot leave an overwritten reconciled blob deletable", async () => {
    class FailIndexAfterBlobWrite extends InMemoryContentBlobStore {
      private armed = false;
      private wroteBlob = false;

      arm(): void {
        this.armed = true;
      }

      override async write(
        source: string,
        address: string,
        sourceId: string,
        blob: SealedBlob,
      ): Promise<void> {
        await super.write(source, address, sourceId, blob);
        if (this.armed) this.wroteBlob = true;
      }

      override async writeIndex(
        source: string,
        address: string,
        blob: SealedBlob,
      ): Promise<void> {
        if (this.armed && this.wroteBlob) {
          throw new Error("final index write failed");
        }
        await super.writeIndex(source, address, blob);
      }
    }

    const blobs = new FailIndexAfterBlobWrite();
    const store = new ContentStore(blobs, {
      now: () => T0,
      master: () => CONTENT_MASTER,
    });
    await store.upsert(upsertInput({ sourceId: "mtg-reconcile-failure" }));
    await store.markReconciled(SOURCE, ADDRESS_A, "mtg-reconcile-failure");
    blobs.arm();

    const result = await store.upsert(
      upsertInput({
        sourceId: "mtg-reconcile-failure",
        kind: "summary",
        content: { overview: "new summary awaiting reconciliation" },
      }),
    );

    expect(result).toEqual({ ok: false, code: "content_store_failed" });
    const listed = await store.list(SOURCE, ADDRESS_A);
    expect(
      listed.find((meta) => meta.sourceId === "mtg-reconcile-failure")
        ?.reconciledAt,
    ).toBeUndefined();
    expect(
      (await store.get(SOURCE, ADDRESS_A, "mtg-reconcile-failure"))?.content
        .summary,
    ).toEqual({ overview: "new summary awaiting reconciliation" });
  });


  test("[delta-10] a KV put that RESOLVES {ok:false} is a failure, not a silent success", async () => {
    const node = new FakeNode();
    node.overridePutResult = { ok: false, error: "durable write rejected" };
    const store = new ContentStore(
      new KvContentBlobStore(node as unknown as TinyCloudNode),
      { now: () => T0, master: () => CONTENT_MASTER },
    );

    const result = await store.upsert(upsertInput({ sourceId: "mtg-kv" }));
    expect(result.ok).toBe(false);
    expect(node.store.size).toBe(0);
  });
  test("the KV adapter persists and clears the first-failure alert marker", async () => {
    const node = new FakeNode();
    const blobs = new KvContentBlobStore(node as unknown as TinyCloudNode);
    const failedAt = new Date(T0).toISOString();

    await blobs.writeKeyFailureSince(SOURCE, ADDRESS_A, failedAt);
    expect(
      node.store.get(`connector-content-key-failure/${SOURCE}/${ADDRESS_A}`),
    ).toEqual({ firstFailureAt: failedAt });
    expect(await blobs.readKeyFailureSince(SOURCE, ADDRESS_A)).toBe(failedAt);

    await blobs.clearKeyFailureSince(SOURCE, ADDRESS_A);
    expect(await blobs.readKeyFailureSince(SOURCE, ADDRESS_A)).toBeNull();
  });

  test("[delta-10] a KV read that resolves {ok:false} never reads as an empty archive", async () => {
    const node = new FakeNode();
    node.overrideGetResult = { ok: false, error: "durable read rejected" };
    const store = new ContentStore(
      new KvContentBlobStore(node as unknown as TinyCloudNode),
      { now: () => T0, master: () => CONTENT_MASTER },
    );

    await expect(store.list(SOURCE, ADDRESS_A)).rejects.toThrow();
  });

  test("[delta-10] the KV adapter writes content under PER-ITEM keys, never one array", async () => {
    const node = new FakeNode();
    const store = new ContentStore(
      new KvContentBlobStore(node as unknown as TinyCloudNode),
      { now: () => T0, master: () => CONTENT_MASTER },
    );

    await store.upsert(upsertInput({ sourceId: "mtg-k1" }));
    await store.upsert(upsertInput({ sourceId: "mtg-k2" }));

    // Plan §7: "KV RMW arrays are not a content store — per-item keys required for content."
    const contentKeys = [...node.store.keys()].filter((k) =>
      k.startsWith("connector-content/"),
    );
    expect(contentKeys.length).toBe(2);
    expect(new Set(contentKeys).size).toBe(2);
  });
});

// ── delta 5 (W4's half): retention sweep + retention tombstones ──────

describe("W4 content store — retention", () => {
  test("the retention window is 14 days", () => {
    expect(RETENTION_WINDOW_DAYS).toBe(14);
  });


  test("[delta-05] storedAt expires content even when provider time is future", async () => {
    const { store, clock } = harness();

    clock.now = T0 - 15 * DAY_MS;
    await store.upsert(
      upsertInput({
        sourceId: "mtg-old",
        ts: new Date(T0 + 100 * DAY_MS).toISOString(),
      }),
    );
    clock.now = T0 + 1_000;
    const swept = await store.sweepRetention({ source: SOURCE, address: ADDRESS_A });

    expect(swept.swept).toBe(1);
    expect(await store.get(SOURCE, ADDRESS_A, "mtg-old")).toBeNull();
    expect((await store.list(SOURCE, ADDRESS_A)).length).toBe(0);
    expect(
      await store.tombstoned({
        source: SOURCE,
        address: ADDRESS_A,
        meetingId: "mtg-old",
        kind: "transcript",
      }),
    ).toBe(true);
  });


  test("[delta-05] content INSIDE the window survives the sweep, reconciled or not", async () => {
    const { store, clock } = harness();

    await store.upsert(
      upsertInput({
        sourceId: "mtg-fresh",
        ts: new Date(T0 - 3 * DAY_MS).toISOString(),
      }),
    );
    await store.upsert(
      upsertInput({
        sourceId: "mtg-reconciled",
        ts: new Date(T0 - 4 * DAY_MS).toISOString(),
      }),
    );
    await store.markReconciled(SOURCE, ADDRESS_A, "mtg-reconciled");

    clock.now = T0 + 1_000;
    const swept = await store.sweepRetention({ source: SOURCE, address: ADDRESS_A });

    // D2a: retention is INDEPENDENT of reconcile status — a second device still has to be able
    // to read a meeting the first device already wrote into the user's own space.
    expect(swept.swept).toBe(0);
    expect((await store.list(SOURCE, ADDRESS_A)).length).toBe(2);
  });

  test("[delta-05] a meeting with no provider timestamp ages out on when it was STORED", async () => {
    const { store, clock } = harness();

    await store.upsert(upsertInput({ sourceId: "mtg-nots" }));
    clock.now = T0 + 100 * DAY_MS;
    const swept = await store.sweepRetention({ source: SOURCE, address: ADDRESS_A });

    expect(swept.swept).toBe(1);
    expect(await store.get(SOURCE, ADDRESS_A, "mtg-nots")).toBeNull();
  });


  test("[delta-05] a future-dated provider ts still ages out — the window is a bound, not a suggestion", async () => {
    // The opposite half of the clamp: without it, `ts` far in the future never crosses the
    // cutoff, so the row is immune to retention forever. Clamp to `storedAt` and it ages out
    // like anything else.
    const { store, clock } = harness();

    await store.upsert(
      upsertInput({
        sourceId: "mtg-future",
        ts: new Date(T0 + 1_000 * 365 * DAY_MS).toISOString(),
      }),
    );
    clock.now = T0 + 100 * DAY_MS;
    const swept = await store.sweepRetention({ source: SOURCE, address: ADDRESS_A });

    expect(swept.swept).toBe(1);
    expect(await store.get(SOURCE, ADDRESS_A, "mtg-future")).toBeNull();
  });


  test("a recently merged blob is removed at the original 14-day expiry", async () => {
    const { store, blobs, clock } = harness();
    await store.upsert(upsertInput({ sourceId: "mtg-merged-blob" }));

    clock.now = T0 + 10 * DAY_MS;
    await store.upsert(
      upsertInput({
        sourceId: "mtg-merged-blob",
        kind: "summary",
        content: { overview: SUMMARY_TEXT },
      }),
    );

    clock.now = T0 + 15 * DAY_MS + 2 * 60 * 60_000;
    await store.sweepRetention({ source: SOURCE, address: ADDRESS_A });

    expect(await store.list(SOURCE, ADDRESS_A)).toEqual([]);
    expect(await blobs.read(SOURCE, ADDRESS_A, "mtg-merged-blob")).toBeNull();
  });


  test("an unreadable index younger than its cutoff is retained", async () => {
    const { store, blobs, clock } = harness();
    await store.upsert(upsertInput({ sourceId: "mtg-aged-blob-young-index" }));
    clock.now = T0 + 13 * DAY_MS;
    await store.upsert(upsertInput({ sourceId: "mtg-young-blob-young-index" }));

    const index = await blobs.readIndex(SOURCE, ADDRESS_A);
    expect(index).not.toBeNull();
    if (index !== null) {
      await blobs.writeIndex(SOURCE, ADDRESS_A, {
        ...index,
        updatedAt: new Date(T0 + 13 * DAY_MS).toISOString(),
      });
    }
    const wrongKeyStore = new ContentStore(blobs, {
      now: () => clock.now,
      master: () => CREDENTIAL_MASTER,
    });
    clock.now = T0 + 15 * DAY_MS;
    await wrongKeyStore.sweepRetention({
      source: SOURCE,
      address: ADDRESS_A,
    });

    expect(
      await blobs.read(SOURCE, ADDRESS_A, "mtg-aged-blob-young-index"),
    ).not.toBeNull();
    expect(
      await blobs.read(SOURCE, ADDRESS_A, "mtg-young-blob-young-index"),
    ).not.toBeNull();
    expect(await blobs.readIndex(SOURCE, ADDRESS_A)).not.toBeNull();
  });

  test("an unreadable index past its cutoff retains its index and every blob", async () => {
    const { store, blobs, clock } = harness();
    await store.upsert(upsertInput({ sourceId: "mtg-index-old" }));
    await blobs.write(SOURCE, ADDRESS_A, "mtg-young-blob-old-index", {
      ciphertext: "ciphertext",
      wrappedDEK: "wrapped-key",
      storedAt: new Date(T0 + 13 * DAY_MS).toISOString(),
      updatedAt: new Date(T0 + 13 * DAY_MS).toISOString(),
    });
    const index = await blobs.readIndex(SOURCE, ADDRESS_A);
    expect(index).not.toBeNull();
    if (index !== null) {
      await blobs.writeIndex(SOURCE, ADDRESS_A, {
        ...index,
        updatedAt: new Date(T0).toISOString(),
      });
    }
    const wrongKeyStore = new ContentStore(blobs, {
      now: () => clock.now,
      master: () => CREDENTIAL_MASTER,
    });
    clock.now = T0 + 15 * DAY_MS;

    await wrongKeyStore.sweepRetention({
      source: SOURCE,
      address: ADDRESS_A,
    });

    expect(await blobs.readIndex(SOURCE, ADDRESS_A)).not.toBeNull();
    expect(
      await blobs.read(SOURCE, ADDRESS_A, "mtg-index-old"),
    ).not.toBeNull();
    expect(
      await blobs.read(SOURCE, ADDRESS_A, "mtg-young-blob-old-index"),
    ).not.toBeNull();
  });
  test("a missing content master refuses retention deletion", async () => {
    const blobs = new InMemoryContentBlobStore();
    const clock = { now: T0 };
    let unavailable = false;
    const store = new ContentStore(blobs, {
      now: () => clock.now,
      master: () => {
        if (unavailable) throw new Error("master unavailable");
        return CONTENT_MASTER;
      },
    });
    await store.upsert(upsertInput({ sourceId: "mtg-master-old" }));
    clock.now = T0 + 13 * DAY_MS;
    await store.upsert(upsertInput({ sourceId: "mtg-master-young" }));

    const logs = captureLogs();
    try {
      unavailable = true;
      clock.now = T0 + 15 * DAY_MS;
      expect(
        await store.sweepRetention({ source: SOURCE, address: ADDRESS_A }),
      ).toMatchObject({ swept: 0, unreadableIndex: true });
      expect(await blobs.read(SOURCE, ADDRESS_A, "mtg-master-old")).not.toBeNull();
      expect(await blobs.read(SOURCE, ADDRESS_A, "mtg-master-young")).not.toBeNull();
      expect(
        logs.lines.filter((line) => line.includes("first_failure=true")),
      ).toHaveLength(1);
      expect(logs.lines.some((line) => line.includes("alert=true"))).toBe(true);
      expect(logs.lines.join(" ")).not.toContain(ADDRESS_A);
    } finally {
      logs.restore();
    }
  });
  test("purge refuses to delete when the content index is unreadable", async () => {
    const { store, blobs, clock } = harness();
    await store.upsert(upsertInput({ sourceId: "mtg-purge-unreadable" }));
    const wrongKeyStore = new ContentStore(blobs, {
      now: () => clock.now,
      master: () => CREDENTIAL_MASTER,
    });

    await expect(
      wrongKeyStore.purge(SOURCE, ADDRESS_A),
    ).rejects.toThrow("content index is unreadable");
    expect(await blobs.readIndex(SOURCE, ADDRESS_A)).not.toBeNull();
    expect(
      await blobs.read(SOURCE, ADDRESS_A, "mtg-purge-unreadable"),
    ).not.toBeNull();
  });
  test("purge refuses orphan deletion when the content master is unavailable", async () => {
    const blobs = new InMemoryContentBlobStore();
    await blobs.write(SOURCE, ADDRESS_A, "mtg-orphan-without-master", {
      ciphertext: "ciphertext",
      wrappedDEK: "wrapped-key",
      storedAt: new Date(T0).toISOString(),
      updatedAt: new Date(T0).toISOString(),
    });
    const store = new ContentStore(blobs, {
      now: () => T0,
      master: () => {
        throw new Error("master unavailable");
      },
    });

    await expect(store.purge(SOURCE, ADDRESS_A)).rejects.toThrow(
      "content master is unavailable",
    );
    expect(
      await blobs.read(SOURCE, ADDRESS_A, "mtg-orphan-without-master"),
    ).not.toBeNull();
  });

  test("the tombstone cap evicts oldest markers and retains the newest", async () => {
    const { store, clock } = harness({ maxUserTombstones: 2 });
    const internals = store as unknown as {
      writeIndex(
        source: string,
        address: string,
        index: unknown,
      ): Promise<void>;
    };
    await internals.writeIndex(SOURCE, ADDRESS_A, {
      meetings: [],
      tombstones: [0, 1, 2].map((i) => ({
        sourceId: `mtg-tombstone-${i}`,
        sweptAt: new Date(T0 + i * 1_000).toISOString(),
        expiresAt: new Date(T0 + 30 * DAY_MS).toISOString(),
      })),
    });

    clock.now = T0 + DAY_MS;
    await store.sweepRetention({ source: SOURCE, address: ADDRESS_A });

    expect(
      await store.tombstoned({
        source: SOURCE,
        address: ADDRESS_A,
        meetingId: "mtg-tombstone-0",
      }),
    ).toBe(false);
    expect(
      await store.tombstoned({
        source: SOURCE,
        address: ADDRESS_A,
        meetingId: "mtg-tombstone-1",
      }),
    ).toBe(true);
    expect(
      await store.tombstoned({
        source: SOURCE,
        address: ADDRESS_A,
        meetingId: "mtg-tombstone-2",
      }),
    ).toBe(true);
  });

  test("[delta-05] a legacy tombstone without an expiry is not kept", async () => {
    const { store } = harness();
    const seedIndex = store as unknown as {
      writeIndex(source: string, address: string, index: unknown): Promise<void>;
    };
    await seedIndex.writeIndex(SOURCE, ADDRESS_A, {
      meetings: [],
      tombstones: [{
        sourceId: "mtg-legacy-tombstone",
        sweptAt: new Date(T0).toISOString(),
      }],
    });

    expect(
      await store.tombstoned({
        source: SOURCE,
        address: ADDRESS_A,
        meetingId: "mtg-legacy-tombstone",
      }),
    ).toBe(false);
  });

  test("[delta-05] the sweep touches ONLY the address it was asked for", async () => {
    const { store, clock } = harness();
    const old = new Date(T0 - 100 * DAY_MS).toISOString();

    clock.now = T0 - 100 * DAY_MS;
    await store.upsert(upsertInput({ sourceId: "a-old", ts: old }));
    await store.upsert(upsertInput({ sourceId: "b-old", address: ADDRESS_B, ts: old }));

    clock.now = T0 + 1_000;
    await store.sweepRetention({ source: SOURCE, address: ADDRESS_A });

    expect((await store.list(SOURCE, ADDRESS_A)).length).toBe(0);
    expect((await store.list(SOURCE, ADDRESS_B)).length).toBe(1);
  });

  test("[delta-05] a tombstone carries no content and no title", async () => {
    const { store, blobs, clock } = harness();

    clock.now = T0 - 100 * DAY_MS;
    await store.upsert(
      upsertInput({
        sourceId: "mtg-old",
        title: TITLE_TEXT,
        ts: new Date(T0 - 100 * DAY_MS).toISOString(),
      }),
    );
    clock.now = T0 + 1_000;
    await store.sweepRetention({ source: SOURCE, address: ADDRESS_A });

    const dump = blobs.dump();
    expect(dump).not.toContain(TITLE_TEXT);
    expect(dump).not.toContain(TRANSCRIPT_TEXT.slice(0, 24));
  });


  test("[delta-05] purge removes every row, index and tombstone for one address only", async () => {
    const { store } = harness();

    await store.upsert(upsertInput({ sourceId: "a-1" }));
    await store.upsert(upsertInput({ sourceId: "b-1", address: ADDRESS_B }));

    await store.purge(SOURCE, ADDRESS_A);

    expect((await store.list(SOURCE, ADDRESS_A)).length).toBe(0);
    expect((await store.list(SOURCE, ADDRESS_B)).length).toBe(1);
  });
});

// ── delta 5: the sweep RUNS — the D2a window is enforced, not just implemented ──

/**
 * A sweep nothing calls is not a retention policy. The directory must include every persisted
 * index, even after an account leaves the active ingest cohort, and a single lease serializes
 * writes across processes.
 */
describe("W4 retention sweep — wired to the lease-holding instance", () => {
  interface SweepCall {
    source: string;
    address: string;
    safetyMarginMs?: number;
  }

  function sweepRecorder(options: { throwOn?: string } = {}): {
    target: RetentionSweepTarget;
    calls: SweepCall[];
    maxInflight: () => number;
  } {
    const calls: SweepCall[] = [];
    let inflight = 0;
    let peak = 0;
    return {
      calls,
      maxInflight: () => peak,
      target: {
        async sweepRetention(input) {
          calls.push({
            source: input.source,
            address: input.address,
            ...(input.safetyMarginMs === undefined
              ? {}
              : { safetyMarginMs: input.safetyMarginMs }),
          });
          inflight += 1;
          peak = Math.max(peak, inflight);
          try {
            // Yield once so Promise.all would overlap, without waiting on wall-clock time.
            await Promise.resolve();
            if (options.throwOn === input.address) {
              throw new Error("substrate unavailable");
            }
            return { swept: 1, bytesFreed: 10, tombstones: 1 };
          } finally {
            inflight -= 1;
          }
        },
        async sweepExpiredReplayTombstones() {
          return 0;
        },
      },
    };
  }

  const indexes = (...addresses: string[]) =>
    async () => addresses.map((address) => ({ source: SOURCE, address }));

  test("[delta-05] the sweeper visits every stored index one node call at a time", async () => {
    const recorder = sweepRecorder();
    const sweeper = new IngestRetentionSweeper({
      content: recorder.target,
      indexes: indexes(ADDRESS_A, ADDRESS_B),
    });

    const result = await sweeper.sweepOnce();

    expect(result).toEqual({ addresses: 2, swept: 2, errors: 0 });
    expect(recorder.calls).toEqual([
      { source: SOURCE, address: ADDRESS_A, safetyMarginMs: 5 * 60_000 },
      { source: SOURCE, address: ADDRESS_B, safetyMarginMs: 5 * 60_000 },
    ]);
    expect(recorder.maxInflight()).toBe(1);
  });

  test("the first successful pass logs one deploy summary with counts and hashed tenants", async () => {
    const log = spyOn(console, "log").mockImplementation(() => {});
    const sweeper = new IngestRetentionSweeper({
      content: {
        async sweepRetention({ address }: { address: string }) {
          if (address === ADDRESS_B) throw new Error("one index failed");
          return {
            swept: 1,
            bytesFreed: 10,
            tombstones: 0,
            storedAtBackfilled: 2,
            unreadableIndex: true,
          };
        },
        async sweepExpiredReplayTombstones() {
          return 0;
        },
      },
      indexes: indexes(ADDRESS_A, ADDRESS_B),
    });

    try {
      await sweeper.sweepOnce();
      await sweeper.sweepOnce();
      const summaries = log.mock.calls
        .map(([line]) => String(line))
        .filter((line) => line.includes("op=deploy-retention-summary"));
      expect(summaries).toHaveLength(1);
      expect(summaries[0]).toContain(
        "tenants_swept=2 stored_at_backfilled=2 unreadable_indexes=1",
      );
      expect(summaries[0]).toContain("errors=1");
      expect(summaries[0]).toContain("tenant_hashes=");
      expect(summaries[0]).not.toContain(ADDRESS_A);
      expect(summaries[0]).not.toContain(ADDRESS_B);
    } finally {
      log.mockRestore();
    }
  });
  test("the configured sweep interval is passed as the retention safety margin", async () => {
    const recorder = sweepRecorder();
    const sweeper = new IngestRetentionSweeper({
      content: recorder.target,
      indexes: indexes(ADDRESS_A),
      intervalMs: 1_234,
    });

    await sweeper.sweepOnce();

    expect(recorder.calls).toEqual([
      { source: SOURCE, address: ADDRESS_A, safetyMarginMs: 1_234 },
    ]);
  });

  test("[delta-05] a failed directory listing is retried on the next retention pass", async () => {
    const recorder = sweepRecorder();
    let attempts = 0;
    const sweeper = new IngestRetentionSweeper({
      content: recorder.target,
      indexes: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("index listing unavailable");
        return [{ source: SOURCE, address: ADDRESS_A }];
      },
    });

    expect(await sweeper.sweepOnce()).toEqual({ addresses: 0, swept: 0, errors: 1 });
    expect(await sweeper.sweepOnce()).toEqual({ addresses: 1, swept: 1, errors: 0 });
    expect(recorder.calls).toEqual([
      { source: SOURCE, address: ADDRESS_A, safetyMarginMs: 5 * 60_000 },
    ]);
  });
  test("expired replay markers are swept even when the index directory is unavailable", async () => {
    const recorder = sweepRecorder();
    let markerSweeps = 0;
    const sweeper = new IngestRetentionSweeper({
      content: {
        ...recorder.target,
        async sweepExpiredReplayTombstones() {
          markerSweeps += 1;
          return 2;
        },
      },
      indexes: async () => {
        throw new Error("index listing unavailable");
      },
    });

    expect(await sweeper.sweepOnce()).toEqual({
      addresses: 0,
      swept: 0,
      errors: 1,
    });
    expect(markerSweeps).toBe(1);
  });


  test("[delta-05] one index failure does not cost other indexes their sweep", async () => {
    const recorder = sweepRecorder({ throwOn: ADDRESS_A });
    const sweeper = new IngestRetentionSweeper({
      content: recorder.target,
      indexes: indexes(ADDRESS_A, ADDRESS_B),
    });

    const result = await sweeper.sweepOnce();

    expect(result.errors).toBe(1);
    expect(result.swept).toBe(1);
    expect(recorder.calls.map((call) => call.address)).toEqual([
      ADDRESS_A,
      ADDRESS_B,
    ]);
  });

  test("[delta-05] sweep logs never name a tenant or meeting", async () => {
    const recorder = sweepRecorder();
    const sweeper = new IngestRetentionSweeper({
      content: recorder.target,
      indexes: indexes(ADDRESS_A),
    });

    const capture = captureLogs();
    try {
      await sweeper.sweepOnce();
    } finally {
      capture.restore();
    }

    const emitted = capture.lines.join("\n");
    expect(emitted).toContain("op=retention-pass");
    expect(emitted).not.toContain(ADDRESS_A);
  });

  test("[delta-05] the supervisor runs retention on the lease holder only", async () => {
    const lease = new Map<string, InstanceLeaseRecord>();
    const leaseStore = (): InstanceLeaseStore => ({
      read: async () => lease.get("k") ?? null,
      write: async (record) => {
        lease.set("k", record);
      },
      clear: async () => {
        lease.delete("k");
      },
    });

    const holderSweeper = new IngestRetentionSweeper({
      content: sweepRecorder().target,
      indexes: indexes(ADDRESS_A),
    });
    const holder = new IngestInstanceSupervisor({
      guard: new IngestInstanceGuard(leaseStore(), { instanceId: "inst-one" }),
      worker: holderSweeper,
    });
    expect(await holder.tick()).toBe("holder");
    expect(holderSweeper.isRunning()).toBe(true);

    const refusedSweeper = new IngestRetentionSweeper({
      content: sweepRecorder().target,
      indexes: indexes(ADDRESS_A),
    });
    const refused = new IngestInstanceSupervisor({
      guard: new IngestInstanceGuard(leaseStore(), { instanceId: "inst-two" }),
      worker: refusedSweeper,
    });
    expect(await refused.tick()).toBe("inert");
    expect(refusedSweeper.isRunning()).toBe(false);

    await holder.stop();
    expect(holderSweeper.isRunning()).toBe(false);
  });

  test("[delta-05] with ingest off, a user outside cohort still has old content swept", async () => {
    const { store, clock } = harness();
    clock.now = T0 - 15 * DAY_MS;
    await store.upsert(
      upsertInput({
        address: ADDRESS_B,
        sourceId: "mtg-out-of-cohort",
      }),
    );
    clock.now = T0;

    const node = new FakeNode();
    node.store.set(`connector-content-index/${SOURCE}/${ADDRESS_A}`, {});
    node.store.set(`connector-content-index/${SOURCE}/${ADDRESS_B}`, {});
    const directory = createContentIndexDirectory(node as unknown as TinyCloudNode);
    const activeCohort = new Set([ADDRESS_A]);
    const existingIndexes = await directory();
    expect(activeCohort.has(ADDRESS_B)).toBe(false);
    const sweeper = new IngestRetentionSweeper({
      content: store,
      indexes: async () => existingIndexes,
    });
    const result = await sweeper.sweepOnce();

    expect(result.addresses).toBe(2);
    expect(result.swept).toBe(1);
    expect(await store.get(SOURCE, ADDRESS_B, "mtg-out-of-cohort")).toBeNull();
  });

  test("[delta-05] a held sweep pass deletes aged-out content from the store", async () => {
    const { store, clock } = harness();
    clock.now = T0 - 15 * DAY_MS;
    await store.upsert(
      upsertInput({
        sourceId: "mtg-old",
      }),
    );
    clock.now = T0;

    const sweeper = new IngestRetentionSweeper({
      content: store,
      indexes: indexes(ADDRESS_A),
    });
    const result = await sweeper.sweepOnce();

    expect(result.swept).toBe(1);
    expect(await store.get(SOURCE, ADDRESS_A, "mtg-old")).toBeNull();
  });
  test("[delta-05] the startup directory includes addresses with orphan blobs and no index", async () => {
    const node = new FakeNode();
    const orphanAddress = "0x3333330000000000000000000000000000003333";
    node.store.set(`connector-content/${SOURCE}/${orphanAddress}/mtg-orphan`, {});

    const directory = createContentIndexDirectory(node as unknown as TinyCloudNode);

    expect(await directory()).toContainEqual({ source: SOURCE, address: orphanAddress });
  });
});

// ── The content is a SECRET: encryption, isolation, redaction ────────

describe("W4 content store — content custody", () => {
  test("raw substrate bytes contain no plaintext transcript, summary or title", async () => {
    const { store, blobs } = harness();

    await store.upsert(
      upsertInput({
        sourceId: "mtg-secret",
        title: TITLE_TEXT,
        content: { sentences: [TRANSCRIPT_TEXT] },
      }),
    );
    await store.upsert(
      upsertInput({
        sourceId: "mtg-secret",
        kind: "summary",
        content: { overview: SUMMARY_TEXT },
      }),
    );

    const dump = blobs.dump();
    expect(dump).not.toContain(TRANSCRIPT_TEXT);
    expect(dump).not.toContain(SUMMARY_TEXT);
    expect(dump).not.toContain(TITLE_TEXT);
    expect(dump).not.toContain("sentences");
    // …and it is not merely encoded: base64 of the plaintext must not be there either.
    expect(dump).not.toContain(Buffer.from(TRANSCRIPT_TEXT, "utf8").toString("base64"));
  });

  test("a row relabelled into another tenant's slot fails closed", async () => {
    const { store, blobs } = harness();

    await store.upsert(upsertInput({ sourceId: "mtg-aad" }));
    const stolen = await blobs.read(SOURCE, ADDRESS_A, "mtg-aad");
    expect(stolen).not.toBeNull();
    await blobs.write(SOURCE, ADDRESS_B, "mtg-aad", stolen as SealedBlob);

    // The envelope is AAD-bound to (source, address): B cannot open A's content.
    await expect(store.get(SOURCE, ADDRESS_B, "mtg-aad")).rejects.toThrow();
  });

  test("no log line carries content, a title, a raw address or a raw meeting id", async () => {
    const { store, clock } = harness({ maxUserMeetings: 1 });
    const capture = captureLogs();
    try {
      await store.upsert(
        upsertInput({ sourceId: "mtg-log-1", title: TITLE_TEXT }),
      );
      clock.now = T0 + 1_000;
      await store.upsert(
        upsertInput({ sourceId: "mtg-log-2", title: TITLE_TEXT }),
      );
      clock.now = T0 + 2_000;
      await store.sweepRetention({ source: SOURCE, address: ADDRESS_A });
    } finally {
      capture.restore();
    }

    const joined = capture.lines.join("\n");
    expect(joined).not.toContain(TITLE_TEXT);
    expect(joined).not.toContain(TRANSCRIPT_TEXT);
    expect(joined).not.toContain(ADDRESS_A);
    expect(joined).not.toContain("mtg-log-1");
    expect(joined).not.toContain("mtg-log-2");
  });

  test("refuses to boot on a missing, weak or master-reusing content master", () => {
    expect(
      validateContentCustodyConfig({
        [CONTENT_MASTER_ENV]: CONTENT_MASTER,
        WEBHOOK_HMAC_MASTER: WEBHOOK_MASTER,
        CONNECTOR_CREDENTIAL_MASTER: CREDENTIAL_MASTER,
      } as NodeJS.ProcessEnv).ok,
    ).toBe(true);

    expect(validateContentCustodyConfig({} as NodeJS.ProcessEnv).ok).toBe(false);
    expect(
      validateContentCustodyConfig({
        [CONTENT_MASTER_ENV]: "short",
      } as NodeJS.ProcessEnv).ok,
    ).toBe(false);

    // One compromise must not be both content custody and delivery authentication…
    const reusesWebhook = validateContentCustodyConfig({
      [CONTENT_MASTER_ENV]: WEBHOOK_MASTER,
      WEBHOOK_HMAC_MASTER: WEBHOOK_MASTER,
    } as NodeJS.ProcessEnv);
    expect(reusesWebhook.ok).toBe(false);
    expect(reusesWebhook.ok === false ? reusesWebhook.error : "").not.toContain(
      WEBHOOK_MASTER,
    );

    // …nor both content custody and credential custody.
    expect(
      validateContentCustodyConfig({
        [CONTENT_MASTER_ENV]: CREDENTIAL_MASTER,
        CONNECTOR_CREDENTIAL_MASTER: CREDENTIAL_MASTER,
      } as NodeJS.ProcessEnv).ok,
    ).toBe(false);
  });

  test("an invalid source or address is refused before anything is written", async () => {
    const { store, blobs } = harness();

    const badSource = await store.upsert(
      upsertInput({ sourceId: "mtg-bad", source: "NOT A SOURCE" }),
    );
    expect(badSource.ok).toBe(false);

    const badAddress = await store.upsert(
      upsertInput({ sourceId: "mtg-bad", address: "not-an-address" }),
    );
    expect(badAddress.ok).toBe(false);

    const badId = await store.upsert(upsertInput({ sourceId: "not a meeting id!" }));
    expect(badId.ok).toBe(false);

    expect(blobs.dump()).toBe("[]");
  });
});

// ── Fake backend-KV node (same shape as connector-queue.test.ts) ─────

class FakeNode {
  readonly store = new Map<string, unknown>();
  readonly calls: Array<{ op: string; key: string }> = [];
  maxConcurrent = 0;
  private inFlight = 0;
  overridePutResult: unknown | null = null;
  overrideDeleteResult: unknown | null = null;
  overrideGetResult: unknown | null = null;
  overrideGetResultForKey: ((key: string) => unknown) | null = null;

  readonly kv = {
    get: async (key: string): Promise<unknown> => {
      await this.enter("get", key);
      try {
        if (this.overrideGetResultForKey !== null) {
          const result = this.overrideGetResultForKey(key);
          if (result !== undefined) return result;
        }
        if (this.overrideGetResult !== null) return this.overrideGetResult;
        if (!this.store.has(key)) return { data: null };
        return { data: { data: this.store.get(key) } };
      } finally {
        this.exit();
      }
    },
    list: async (options: unknown): Promise<unknown> => {
      const prefix =
        typeof options === "object" && options !== null && "prefix" in options
          ? String((options as { prefix: unknown }).prefix)
          : "";
      await this.enter("list", prefix);
      try {
        return {
          data: {
            keys: [...this.store.keys()]
              .filter((key) => key.startsWith(prefix))
              .map((key) => ({ key })),
          },
        };
      } finally {
        this.exit();
      }
    },
    put: async (key: string, value: unknown): Promise<unknown> => {
      await this.enter("put", key);
      try {
        if (this.overridePutResult !== null) return this.overridePutResult;
        this.store.set(key, JSON.parse(JSON.stringify(value)));
        return { data: true };
      } finally {
        this.exit();
      }
    },
    delete: async (key: string): Promise<unknown> => {
      await this.enter("delete", key);
      try {
        if (this.overrideDeleteResult !== null) return this.overrideDeleteResult;
        this.store.delete(key);
        return { data: true };
      } finally {
        this.exit();
      }
    },
  };

  async signIn(): Promise<void> {}

  private async enter(op: string, key: string): Promise<void> {
    this.calls.push({ op, key });
    this.inFlight += 1;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.inFlight);
    await Promise.resolve();
  }

  private exit(): void {
    this.inFlight -= 1;
  }
}
describe("W4 KV adapter malformed index refusal", () => {
  const indexKey = `connector-content-index/${SOURCE}/${ADDRESS_A}`;

  test("production KV_NOT_FOUND results are absent for new index and content keys", async () => {
    const node = new FakeNode();
    node.overrideGetResultForKey = (key) => ({
      ok: false,
      error: {
        code: "KV_NOT_FOUND",
        service: "kv",
        message: `Key not found: ${key}`,
      },
    });
    const adapter = new KvContentBlobStore(
      node as unknown as TinyCloudNode,
    );
    const store = new ContentStore(adapter, {
      now: () => T0,
      master: () => CONTENT_MASTER,
    });

    expect(await adapter.readIndex(SOURCE, ADDRESS_A)).toBeNull();
    expect(await adapter.read(SOURCE, ADDRESS_A, "mtg-first-store")).toBeNull();
    expect(await store.list(SOURCE, ADDRESS_A)).toEqual([]);
    expect(await store.get(SOURCE, ADDRESS_A, "mtg-first-store")).toBeNull();
    expect(
      await store.upsert(upsertInput({ sourceId: "mtg-first-store" })),
    ).toEqual({ ok: true, stored: "created" });
    expect(node.store.has(indexKey)).toBe(true);
    expect(
      node.store.has(
        `connector-content/${SOURCE}/${ADDRESS_A}/mtg-first-store`,
      ),
    ).toBe(true);
  });
  test("listContentIds propagates KV read failures instead of skipping them", async () => {
    const node = new FakeNode();
    const sourceId = "mtg-transient-kv-error";
    const key = `connector-content/${SOURCE}/${ADDRESS_A}/${sourceId}`;
    node.store.set(key, { ciphertext: "c", wrappedDEK: "k" });
    node.overrideGetResultForKey = (requestedKey) =>
      requestedKey === key
        ? {
            ok: false,
            error: {
              code: "KV_UNAVAILABLE",
              service: "kv",
              message: "KV temporarily unavailable",
            },
          }
        : undefined;
    const adapter = new KvContentBlobStore(
      node as unknown as TinyCloudNode,
    );

    await expect(
      adapter.listContentIds(SOURCE, ADDRESS_A),
    ).rejects.toThrow();
  });

  test("malformed orphan content does not stop a retention sweep from deleting later expired blobs", async () => {
    const node = new FakeNode();
    const clock = { now: T0 };
    const store = new ContentStore(
      new KvContentBlobStore(node as unknown as TinyCloudNode),
      { now: () => clock.now, master: () => CONTENT_MASTER },
    );
    await store.upsert(
      upsertInput({ sourceId: "mtg-valid-content" }),
    );

    clock.now = T0 - 15 * DAY_MS;
    const expiredId = "mtg-expired-after-malformed";
    expect(
      await store.upsert(
        upsertInput({
          sourceId: expiredId,
          ts: new Date(clock.now).toISOString(),
        }),
      ),
    ).toEqual({ ok: true, stored: "created" });
    clock.now = T0;

    const malformedId = "mtg-malformed-orphan";
    const malformedKey =
      `connector-content/${SOURCE}/${ADDRESS_A}/${malformedId}`;
    node.store.set(malformedKey, "{");
    const logs = captureLogs();
    try {
      expect(
        await store.sweepRetention({ source: SOURCE, address: ADDRESS_A }),
      ).toMatchObject({ swept: 1 });
      expect(
        node.store.has(
          `connector-content/${SOURCE}/${ADDRESS_A}/${expiredId}`,
        ),
      ).toBe(false);
      expect(
        node.store.has(
          `connector-content/${SOURCE}/${ADDRESS_A}/mtg-valid-content`,
        ),
      ).toBe(true);
      expect(node.store.has(malformedKey)).toBe(true);
      expect(logs.lines.some((line) => line.includes("unparseable_blob"))).toBe(
        true,
      );
      expect(logs.lines.join(" ")).not.toContain(malformedId);
    } finally {
      logs.restore();
    }
  });


  test.each([
    ["invalid JSON", "{"],
    ["JSON primitive", "42"],
    ["JSON null", "null"],
    ["object missing envelope fields", JSON.stringify({ data: true })],
  ])("a present malformed index (%s) is not treated as absent", async (_name, raw) => {
    const node = new FakeNode();
    node.store.set(indexKey, raw);
    const adapter = new KvContentBlobStore(
      node as unknown as TinyCloudNode,
    );

    await expect(adapter.readIndex(SOURCE, ADDRESS_A)).rejects.toThrow(
      "content blob is unparseable",
    );
  });

  test("an invalid KV result shape is not mistaken for a missing index", async () => {
    const node = new FakeNode();
    node.overrideGetResult = { malformed: true };
    const adapter = new KvContentBlobStore(
      node as unknown as TinyCloudNode,
    );

    await expect(adapter.readIndex(SOURCE, ADDRESS_A)).rejects.toThrow();
  });

  test("upsert refuses a malformed index without replacing it", async () => {
    const node = new FakeNode();
    node.store.set(indexKey, "{");
    const store = new ContentStore(
      new KvContentBlobStore(node as unknown as TinyCloudNode),
      { now: () => T0, master: () => CONTENT_MASTER },
    );

    expect(await store.upsert(upsertInput({ sourceId: "mtg-malformed-upsert" }))).toEqual({
      ok: false,
      code: "content_store_failed",
    });
    expect(node.store.get(indexKey)).toBe("{");
    expect(node.store.has(`connector-content/${SOURCE}/${ADDRESS_A}/mtg-malformed-upsert`)).toBe(false);
  });

  test("retention refuses malformed indexes without deleting expired content", async () => {
    const node = new FakeNode();
    node.store.set(indexKey, "{");
    const expiredKey = `connector-content/${SOURCE}/${ADDRESS_A}/mtg-expired-under-malformed-index`;
    node.store.set(expiredKey, {
      ciphertext: "ciphertext",
      wrappedDEK: "wrapped-key",
      storedAt: new Date(T0 - 15 * DAY_MS).toISOString(),
      updatedAt: new Date(T0 - 15 * DAY_MS).toISOString(),
    });
    const store = new ContentStore(
      new KvContentBlobStore(node as unknown as TinyCloudNode),
      { now: () => T0, master: () => CONTENT_MASTER },
    );

    expect(
      await store.sweepRetention({ source: SOURCE, address: ADDRESS_A }),
    ).toMatchObject({ swept: 0, unreadableIndex: true });
    expect(node.store.get(indexKey)).toBe("{");
    expect(node.store.has(expiredKey)).toBe(true);
    expect(node.calls.some((call) => call.op === "delete")).toBe(false);
  });

  test("purge refuses malformed indexes without deleting any keys", async () => {
    const node = new FakeNode();
    node.store.set(indexKey, "{");
    const contentKey = `connector-content/${SOURCE}/${ADDRESS_A}/mtg-malformed-purge`;
    node.store.set(contentKey, {
      ciphertext: "ciphertext",
      wrappedDEK: "wrapped-key",
      storedAt: new Date(T0).toISOString(),
      updatedAt: new Date(T0).toISOString(),
    });
    const store = new ContentStore(
      new KvContentBlobStore(node as unknown as TinyCloudNode),
      { now: () => T0, master: () => CONTENT_MASTER },
    );

    await expect(store.purge(SOURCE, ADDRESS_A)).rejects.toThrow(
      "content index is unreadable",
    );
    expect(node.store.get(indexKey)).toBe("{");
    expect(node.store.has(contentKey)).toBe(true);
    expect(node.calls.some((call) => call.op === "delete")).toBe(false);
  });
});


describe("W4 content store — sequential storage (§9.3)", () => {
  test("concurrent upserts still reach the node one call at a time", async () => {
    const node = new FakeNode();
    const store = new ContentStore(
      new KvContentBlobStore(node as unknown as TinyCloudNode),
      { now: () => T0, master: () => CONTENT_MASTER },
    );

    // TinyCloud drops concurrent responses on one space, so the adapter serialises.
    await Promise.all([
      store.upsert(upsertInput({ sourceId: "mtg-c1" })),
      store.upsert(upsertInput({ sourceId: "mtg-c2" })),
      store.upsert(upsertInput({ sourceId: "mtg-c3" })),
    ]);

    expect(node.maxConcurrent).toBe(1);
    expect((await store.list(SOURCE, ADDRESS_A)).length).toBe(3);
  });
});
describe("W4 content store — immutable expiry and replay protection", () => {
  test("expiry is fixed at first server storage and merges cannot extend it", async () => {
    const { store, clock } = harness();
    const id = "mtg-immutable-expiry";
    expect(
      await store.upsert(
        upsertInput({ sourceId: id, ts: new Date(T0).toISOString() }),
      ),
    ).toEqual({ ok: true, stored: "created" });

    const first = await store.get(SOURCE, ADDRESS_A, id);
    expect(first?.meta.expiresAt).toBe("2026-08-24");

    clock.now += 10 * DAY_MS;
    expect(
      await store.upsert(
        upsertInput({
          sourceId: id,
          kind: "summary",
          ts: new Date(clock.now).toISOString(),
          content: { overview: SUMMARY_TEXT },
        }),
      ),
    ).toEqual({ ok: true, stored: "merged" });

    const merged = await store.get(SOURCE, ADDRESS_A, id);
    expect(merged?.meta.storedAt).toBe(first?.meta.storedAt);
    expect(merged?.meta.expiresAt).toBe(first?.meta.expiresAt);
  });

  test("refuses a provider meeting older than the retention window", async () => {
    const { store } = harness();
    expect(
      await store.upsert(
        upsertInput({
          sourceId: "mtg-too-old",
          ts: new Date(T0 - 15 * DAY_MS).toISOString(),
        }),
      ),
    ).toEqual({ ok: false, code: "meeting_too_old" });
    expect(await store.get(SOURCE, ADDRESS_A, "mtg-too-old")).toBeNull();
  });

  test("age-sweeps valid expired content while the index is unreadable and tombstones replays", async () => {
    const { store, blobs, clock } = harness();
    const id = "mtg-expired-unreadable-index";
    await store.upsert(
      upsertInput({ sourceId: id, ts: new Date(T0).toISOString() }),
    );
    clock.now = T0 + 15 * DAY_MS + 2 * 60 * 60_000;

    await blobs.writeIndex(SOURCE, ADDRESS_A, {
      ciphertext: "corrupt",
      wrappedDEK: "corrupt",
      updatedAt: new Date(clock.now).toISOString(),
    });
    const retentionStore = new ContentStore(blobs, {
      now: () => clock.now,
      master: () => CONTENT_MASTER,
    });
    expect(
      await retentionStore.sweepRetention({
        source: SOURCE,
        address: ADDRESS_A,
      }),
    ).toMatchObject({ swept: 1, unreadableIndex: true });
    expect(await store.get(SOURCE, ADDRESS_A, id)).toBeNull();
    expect(await blobs.listReplayTombstones()).toHaveLength(1);

    await blobs.removeIndex(SOURCE, ADDRESS_A);
    expect(
      await store.upsert(
        upsertInput({ sourceId: id, ts: new Date(clock.now).toISOString() }),
      ),
    ).toEqual({ ok: false, code: "retention_tombstoned" });
    expect(await blobs.read(SOURCE, ADDRESS_A, id)).toBeNull();
  });

  test("the age sweep waits through the configured one-hour expiry grace", async () => {
    const { store, clock } = harness();
    const id = "mtg-expiry-grace-boundary";
    await store.upsert(
      upsertInput({ sourceId: id, ts: new Date(T0).toISOString() }),
    );

    clock.now = Date.parse("2026-08-25T00:59:59.999Z");
    expect(
      (await store.sweepRetention({ source: SOURCE, address: ADDRESS_A })).swept,
    ).toBe(0);
    clock.now += 1;
    expect(
      (await store.sweepRetention({ source: SOURCE, address: ADDRESS_A })).swept,
    ).toBe(1);
  });

  test("missing blobs read as absent and the next readable sweep prunes the index entry", async () => {
    const { store, blobs, clock } = harness();
    const id = "mtg-missing-blob-expiry";
    await store.upsert(
      upsertInput({ sourceId: id, ts: new Date(T0).toISOString() }),
    );
    await blobs.remove(SOURCE, ADDRESS_A, id);
    expect(await store.get(SOURCE, ADDRESS_A, id)).toBeNull();
    expect(await blobs.read(SOURCE, ADDRESS_A, id)).toBeNull();
    clock.now = Date.parse("2026-08-25T02:00:00.000Z");

    expect(
      await store.sweepRetention({ source: SOURCE, address: ADDRESS_A }),
    ).toMatchObject({ swept: 1 });
    expect(await store.list(SOURCE, ADDRESS_A)).toEqual([]);
    expect(await blobs.listReplayTombstones()).toHaveLength(1);
  });

  test("missing, malformed and far-future expiry metadata refuse deletion and log", async () => {
    const cases = [
      ["missing", (sealed: SealedBlob): SealedBlob => {
        const { expiresAt: _expiresAt, ...rest } = sealed;
        return rest;
      }],
      ["malformed", (sealed: SealedBlob): SealedBlob => ({
        ...sealed,
        expiresAt: "2026-02-30",
      })],
      ["aad-mismatch", (sealed: SealedBlob): SealedBlob => ({
        ...sealed,
        expiresAt: "2026-08-25",
      })],
      ["far-future", (sealed: SealedBlob): SealedBlob => ({
        ...sealed,
        expiresAt: "2099-01-01",
      })],
    ] as const;
    const logs = captureLogs();

    try {
      for (const [label, tamper] of cases) {
        const { store, blobs, clock } = harness();
        const id = `mtg-${label}-expiry`;
        await store.upsert(
          upsertInput({ sourceId: id, ts: new Date(T0).toISOString() }),
        );
        const sealed = await blobs.read(SOURCE, ADDRESS_A, id);
        expect(sealed).not.toBeNull();
        await blobs.write(SOURCE, ADDRESS_A, id, tamper(sealed!));
        clock.now = Date.parse("2026-08-25T02:00:00.000Z");

        expect(
          await store.sweepRetention({ source: SOURCE, address: ADDRESS_A }),
        ).toMatchObject({ swept: 0 });
        expect(await blobs.read(SOURCE, ADDRESS_A, id)).not.toBeNull();
        expect(logs.lines.some((line) => line.includes("expiry_unreadable"))).toBe(
          true,
        );
        expect(logs.lines.join(" ")).not.toContain(id);
      }
    } finally {
      logs.restore();
    }
  });

  test("a replay after the deletion marker expires cannot restart retention", async () => {
    const { store, clock } = harness();
    const id = "mtg-old-replay";
    await store.upsert(
      upsertInput({ sourceId: id, ts: new Date(T0).toISOString() }),
    );
    clock.now = T0 + 15 * DAY_MS + 2 * 60 * 60_000;
    expect(
      (await store.sweepRetention({ source: SOURCE, address: ADDRESS_A }))
        .swept,
    ).toBe(1);

    clock.now += 15 * DAY_MS;
    expect(
      await store.upsert(
        upsertInput({ sourceId: id, ts: new Date(T0).toISOString() }),
      ),
    ).toEqual({ ok: false, code: "meeting_too_old" });
    expect(await store.get(SOURCE, ADDRESS_A, id)).toBeNull();
  });
  test("missing provider time uses the marker alone and logs without content", async () => {
    const { store, blobs, clock } = harness();
    const id = "mtg-no-time-replay";
    const logs = captureLogs();
    try {
      expect(await store.upsert(upsertInput({ sourceId: id }))).toMatchObject({
        ok: true,
        stored: "created",
      });
      expect(logs.lines.some((line) => line.includes("meeting_time_missing"))).toBe(true);
      expect(logs.lines.join(" ")).not.toContain(id);
      expect(logs.lines.join(" ")).not.toContain(ADDRESS_A);

      clock.now = T0 + 15 * DAY_MS;
      expect(
        (await store.sweepRetention({ source: SOURCE, address: ADDRESS_A }))
          .swept,
      ).toBe(1);
      const markers = await blobs.listReplayTombstones();
      expect(markers).toHaveLength(1);
      expect(markers[0]?.digest).toMatch(/^[a-f0-9]{64}$/);
      expect(markers[0]?.marker?.expiresAt).toBe(
        new Date(clock.now + 14 * DAY_MS).toISOString(),
      );

      await blobs.removeIndex(SOURCE, ADDRESS_A);
      expect(
        await store.upsert(upsertInput({ sourceId: id })),
      ).toMatchObject({ ok: false, code: "retention_tombstoned" });

      clock.now += 14 * DAY_MS - 1;
      expect(await store.sweepExpiredReplayTombstones()).toBe(0);
      clock.now += 1;
      expect(await store.sweepExpiredReplayTombstones()).toBe(1);
      expect(await blobs.listReplayTombstones()).toEqual([]);

      expect(await store.upsert(upsertInput({ sourceId: id }))).toMatchObject({
        ok: true,
        stored: "created",
      });
    } finally {
      logs.restore();
    }
  });

  test("expiry metadata is authenticated by the content envelope", async () => {
    const { store, blobs } = harness();
    const id = "mtg-expiry-aad";
    await store.upsert(upsertInput({ sourceId: id }));
    const sealed = await blobs.read(SOURCE, ADDRESS_A, id);
    expect(sealed?.expiresAt).toBe("2026-08-24");
    await blobs.write(SOURCE, ADDRESS_A, id, {
      ...sealed!,
      expiresAt: "2026-08-25",
    });

    await expect(store.get(SOURCE, ADDRESS_A, id)).rejects.toThrow();
  });
  test("expired replay markers are removed by retention even after all content indexes disappear", async () => {
    const { store, blobs, clock } = harness();
    const id = "mtg-marker-expiry";
    await store.upsert(upsertInput({ sourceId: id }));
    clock.now = T0 + 15 * DAY_MS;
    expect(
      (await store.sweepRetention({ source: SOURCE, address: ADDRESS_A })).swept,
    ).toBe(1);
    await blobs.removeIndex(SOURCE, ADDRESS_A);

    clock.now += 14 * DAY_MS;
    expect(await store.sweepExpiredReplayTombstones()).toBe(1);
    expect(await blobs.listReplayTombstones()).toEqual([]);
  });
});
