import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import express from "express";

import {
  CONTENT_MASTER_ENV,
  ContentStore,
  InMemoryContentBlobStore,
  _resetContentMasterCache,
  type ContentBlobStore,
  type ContentMeta,
  type SealedBlob,
  type StoredMeeting,
} from "../services/content-store.js";
import {
  MEETINGS_PAGE_SIZE_DEFAULT,
  MEETINGS_PAGE_SIZE_MAX,
  createConnectorMeetingsRouter,
  type MeetingsContentPort,
} from "../routes/connector-meetings.js";
import type { IngestMode } from "../services/ingest-mode.js";
import { _resetWebhookTokenState } from "../services/webhook-tokens.js";

/**
 * W5 — the AUTHENTICATED READ API (backend-ingest plan §8.1 W5; §9 anti-pattern 5).
 *
 * This is the surface the goal is stated in: "the meetings are always there, even if you never
 * opened the app". W3 fetched them and W4 stored them; nothing has read them back until now, and
 * a device that has never held the user's vault (or a Fireflies key) has exactly one way to see
 * a meeting — these three routes.
 *
 * W5 owns no `[delta-NN]` row of the §8.2 delta table (item 5's idempotency is W3's). What it
 * owns is **§9 anti-pattern 5 — "side-effecting GET"**, whose verification sentence is literal:
 *
 *     Test: instrument write counters; GET list/content causes zero writes.
 *
 * {@link CountingBlobStore} is that instrument, and it counts every substrate mutation the store
 * can make, not just the ones we expect. The other properties this suite pins are the ones the
 * rest of the build already established and a read surface is the classic place to lose:
 *
 *  - the tenant is ALWAYS the session address — no route takes an address, and B never sees A's
 *    meeting under any id (§8.2 delta 1 / anti-pattern 1);
 *  - the cohort gate is the credential router's, verbatim: a non-cohort address gets 404, so a
 *    signed-in user outside the dark cohort cannot tell the mount exists;
 *  - FAIL CLOSED — an unreadable cohort or an unreadable store is a 503, never an empty list
 *    rendered as "you have no meetings";
 *  - no content, no raw address and no meeting id in the clear reaches a log line, and no
 *    internal error text reaches a caller.
 */

const ORIGINAL_ENV = { ...process.env };

const SOURCE = "fireflies";
const ADDRESS_A = "0x7d033300000000000000000000000000000073f2";
const ADDRESS_B = "0xb1b1b10000000000000000000000000000001111";
const CONTENT_MASTER = "R29vZE1hc3RlckZvckNvbnRlbnRFbnZlbG9wZXNBQTA9";
const LOG_SALT = "aQ2wS3eD4rF5tG6yH7uJ8iK9oL0pZ1xC2vB3nM4kJ5h=";

/** Must never leave the TEE in the clear, and never reach a log line at all. */
const TRANSCRIPT_TEXT = "so about the Q3 layoffs — Dana said the legal review is blocking";
const SUMMARY_TEXT = "Legal review blocks the Q3 plan; Dana owns the follow-up";
const TITLE_TEXT = "Q3 planning sync (confidential)";

const T0 = Date.parse("2026-08-10T12:00:00.000Z");

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

/**
 * §9 anti-pattern 5's instrument. Every mutating method of the substrate port increments
 * {@link writes}; the read methods are pass-throughs. A GET that touches any of them fails the
 * suite — including the ones a future refactor might reach for (a "touch lastReadAt", a
 * lazy re-seal, an opportunistic sweep), which is why this counts the PORT and not the route.
 */
class CountingBlobStore implements ContentBlobStore {
  writes = 0;
  reads = 0;

  constructor(private readonly inner: InMemoryContentBlobStore) {}

  readIndex(source: string, address: string): Promise<SealedBlob | null> {
    this.reads += 1;
    return this.inner.readIndex(source, address);
  }

  writeIndex(source: string, address: string, blob: SealedBlob): Promise<void> {
    this.writes += 1;
    return this.inner.writeIndex(source, address, blob);
  }

  read(
    source: string,
    address: string,
    sourceId: string,
  ): Promise<SealedBlob | null> {
    this.reads += 1;
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
  cohort: Set<string>;
  clock: { now: number };
  session: { address: string | undefined };
}

function harness(
  options: {
    content?: MeetingsContentPort;
    modes?: { mode(address: string): Promise<IngestMode> };
    address?: string;
  } = {},
): Harness {
  const blobs = new CountingBlobStore(new InMemoryContentBlobStore());
  const clock = { now: T0 };
  const store = new ContentStore(blobs, {
    now: () => clock.now,
    master: () => CONTENT_MASTER,
  });
  const cohort = new Set<string>([ADDRESS_A.toLowerCase()]);
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
      content: options.content ?? store,
      modes: options.modes ?? {
        mode: async (address: string): Promise<IngestMode> =>
          cohort.has(address.toLowerCase()) ? "backend" : "browser",
      },
    }),
  );

  return { app, store, blobs, cohort, clock, session };
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
  body?: unknown,
): Promise<{ status: number; body: any; text: string }> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  return { status: response.status, body: parsed as any, text };
}

/** Seed one stored meeting the way the fetch worker does — through the real upsert path. */
async function seed(
  store: ContentStore,
  input: {
    address: string;
    sourceId: string;
    kind: "transcript" | "summary";
    text: string;
    title?: string;
    ts?: string;
  },
): Promise<void> {
  const result = await store.upsert({
    source: SOURCE,
    address: input.address,
    sourceId: input.sourceId,
    kind: input.kind,
    ...(input.title === undefined ? {} : { title: input.title }),
    ...(input.ts === undefined ? {} : { ts: input.ts }),
    content: { text: input.text },
    fetchedAt: new Date(T0).toISOString(),
    receivedAt: new Date(T0).toISOString(),
  });
  // Fail closed in the FIXTURE too: a seed that silently did not store would make every
  // assertion below vacuously pass.
  expect(result).toEqual({ ok: true, stored: expect.any(String) as any });
}

// ── The list GET ─────────────────────────────────────────────────────

describe("GET /api/connectors/meetings — the paginated list", () => {
  test("returns the session address's own meetings, newest first", async () => {
    const h = harness();
    await seed(h.store, {
      address: ADDRESS_A,
      sourceId: "mtg-old",
      kind: "transcript",
      text: TRANSCRIPT_TEXT,
      title: TITLE_TEXT,
      ts: "2026-08-01T09:00:00.000Z",
    });
    await seed(h.store, {
      address: ADDRESS_A,
      sourceId: "mtg-new",
      kind: "summary",
      text: SUMMARY_TEXT,
      ts: "2026-08-09T09:00:00.000Z",
    });

    await withServer(h.app, async (base) => {
      const res = await call(base, "/api/connectors/meetings");
      expect(res.status).toBe(200);
      expect(res.body.source).toBe(SOURCE);
      expect(res.body.meetings.map((m: any) => m.sourceId)).toEqual([
        "mtg-new",
        "mtg-old",
      ]);
      expect(res.body.nextCursor).toBe(null);
      expect(res.body.hasMore).toBe(false);
      // The list is METADATA. The half that arrived is reported as a flag, so the view can
      // say "summary only" without a second round trip.
      const [newest, oldest] = res.body.meetings;
      expect(newest.hasSummary).toBe(true);
      expect(newest.hasTranscript).toBe(false);
      expect(oldest.hasTranscript).toBe(true);
      expect(oldest.title).toBe(TITLE_TEXT);
    });
  });

  test("no meeting body rides the list — transcript and summary text are absent", async () => {
    const h = harness();
    await seed(h.store, {
      address: ADDRESS_A,
      sourceId: "mtg-1",
      kind: "transcript",
      text: TRANSCRIPT_TEXT,
      title: TITLE_TEXT,
    });

    await withServer(h.app, async (base) => {
      const res = await call(base, "/api/connectors/meetings");
      expect(res.status).toBe(200);
      expect(res.text).not.toContain(TRANSCRIPT_TEXT);
      expect(res.text).not.toContain(SUMMARY_TEXT);
      expect(Object.keys(res.body.meetings[0])).not.toContain("content");
    });
  });

  test("pages with an explicit cursor and never truncates silently", async () => {
    const h = harness();
    for (const n of [1, 2, 3, 4, 5]) {
      await seed(h.store, {
        address: ADDRESS_A,
        sourceId: `mtg-${n}`,
        kind: "transcript",
        text: TRANSCRIPT_TEXT,
        ts: `2026-08-0${n}T09:00:00.000Z`,
      });
    }

    await withServer(h.app, async (base) => {
      const first = await call(base, "/api/connectors/meetings?limit=2");
      expect(first.status).toBe(200);
      expect(first.body.meetings.map((m: any) => m.sourceId)).toEqual([
        "mtg-5",
        "mtg-4",
      ]);
      // A truncated page SAYS it is truncated and hands back the cursor to continue.
      expect(first.body.hasMore).toBe(true);
      expect(first.body.nextCursor).toBe("mtg-4");

      const second = await call(
        base,
        `/api/connectors/meetings?limit=2&cursor=${first.body.nextCursor}`,
      );
      expect(second.body.meetings.map((m: any) => m.sourceId)).toEqual([
        "mtg-3",
        "mtg-2",
      ]);

      const third = await call(
        base,
        `/api/connectors/meetings?limit=2&cursor=${second.body.nextCursor}`,
      );
      expect(third.body.meetings.map((m: any) => m.sourceId)).toEqual(["mtg-1"]);
      expect(third.body.hasMore).toBe(false);
      expect(third.body.nextCursor).toBe(null);
    });
  });

  test("an out-of-range limit or an unknown cursor is a 4xx, never a silent full page", async () => {
    const h = harness();
    await seed(h.store, {
      address: ADDRESS_A,
      sourceId: "mtg-1",
      kind: "transcript",
      text: TRANSCRIPT_TEXT,
    });

    await withServer(h.app, async (base) => {
      for (const limit of ["0", "-1", "abc", String(MEETINGS_PAGE_SIZE_MAX + 1)]) {
        const res = await call(base, `/api/connectors/meetings?limit=${limit}`);
        expect(res.status).toBe(400);
        expect(res.body.error).toBe("invalid_limit");
      }
      // A cursor whose row is gone (retention swept it between pages) must not restart the
      // caller at page 1 without saying so — that reads as "these are new meetings".
      const gone = await call(base, "/api/connectors/meetings?cursor=mtg-gone");
      expect(gone.status).toBe(400);
      expect(gone.body.error).toBe("invalid_cursor");
      // And a malformed one never reaches the store.
      const bad = await call(base, "/api/connectors/meetings?cursor=..%2Fetc");
      expect(bad.status).toBe(400);
    });
  });

  test("is tenant-scoped: B's session never sees A's meetings", async () => {
    const h = harness();
    h.cohort.add(ADDRESS_B.toLowerCase());
    await seed(h.store, {
      address: ADDRESS_A,
      sourceId: "mtg-a",
      kind: "transcript",
      text: TRANSCRIPT_TEXT,
      title: TITLE_TEXT,
    });

    await withServer(h.app, async (base) => {
      h.session.address = ADDRESS_B;
      const list = await call(base, "/api/connectors/meetings");
      expect(list.status).toBe(200);
      expect(list.body.meetings).toEqual([]);
      // Not even by naming A's id directly: there is no address input anywhere in the surface.
      const content = await call(base, `/api/connectors/meetings/${SOURCE}/mtg-a`);
      expect(content.status).toBe(404);
      expect(content.text).not.toContain(TRANSCRIPT_TEXT);
      expect(content.text).not.toContain(TITLE_TEXT);
    });
  });

  test("an unreadable store is a 503 — never an empty list read as 'no meetings'", async () => {
    const failing: MeetingsContentPort = {
      list: async () => {
        throw new Error("substrate unavailable: connect ECONNREFUSED 10.0.0.9:5432");
      },
      get: async () => null,
      markReconciled: async () => false,
    };
    const h = harness({ content: failing });
    const logs = captureLogs();
    try {
      await withServer(h.app, async (base) => {
        const res = await call(base, "/api/connectors/meetings");
        expect(res.status).toBe(503);
        expect(res.body.error).toBe("unavailable");
        // The internal error never reaches the caller (§9 anti-pattern 7).
        expect(res.text).not.toContain("ECONNREFUSED");
        expect(res.text).not.toContain("10.0.0.9");
      });
    } finally {
      logs.restore();
    }
  });
});

// ── The content GET ──────────────────────────────────────────────────

describe("GET /api/connectors/meetings/:source/:sourceId — the content read", () => {
  test("returns both halves for the owner, and a partial row is a 200", async () => {
    const h = harness();
    await seed(h.store, {
      address: ADDRESS_A,
      sourceId: "mtg-full",
      kind: "transcript",
      text: TRANSCRIPT_TEXT,
      title: TITLE_TEXT,
    });
    await seed(h.store, {
      address: ADDRESS_A,
      sourceId: "mtg-full",
      kind: "summary",
      text: SUMMARY_TEXT,
    });
    await seed(h.store, {
      address: ADDRESS_A,
      sourceId: "mtg-partial",
      kind: "summary",
      text: SUMMARY_TEXT,
    });

    await withServer(h.app, async (base) => {
      const full = await call(base, `/api/connectors/meetings/${SOURCE}/mtg-full`);
      expect(full.status).toBe(200);
      expect(full.body.sourceId).toBe("mtg-full");
      expect(full.body.source).toBe(SOURCE);
      expect(full.body.content.transcript).toEqual({ text: TRANSCRIPT_TEXT });
      expect(full.body.content.summary).toEqual({ text: SUMMARY_TEXT });
      expect(full.body.meta.title).toBe(TITLE_TEXT);

      // Delta 6's read half: a summary that arrived without a transcript is a COMPLETE row.
      const partial = await call(
        base,
        `/api/connectors/meetings/${SOURCE}/mtg-partial`,
      );
      expect(partial.status).toBe(200);
      expect(partial.body.content.summary).toEqual({ text: SUMMARY_TEXT });
      expect(partial.body.content.transcript).toBeUndefined();
      expect(partial.body.meta.hasTranscript).toBe(false);
    });
  });

  test("an unknown id is a short-code 404 and a malformed one never reaches the store", async () => {
    const calls: string[] = [];
    const spy: MeetingsContentPort = {
      list: async () => [],
      get: async (source, _address, sourceId) => {
        calls.push(`${source}:${sourceId}`);
        return null;
      },
      markReconciled: async () => false,
    };
    const h = harness({ content: spy });

    await withServer(h.app, async (base) => {
      const missing = await call(base, `/api/connectors/meetings/${SOURCE}/mtg-nope`);
      expect(missing.status).toBe(404);
      expect(missing.body).toEqual({ error: "not_found" });
      // The id is never echoed back — it is caller-supplied and rides into a log field.
      expect(missing.text).not.toContain("mtg-nope");
      expect(calls).toEqual([`${SOURCE}:mtg-nope`]);

      // Validation is complete BEFORE the first store call, exactly as `/ack` does it.
      calls.length = 0;
      const bogusSource = await call(base, "/api/connectors/meetings/zoom/mtg-1");
      expect(bogusSource.status).toBe(404);
      const bogusId = await call(
        base,
        `/api/connectors/meetings/${SOURCE}/${"x".repeat(65)}`,
      );
      expect(bogusId.status).toBe(400);
      expect(calls).toEqual([]);
    });
  });
});

// ── §9 anti-pattern 5 ────────────────────────────────────────────────

describe("§9 anti-pattern 5 — side-effecting GET", () => {
  test("a list GET and a content GET perform ZERO substrate writes", async () => {
    const h = harness();
    await seed(h.store, {
      address: ADDRESS_A,
      sourceId: "mtg-1",
      kind: "transcript",
      text: TRANSCRIPT_TEXT,
      title: TITLE_TEXT,
    });
    await seed(h.store, {
      address: ADDRESS_A,
      sourceId: "mtg-2",
      kind: "summary",
      text: SUMMARY_TEXT,
    });

    await withServer(h.app, async (base) => {
      // The counter is zeroed AFTER seeding: what is measured is the read surface alone.
      h.blobs.writes = 0;

      for (const path of [
        "/api/connectors/meetings",
        "/api/connectors/meetings?limit=1",
        `/api/connectors/meetings/${SOURCE}/mtg-1`,
        `/api/connectors/meetings/${SOURCE}/mtg-2`,
        `/api/connectors/meetings/${SOURCE}/mtg-missing`,
      ]) {
        const res = await call(base, path);
        expect(res.status === 200 || res.status === 404).toBe(true);
      }
      expect(h.blobs.writes).toBe(0);
      // …and they really did reach the substrate, so a zero is not "nothing happened".
      expect(h.blobs.reads).toBeGreaterThan(0);
    });
  });

  test("the ONE mutating route is a POST — no GET in the router mutates", () => {
    const ROUTES = readFileSync(
      resolve(import.meta.dir, "../routes/connector-meetings.ts"),
      "utf8",
    );
    const registrations = [
      ...ROUTES.matchAll(/router\.(get|post|put|patch|delete)\(\s*"([^"]+)"/g),
    ].map((m) => `${m[1]} ${m[2]}`);
    expect(registrations).toEqual([
      "get /",
      "get /:source/:sourceId",
      "post /:source/:sourceId/reconciled",
    ]);
    // `markReconciled` is the only mutation the router can reach, and it is not reachable
    // from a GET handler: the port hands the read surface nothing else to call.
    expect(ROUTES.match(/markReconciled/g)?.length).toBeGreaterThan(0);
  });
});

// ── The reconcile-ack (the one mutating route) ───────────────────────

describe("POST /api/connectors/meetings/:source/:sourceId/reconciled", () => {
  test("stamps reconciledAt so W6 stops re-reconciling, and is idempotent", async () => {
    const h = harness();
    await seed(h.store, {
      address: ADDRESS_A,
      sourceId: "mtg-1",
      kind: "transcript",
      text: TRANSCRIPT_TEXT,
    });

    await withServer(h.app, async (base) => {
      const before = await call(base, "/api/connectors/meetings");
      expect(before.body.meetings[0].reconciledAt).toBeUndefined();

      h.clock.now = T0 + 60_000;
      const ack = await call(
        base,
        `/api/connectors/meetings/${SOURCE}/mtg-1/reconciled`,
        "POST",
        {},
      );
      expect(ack.status).toBe(200);
      expect(ack.body.reconciled).toBe(true);

      const after = await call(base, "/api/connectors/meetings");
      expect(after.body.meetings[0].reconciledAt).toBe(
        new Date(T0 + 60_000).toISOString(),
      );

      // The lost-response retry is a SUCCESS, exactly as `/ack` treats a settled identity.
      const again = await call(
        base,
        `/api/connectors/meetings/${SOURCE}/mtg-1/reconciled`,
        "POST",
        {},
      );
      expect(again.status).toBe(200);
      expect(again.body.reconciled).toBe(true);

      // D2a `retain`: reconcile does NOT delete the server copy — a second device still reads it.
      const content = await call(base, `/api/connectors/meetings/${SOURCE}/mtg-1`);
      expect(content.status).toBe(200);
      expect(content.body.content.transcript).toEqual({ text: TRANSCRIPT_TEXT });
    });
  });

  test("an unknown id stamps nothing and answers 404", async () => {
    const h = harness();
    await withServer(h.app, async (base) => {
      const res = await call(
        base,
        `/api/connectors/meetings/${SOURCE}/mtg-nope/reconciled`,
        "POST",
        {},
      );
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: "not_found" });
    });
  });

  test("another tenant's meeting cannot be stamped from B's session", async () => {
    const h = harness();
    h.cohort.add(ADDRESS_B.toLowerCase());
    await seed(h.store, {
      address: ADDRESS_A,
      sourceId: "mtg-a",
      kind: "transcript",
      text: TRANSCRIPT_TEXT,
    });

    await withServer(h.app, async (base) => {
      h.session.address = ADDRESS_B;
      const res = await call(
        base,
        `/api/connectors/meetings/${SOURCE}/mtg-a/reconciled`,
        "POST",
        {},
      );
      expect(res.status).toBe(404);

      h.session.address = ADDRESS_A;
      const list = await call(base, "/api/connectors/meetings");
      expect(list.body.meetings[0].reconciledAt).toBeUndefined();
    });
  });

  test("a failed stamp is a 503 — never a reconciled:true the store did not make", async () => {
    const h = harness({
      content: {
        list: async () => [],
        get: async () => null,
        markReconciled: async () => {
          throw new Error("index write rejected");
        },
      },
    });
    const logs = captureLogs();
    try {
      await withServer(h.app, async (base) => {
        const res = await call(
          base,
          `/api/connectors/meetings/${SOURCE}/mtg-1/reconciled`,
          "POST",
          {},
        );
        expect(res.status).toBe(503);
        expect(res.body.error).toBe("unavailable");
        expect(res.text).not.toContain("index write rejected");
      });
    } finally {
      logs.restore();
    }
  });
});

// ── The cohort gate (identical to W2's) ──────────────────────────────

describe("cohort gating", () => {
  test("a non-cohort address gets 404 on every route — the mount stays invisible", async () => {
    const h = harness();
    await seed(h.store, {
      address: ADDRESS_B,
      sourceId: "mtg-b",
      kind: "transcript",
      text: TRANSCRIPT_TEXT,
    });

    await withServer(h.app, async (base) => {
      h.session.address = ADDRESS_B; // stored meetings, but NOT in the cohort
      for (const [path, method] of [
        ["/api/connectors/meetings", "GET"],
        [`/api/connectors/meetings/${SOURCE}/mtg-b`, "GET"],
        [`/api/connectors/meetings/${SOURCE}/mtg-b/reconciled`, "POST"],
      ] as const) {
        const res = await call(base, path, method, method === "POST" ? {} : undefined);
        expect(res.status).toBe(404);
        expect(res.body).toEqual({ error: "not_found" });
      }
    });
  });

  test("no modes collaborator means no address is enrolled — 404, not an open read API", async () => {
    const blobs = new CountingBlobStore(new InMemoryContentBlobStore());
    const store = new ContentStore(blobs, {
      now: () => T0,
      master: () => CONTENT_MASTER,
    });
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = { address: ADDRESS_A };
      next();
    });
    app.use(
      "/api/connectors/meetings",
      createConnectorMeetingsRouter({ content: store }),
    );

    await withServer(app, async (base) => {
      const res = await call(base, "/api/connectors/meetings");
      expect(res.status).toBe(404);
    });
  });

  test("an unreadable cohort is a 503 — never 'treat them as not enrolled'", async () => {
    const h = harness({
      modes: {
        mode: async () => {
          throw new Error("cohort key unreadable");
        },
      },
    });
    const logs = captureLogs();
    try {
      await withServer(h.app, async (base) => {
        const res = await call(base, "/api/connectors/meetings");
        expect(res.status).toBe(503);
        expect(res.text).not.toContain("cohort key unreadable");
      });
    } finally {
      logs.restore();
    }
  });

  test("a request with no session address is a 401, never an anonymous read", async () => {
    const h = harness();
    h.session.address = undefined;
    await withServer(h.app, async (base) => {
      const res = await call(base, "/api/connectors/meetings");
      expect(res.status).toBe(401);
    });
  });
});

// ── Redaction (§9 anti-pattern 7 / plan §8.1 W8's rules, applied here) ──

describe("redaction", () => {
  test("no content, no raw address and no raw meeting id reaches a log line", async () => {
    const h = harness();
    await seed(h.store, {
      address: ADDRESS_A,
      sourceId: "mtg-secret",
      kind: "transcript",
      text: TRANSCRIPT_TEXT,
      title: TITLE_TEXT,
    });

    const logs = captureLogs();
    try {
      await withServer(h.app, async (base) => {
        await call(base, "/api/connectors/meetings");
        await call(base, `/api/connectors/meetings/${SOURCE}/mtg-secret`);
        await call(
          base,
          `/api/connectors/meetings/${SOURCE}/mtg-secret/reconciled`,
          "POST",
          {},
        );
        await call(base, `/api/connectors/meetings/${SOURCE}/mtg-missing`);
      });
    } finally {
      logs.restore();
    }

    const joined = logs.lines.join("\n");
    for (const forbidden of [
      TRANSCRIPT_TEXT,
      SUMMARY_TEXT,
      TITLE_TEXT,
      ADDRESS_A,
      ADDRESS_A.toLowerCase(),
      "mtg-secret",
      "mtg-missing",
    ]) {
      expect(joined).not.toContain(forbidden);
    }
  });
});

// ── The mount (house idiom: source assertions for wiring a bun test cannot boot) ──

describe("index.ts wiring", () => {
  const INDEX = readFileSync(resolve(import.meta.dir, "../index.ts"), "utf8");

  test("mounts behind authMiddleware, inside the dark ingest flag", () => {
    expect(INDEX).toMatch(
      /app\.use\(\s*\n?\s*"\/api\/connectors\/meetings",\s*\n?\s*authMiddleware,/,
    );
    expect(INDEX).toContain("createConnectorMeetingsRouter({");
    // The mount lives inside the same `backendIngestEnabled()` block the credential surface
    // does: a deployment with the flag dark has no meetings surface at all.
    const flagIndex = INDEX.indexOf("if (backendIngestEnabled())");
    const mountIndex = INDEX.indexOf('"/api/connectors/meetings"');
    expect(flagIndex).toBeGreaterThan(-1);
    expect(mountIndex).toBeGreaterThan(flagIndex);
  });

  test("the read API shares ONE ContentStore instance with the rest of the build", () => {
    // Two instances = two sets of per-tenant lanes over one substrate, which is the
    // interleaved read-modify-write W4's lanes exist to prevent.
    expect(INDEX.match(/new ContentStore\(/g)?.length ?? 0).toBe(1);
  });
});

// ── The published contract ───────────────────────────────────────────

describe("openapi.yaml", () => {
  const SPEC = readFileSync(
    resolve(import.meta.dir, "../../openapi.yaml"),
    "utf8",
  );

  test("publishes all three routes, and never an address parameter", () => {
    for (const path of [
      "  /api/connectors/meetings:",
      "  /api/connectors/meetings/{source}/{sourceId}:",
      "  /api/connectors/meetings/{source}/{sourceId}/reconciled:",
    ]) {
      expect(SPEC).toContain(path);
    }
    // The tenant is the session. A documented address parameter is how a
    // tenant-scoped surface stops being one.
    const meetingsBlock = SPEC.slice(SPEC.indexOf("  /api/connectors/meetings:"));
    expect(meetingsBlock.slice(0, 4000)).not.toContain("name: address");
  });

  test("documents the read routes as authenticated — never `security: []`", () => {
    const start = SPEC.indexOf("  /api/connectors/meetings:");
    const end = SPEC.indexOf("components:", start);
    const block = SPEC.slice(start, end);
    expect(block).not.toContain("security: []");
    // The 404 that hides the surface is part of the contract, not an accident.
    expect(block).toContain("not in the cohort");
  });
});

// ── Type-level guards ────────────────────────────────────────────────

describe("the read port", () => {
  test("exposes exactly three methods — no delete, no purge, no enumerate-all", () => {
    // A read API that can reach `purge` or an untenanted list is one refactor away from
    // being the surface that leaks or destroys another tenant's archive.
    const port: MeetingsContentPort = {
      list: async (): Promise<ContentMeta[]> => [],
      get: async (): Promise<StoredMeeting | null> => null,
      markReconciled: async (): Promise<boolean> => false,
    };
    expect(Object.keys(port).sort()).toEqual(["get", "list", "markReconciled"]);
    expect(MEETINGS_PAGE_SIZE_DEFAULT).toBeLessThanOrEqual(MEETINGS_PAGE_SIZE_MAX);
  });
});
