import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import express from "express";

import {
  CONTENT_MASTER_ENV,
  ContentStore,
  InMemoryContentBlobStore,
  _resetContentMasterCache,
  type ContentBlobStore,
  type SealedBlob,
} from "../services/content-store.js";
import { createConnectorMeetingsRouter } from "../routes/connector-meetings.js";
import type { IngestMode } from "../services/ingest-mode.js";
import { _resetWebhookTokenState } from "../services/webhook-tokens.js";

/**
 * W6 — BROWSER RECONCILE, the server half (backend-ingest plan §8.1 W6; §8.2 delta 6's
 * user-space half).
 *
 * The browser half of W6 lives in `frontend/src/lib/connectors/backendReconcile.ts` (its own
 * suite drives the `tcw.kv` writes). What is testable — and what must be pinned — HERE is
 * everything the backend owes that loop:
 *
 *  1. **Discovery is a read-API list filter.** Plan §5.3 is literal about it: for a cohort
 *     address `/drain` returns nothing, "no reconcile payload — reconcile discovery is a
 *     read-API list filter". So `GET /api/connectors/meetings?reconciled=false` is the queue
 *     W6 walks, and it must be exactly the rows the ack has not stamped.
 *
 *  2. **Storage before ack.** The stamp is only ever reachable through the ack route, and the
 *     loop only calls it after the user-space `tcw.kv` write RESOLVED ok. A write that failed
 *     therefore leaves the row IN the discovery filter, and the next run picks it up again.
 *     {@link FailableUserSpace} is the instrument: it is the browser's own space, and when its
 *     put fails the run must produce zero acks.
 *
 *  3. **Idempotent re-runs.** A second pass over a fully reconciled archive writes nothing to
 *     the user's space and acks nothing — the filter is empty, so the loop has no work. This is
 *     what makes "run it on every signed-in device, on every visit" affordable.
 *
 *  4. **D2a `retain`.** Reconcile does NOT shorten retention: after the stamp the server copy is
 *     still listable AND still readable, because a second device that has not reconciled has to
 *     be able to read it.
 *
 *  5. **A partial row reconciles without throwing** (the delta-6 sentence, verbatim) and the
 *     filter stays a strictly side-effect-free read (§9 anti-pattern 5) and tenant-scoped to the
 *     session address (delta 1) — a discovery filter is exactly where a "give me everyone's
 *     unreconciled rows" convenience would otherwise appear.
 */

const ORIGINAL_ENV = { ...process.env };

const SOURCE = "fireflies";
const ADDRESS_A = "0x7d033300000000000000000000000000000073f2";
const ADDRESS_B = "0xb1b1b10000000000000000000000000000001111";
const CONTENT_MASTER = "R29vZE1hc3RlckZvckNvbnRlbnRFbnZlbG9wZXNBQTA9";
const LOG_SALT = "aQ2wS3eD4rF5tG6yH7uJ8iK9oL0pZ1xC2vB3nM4kJ5h=";

const TRANSCRIPT_TEXT = "so about the Q3 layoffs — Dana said the legal review is blocking";
const SUMMARY_TEXT = "Legal review blocks the Q3 plan; Dana owns the follow-up";
const TITLE_TEXT = "Q3 planning sync (confidential)";

const T0 = Date.parse("2026-08-10T12:00:00.000Z");

/** The frontend's KV prefix, spelled here so the key shape W6 writes is pinned on both sides. */
const USER_SPACE_PREFIX = "xyz.tinycloud.tinychat/connectors";

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

/** Counts every substrate mutation, so a "discovery" filter that writes fails the suite. */
class CountingBlobStore implements ContentBlobStore {
  writes = 0;

  constructor(private readonly inner: InMemoryContentBlobStore) {}

  readIndex(source: string, address: string): Promise<SealedBlob | null> {
    return this.inner.readIndex(source, address);
  }

  writeIndex(source: string, address: string, blob: SealedBlob): Promise<void> {
    this.writes += 1;
    return this.inner.writeIndex(source, address, blob);
  }

  read(source: string, address: string, sourceId: string): Promise<SealedBlob | null> {
    return this.inner.read(source, address, sourceId);
  }

  write(
    source: string,
    address: string,
    sourceId: string,
    blob: SealedBlob,
  ): Promise<void> {
    this.writes += 1;
    return this.inner.write(source, address, sourceId, blob);
  }

  remove(source: string, address: string, sourceId: string): Promise<void> {
    this.writes += 1;
    return this.inner.remove(source, address, sourceId);
  }

  removeAll(source: string, address: string): Promise<void> {
    this.writes += 1;
    return this.inner.removeAll(source, address);
  }
}

interface Harness {
  app: express.Express;
  store: ContentStore;
  blobs: CountingBlobStore;
  clock: { now: number };
  session: { address: string | undefined };
}

function harness(options: { address?: string } = {}): Harness {
  const blobs = new CountingBlobStore(new InMemoryContentBlobStore());
  const clock = { now: T0 };
  const store = new ContentStore(blobs, {
    now: () => clock.now,
    master: () => CONTENT_MASTER,
  });
  const cohort = new Set<string>([
    ADDRESS_A.toLowerCase(),
    ADDRESS_B.toLowerCase(),
  ]);
  const session = { address: options.address ?? ADDRESS_A };

  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use((req, _res, next) => {
    if (session.address !== undefined) req.user = { address: session.address };
    next();
  });
  app.use(
    "/api/connectors/meetings",
    createConnectorMeetingsRouter({
      content: store,
      modes: {
        mode: async (address: string): Promise<IngestMode> =>
          cohort.has(address.toLowerCase()) ? "backend" : "browser",
      },
    }),
  );

  return { app, store, blobs, clock, session };
}

async function withServer<T>(
  app: express.Express,
  fn: (base: string) => Promise<T>,
): Promise<T> {
  const server = await new Promise<import("http").Server>((resolve_) => {
    const instance = app.listen(0, () => resolve_(instance));
  });
  const { port } = server.address() as { port: number };
  try {
    return await fn(`http://localhost:${port}`);
  } finally {
    await new Promise<void>((resolve_, reject) =>
      server.close((error) => (error ? reject(error) : resolve_())),
    );
  }
}

async function call(
  base: string,
  path: string,
  method = "GET",
): Promise<{ status: number; body: any }> {
  const response = await fetch(`${base}${path}`, { method });
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  return { status: response.status, body: parsed as any };
}

/** Seed one stored meeting the way the fetch worker does — through the real upsert path. */
async function seed(
  store: ContentStore,
  input: {
    address?: string;
    sourceId: string;
    kind: "transcript" | "summary";
    text: string;
    title?: string;
    ts?: string;
  },
): Promise<void> {
  const result = await store.upsert({
    source: SOURCE,
    address: input.address ?? ADDRESS_A,
    sourceId: input.sourceId,
    kind: input.kind,
    ...(input.title === undefined ? {} : { title: input.title }),
    ...(input.ts === undefined ? {} : { ts: input.ts }),
    content: { text: input.text },
    fetchedAt: new Date(T0).toISOString(),
    receivedAt: new Date(T0).toISOString(),
  });
  // Fail closed in the FIXTURE too: a seed that silently did not store makes every
  // assertion below vacuously pass.
  expect(result).toEqual({ ok: true, stored: expect.any(String) as any });
}

/**
 * The user's OWN space, as W6 sees it: KV only (never SQL — plan §7's standing rule), keyed
 * `"${APP_ID}/connectors/{source}/…"`, and able to fail on demand so the storage-before-ack
 * invariant is testable rather than asserted.
 */
class FailableUserSpace {
  entries = new Map<string, string>();
  putKeys: string[] = [];
  failKeys = new Set<string>();

  async put(key: string, value: string): Promise<{ ok: boolean }> {
    if (this.failKeys.has(key)) return { ok: false };
    this.entries.set(key, value);
    this.putKeys.push(key);
    return { ok: true };
  }
}

interface LoopOutcome {
  written: string[];
  acked: string[];
  storageFailures: string[];
}

/**
 * The W6 loop, spelled out in the order the plan mandates: pull the discovery filter → for each
 * row, SEQUENTIALLY (TinyCloud drops concurrent responses on one space) read the content, write
 * the user's own space, and only then ack. Nothing is acked that was not written.
 */
async function reconcileLoop(
  base: string,
  space: FailableUserSpace,
): Promise<LoopOutcome> {
  const outcome: LoopOutcome = { written: [], acked: [], storageFailures: [] };
  const list = await call(base, `/api/connectors/meetings?reconciled=false`);
  expect(list.status).toBe(200);

  for (const meta of list.body.meetings as { sourceId: string; title?: string }[]) {
    const content = await call(
      base,
      `/api/connectors/meetings/${SOURCE}/${meta.sourceId}`,
    );
    if (content.status !== 200) continue;

    const wrote = await space.put(
      `${USER_SPACE_PREFIX}/${SOURCE}/meeting/${meta.sourceId}`,
      JSON.stringify({ sourceId: meta.sourceId, title: meta.title ?? null }),
    );
    if (!wrote.ok) {
      // NO ack: the row must stay in the discovery filter for the next run.
      outcome.storageFailures.push(meta.sourceId);
      continue;
    }
    outcome.written.push(meta.sourceId);

    const ack = await call(
      base,
      `/api/connectors/meetings/${SOURCE}/${meta.sourceId}/reconciled`,
      "POST",
    );
    if (ack.status === 200) outcome.acked.push(meta.sourceId);
  }
  return outcome;
}

// ── Discovery: the read-API list filter (plan §5.3) ───────────────────

describe("GET /api/connectors/meetings?reconciled=… — W6's discovery filter", () => {
  test("[delta-06] `reconciled=false` is exactly the rows the ack has not stamped", async () => {
    const h = harness();
    await seed(h.store, { sourceId: "mtg-a", kind: "transcript", text: TRANSCRIPT_TEXT });
    await seed(h.store, { sourceId: "mtg-b", kind: "transcript", text: TRANSCRIPT_TEXT });
    await seed(h.store, { sourceId: "mtg-c", kind: "summary", text: SUMMARY_TEXT });

    await withServer(h.app, async (base) => {
      const before = await call(base, "/api/connectors/meetings?reconciled=false");
      expect(before.status).toBe(200);
      expect(new Set(before.body.meetings.map((m: any) => m.sourceId))).toEqual(
        new Set(["mtg-a", "mtg-b", "mtg-c"]),
      );

      const ack = await call(
        base,
        `/api/connectors/meetings/${SOURCE}/mtg-b/reconciled`,
        "POST",
      );
      expect(ack.status).toBe(200);

      const after = await call(base, "/api/connectors/meetings?reconciled=false");
      expect(after.status).toBe(200);
      expect(new Set(after.body.meetings.map((m: any) => m.sourceId))).toEqual(
        new Set(["mtg-a", "mtg-c"]),
      );

      // The mirror, and the unfiltered list — still every row, D2a `retain`.
      const done = await call(base, "/api/connectors/meetings?reconciled=true");
      expect(done.body.meetings.map((m: any) => m.sourceId)).toEqual(["mtg-b"]);
      const all = await call(base, "/api/connectors/meetings");
      expect(all.body.meetings).toHaveLength(3);
    });
  });

  test("[delta-06] the filter pages over the FILTERED set, not the whole archive", async () => {
    const h = harness();
    for (const id of ["mtg-1", "mtg-2", "mtg-3"]) {
      await seed(h.store, { sourceId: id, kind: "transcript", text: TRANSCRIPT_TEXT });
    }
    await withServer(h.app, async (base) => {
      const ack = await call(
        base,
        `/api/connectors/meetings/${SOURCE}/mtg-2/reconciled`,
        "POST",
      );
      expect(ack.status).toBe(200);

      const page1 = await call(
        base,
        "/api/connectors/meetings?reconciled=false&limit=1",
      );
      expect(page1.status).toBe(200);
      expect(page1.body.meetings).toHaveLength(1);
      expect(page1.body.hasMore).toBe(true);
      expect(page1.body.nextCursor).toBe(page1.body.meetings[0].sourceId);

      const page2 = await call(
        base,
        `/api/connectors/meetings?reconciled=false&limit=1&cursor=${page1.body.nextCursor}`,
      );
      expect(page2.status).toBe(200);
      expect(page2.body.meetings).toHaveLength(1);
      // Two unreconciled rows in total — the reconciled one is not a page of its own.
      expect(page2.body.hasMore).toBe(false);
      const seen = [
        page1.body.meetings[0].sourceId,
        page2.body.meetings[0].sourceId,
      ];
      expect(new Set(seen)).toEqual(new Set(["mtg-1", "mtg-3"]));
    });
  });

  test("[delta-06] an unreadable `reconciled` value is a 400, never a silently ignored filter", async () => {
    const h = harness();
    await seed(h.store, { sourceId: "mtg-a", kind: "transcript", text: TRANSCRIPT_TEXT });
    await withServer(h.app, async (base) => {
      for (const value of ["yes", "1", "", "FALSE"]) {
        const res = await call(
          base,
          `/api/connectors/meetings?reconciled=${encodeURIComponent(value)}`,
        );
        // Ignoring it would hand W6 the WHOLE archive to re-write every run.
        expect(res.status).toBe(400);
        expect(res.body.error).toBe("invalid_reconciled");
      }
      const repeated = await call(
        base,
        "/api/connectors/meetings?reconciled=false&reconciled=true",
      );
      expect(repeated.status).toBe(400);
    });
  });

  test("[delta-06] discovery is a strictly side-effect-free read — zero substrate writes", async () => {
    const h = harness();
    await seed(h.store, { sourceId: "mtg-a", kind: "transcript", text: TRANSCRIPT_TEXT });
    await withServer(h.app, async (base) => {
      const baseline = h.blobs.writes;
      await call(base, "/api/connectors/meetings?reconciled=false");
      await call(base, "/api/connectors/meetings?reconciled=true");
      await call(base, "/api/connectors/meetings?reconciled=false&limit=1");
      expect(h.blobs.writes).toBe(baseline);
    });
  });

  test("[delta-06] discovery is tenant-scoped — B never sees A's unreconciled row", async () => {
    const h = harness({ address: ADDRESS_B });
    await seed(h.store, {
      address: ADDRESS_A,
      sourceId: "mtg-a-only",
      kind: "transcript",
      text: TRANSCRIPT_TEXT,
      title: TITLE_TEXT,
    });
    await withServer(h.app, async (base) => {
      const res = await call(base, "/api/connectors/meetings?reconciled=false");
      expect(res.status).toBe(200);
      expect(res.body.meetings).toEqual([]);
      // …and no id of A's leaks through the single-meeting route either.
      const one = await call(
        base,
        `/api/connectors/meetings/${SOURCE}/mtg-a-only`,
      );
      expect(one.status).toBe(404);
    });
  });
});

// ── The loop: storage before ack, idempotent re-runs, D2a retain ──────

describe("the W6 reconcile loop against the real read API", () => {
  test("[delta-06] the ack lands only AFTER the user-space write, and a re-run is a no-op", async () => {
    const h = harness();
    await seed(h.store, {
      sourceId: "mtg-a",
      kind: "transcript",
      text: TRANSCRIPT_TEXT,
      title: TITLE_TEXT,
    });
    await seed(h.store, { sourceId: "mtg-b", kind: "summary", text: SUMMARY_TEXT });

    await withServer(h.app, async (base) => {
      const space = new FailableUserSpace();
      const first = await reconcileLoop(base, space);
      expect(new Set(first.written)).toEqual(new Set(["mtg-a", "mtg-b"]));
      expect(new Set(first.acked)).toEqual(new Set(["mtg-a", "mtg-b"]));
      // KV ONLY, under the granted `${APP_ID}/connectors/` prefix.
      for (const key of space.putKeys) {
        expect(key.startsWith(`${USER_SPACE_PREFIX}/${SOURCE}/`)).toBe(true);
      }

      const second = await reconcileLoop(base, space);
      // Idempotent: nothing left to discover, so nothing written and nothing acked.
      expect(second.written).toEqual([]);
      expect(second.acked).toEqual([]);
      expect(space.putKeys).toHaveLength(2);
    });
  });

  test("[delta-06] a FAILED user-space write acks nothing and stays in the discovery filter", async () => {
    const h = harness();
    await seed(h.store, {
      sourceId: "mtg-a",
      kind: "transcript",
      text: TRANSCRIPT_TEXT,
      title: TITLE_TEXT,
    });

    await withServer(h.app, async (base) => {
      const space = new FailableUserSpace();
      space.failKeys.add(`${USER_SPACE_PREFIX}/${SOURCE}/meeting/mtg-a`);

      const failed = await reconcileLoop(base, space);
      expect(failed.storageFailures).toEqual(["mtg-a"]);
      expect(failed.acked).toEqual([]);

      // Still unreconciled server-side — the next run picks it up, which is the whole
      // point of acking after the write instead of before it.
      const pending = await call(base, "/api/connectors/meetings?reconciled=false");
      expect(pending.body.meetings.map((m: any) => m.sourceId)).toEqual(["mtg-a"]);
      expect(pending.body.meetings[0].reconciledAt).toBeUndefined();

      space.failKeys.clear();
      const retry = await reconcileLoop(base, space);
      expect(retry.written).toEqual(["mtg-a"]);
      expect(retry.acked).toEqual(["mtg-a"]);
      const cleared = await call(base, "/api/connectors/meetings?reconciled=false");
      expect(cleared.body.meetings).toEqual([]);
    });
  });

  test("[delta-06] a summary-only PARTIAL row reconciles without throwing, and the server copy is RETAINED", async () => {
    const h = harness();
    await seed(h.store, { sourceId: "mtg-partial", kind: "summary", text: SUMMARY_TEXT });

    await withServer(h.app, async (base) => {
      const space = new FailableUserSpace();
      const run = await reconcileLoop(base, space);
      expect(run.acked).toEqual(["mtg-partial"]);

      // D2a `retain`: reconcile does not shorten retention. A SECOND device — one that has
      // never reconciled anything — still reads the meeting off the server.
      const stillListed = await call(base, "/api/connectors/meetings");
      expect(stillListed.body.meetings).toHaveLength(1);
      expect(stillListed.body.meetings[0].reconciledAt).toBe(
        new Date(T0).toISOString(),
      );
      const stillReadable = await call(
        base,
        `/api/connectors/meetings/${SOURCE}/mtg-partial`,
      );
      expect(stillReadable.status).toBe(200);
      expect(stillReadable.body.meta.hasSummary).toBe(true);
      expect(stillReadable.body.meta.hasTranscript).toBe(false);

      // …and the late transcript re-opens the row for reconcile (W4 clears the stamp), so the
      // user-space copy is refreshed rather than left stale.
      await seed(h.store, {
        sourceId: "mtg-partial",
        kind: "transcript",
        text: TRANSCRIPT_TEXT,
      });
      const reopened = await call(base, "/api/connectors/meetings?reconciled=false");
      expect(reopened.body.meetings.map((m: any) => m.sourceId)).toEqual([
        "mtg-partial",
      ]);
    });
  });
});
