import { createHmac } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import express from "express";

import {
  ConnectorWebhookLimiters,
  createConnectorWebhookHandler,
  createConnectorWebhookHostGuard,
  createConnectorWebhookParserErrorHandler,
  resolveWebhookHostAllowlist,
} from "../routes/connector-webhooks.js";
import {
  ConnectorFetchWorker,
  _resetFetchWorkerSingleton,
} from "../services/fetch-worker.js";
import type {
  ContentUpsertInput,
  ContentUpsertResult,
  MeetingFetchRequest,
  MeetingFetchResult,
} from "../services/fetch-worker.js";
import type {
  PendingItem,
  SettleOutcome,
  SettleResult,
} from "../services/connector-queue.js";
import type { CredentialSecret } from "../services/credential-store.js";
import { BACKEND_INGEST_FLAG } from "../services/ingest-mode.js";
import {
  _resetFetchWorkerNudge,
  createIngestOnDelivery,
} from "../services/ingest-nudge.js";
import {
  _resetWebhookTokenState,
  deriveWebhookSecret,
  generateWebhookToken,
  type WebhookTokenRecord,
} from "../services/webhook-tokens.js";

/**
 * W9 — **Gate 5: provider + surface hardening** (backend-ingest plan §10; §8.1 W9).
 *
 * Two things live here, and neither is a re-run of a delta test:
 *
 *  1. **2xx < 10 s under a stubbed slow UPSTREAM.** `[delta-07]` proves the *nudge* cannot delay
 *     the 202. This proves it end to end with the REAL fetch worker registered on the seam and a
 *     Fireflies fetcher that takes 30 s: the delivery is acked while the fetch is still in
 *     flight, which is the shape Fireflies' own 10 s window requires and the shape Listen got
 *     wrong (§9 anti-pattern 2).
 *  2. **The Gate 5 checklist is an artifact, not a feeling.** Plan §4 says every gate exits with a
 *     written artifact; §10 lists six items. The checklist file has to name each one and point at
 *     evidence that actually exists — a checklist citing a deleted test is worse than no
 *     checklist.
 */

const SOURCE = "fireflies";
const ADDRESS = "0x7d033300000000000000000000000000000073f2";
const MASTER = "3H8Qk0m2yq1sZ0VjK5xPwq0nA6oJ2bL9dR4tW7uY1cM=";
const LOG_SALT = "aQ2wS3eD4rF5tG6yH7uJ8iK9oL0pZ1xC2vB3nM4kJ5h=";
const REPO_ROOT = resolve(import.meta.dir, "../../..");
const CHECKLIST = resolve(REPO_ROOT, "docs/connector-webhooks-gate5-checklist.md");

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  _resetWebhookTokenState();
  _resetFetchWorkerNudge();
  _resetFetchWorkerSingleton();
  process.env.WEBHOOK_HMAC_MASTER = MASTER;
  process.env.LOG_HASH_SALT = LOG_SALT;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  _resetWebhookTokenState();
  _resetFetchWorkerNudge();
  _resetFetchWorkerSingleton();
});

// ── Harness ──────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((done) => {
    const timer = setTimeout(done, ms);
    (timer as unknown as { unref?: () => void }).unref?.();
  });
}

/** Enqueue for the route, `due`/`settle` for the worker — one in-memory queue for both. */
class MemoryQueue {
  readonly items: PendingItem[] = [];

  async enqueue(
    _source: string,
    _address: string,
    input: { meetingId: string; kind: PendingItem["kind"]; receivedAt: string },
  ) {
    this.items.push({
      meetingId: input.meetingId,
      kind: input.kind,
      receivedAt: input.receivedAt,
      attempts: 0,
      nextAttemptAt: input.receivedAt,
    });
    return { status: "queued" as const, depth: this.items.length };
  }

  async due(): Promise<PendingItem[]> {
    return [...this.items];
  }

  async settle(
    _source: string,
    _address: string,
    outcomes: SettleOutcome[],
  ): Promise<SettleResult[]> {
    return outcomes.map((outcome) => ({
      meetingId: outcome.meetingId,
      kind: outcome.kind,
      disposition: "removed" as SettleResult["disposition"],
      attempts: 1,
      nextAttemptAt: null,
    }));
  }
}

class FakeTokenStore {
  readonly records = new Map<string, WebhookTokenRecord>();

  register(token: string, address: string): string {
    this.records.set(token, {
      address: address.toLowerCase(),
      source: SOURCE,
      createdAt: new Date(0).toISOString(),
    });
    return token;
  }

  async lookup(token: unknown): Promise<WebhookTokenRecord | null> {
    return typeof token === "string" ? (this.records.get(token) ?? null) : null;
  }
}

async function withServer<T>(
  app: express.Express,
  fn: (base: string) => Promise<T>,
): Promise<T> {
  const server = await new Promise<import("http").Server>((done) => {
    const instance = app.listen(0, () => done(instance));
  });
  const { port } = server.address() as { port: number };
  try {
    return await fn(`http://localhost:${port}`);
  } finally {
    await new Promise<void>((done, fail) =>
      server.close((error) => (error ? fail(error) : done())),
    );
  }
}

// ── 1. The 10-second window, with the worker actually wired ──────────

describe("W9 / Gate 5 — 2xx < 10 s under a stubbed slow upstream", () => {
  test("a 30 s Fireflies fetch does not touch the delivery window: the 202 lands while the fetch is still open", async () => {
    process.env[BACKEND_INGEST_FLAG] = "true";

    const queue = new MemoryQueue();
    const tokens = new FakeTokenStore();
    const token = tokens.register(generateWebhookToken(), ADDRESS);

    let fetchStartedAt: number | null = null;
    let fetchFinished = false;
    const worker = new ConnectorFetchWorker({
      queue,
      modes: {
        cohort: async () => new Set([ADDRESS]),
        mode: async () => "backend" as const,
      },
      credentials: {
        getCredential: async (): Promise<CredentialSecret> => ({
          kind: "oauth",
          accessToken: "not-a-real-token",
        }),
      },
      fetcher: {
        // The stubbed SLOW upstream. 30 s is the worker's own fetch ceiling, i.e. the worst case
        // a provider can impose on us.
        async fetchMeeting(request: MeetingFetchRequest): Promise<MeetingFetchResult> {
          fetchStartedAt = Date.now();
          await sleep(30_000);
          fetchFinished = true;
          return {
            ok: true,
            content: { sourceId: request.meetingId, payload: { ok: true } },
          };
        },
      },
      content: {
        async upsert(_input: ContentUpsertInput): Promise<ContentUpsertResult> {
          return { ok: true, stored: "created" };
        },
      },
    });
    worker.start();

    const limiters = new ConnectorWebhookLimiters();
    const app = express();
    app.set("trust proxy", 1);
    app.post(
      "/api/connectors/webhooks/:source/:token",
      // Both W9 controls on the same chain, in production order.
      createConnectorWebhookHostGuard({
        allowlist: resolveWebhookHostAllowlist({} as NodeJS.ProcessEnv),
        limiters,
      }),
      limiters.ipPreLimiter,
      express.raw({ type: "application/json", limit: "64kb", inflate: false }),
      createConnectorWebhookParserErrorHandler(limiters),
      createConnectorWebhookHandler({
        tokens,
        queue,
        limiters,
        onDelivery: createIngestOnDelivery({
          modes: {
            mode: async () => "backend" as const,
          },
          worker: () => worker,
        }),
      }),
    );

    try {
      await withServer(app, async (base) => {
        const raw = JSON.stringify({
          meetingId: "01SLOWUPSTREAM000001",
          eventType: "Transcription completed",
          timestamp: new Date().toISOString(),
        });
        const signature = `sha256=${createHmac(
          "sha256",
          deriveWebhookSecret(SOURCE, token),
        )
          .update(Buffer.from(raw))
          .digest("hex")}`;

        const started = Date.now();
        const response = await fetch(
          `${base}/api/connectors/webhooks/${SOURCE}/${token}`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-hub-signature": signature,
            },
            body: raw,
          },
        );
        const elapsed = Date.now() - started;

        expect(response.status).toBe(202);
        expect(elapsed).toBeLessThan(10_000);
        // The durable capture happened BEFORE the ack — that is what the 202 actually promises.
        expect(queue.items).toHaveLength(1);
      });

      // Give the post-ack seam a turn, then prove the fetch is genuinely still open: the ack was
      // not "fast because nothing was scheduled".
      await sleep(50);
      expect(fetchStartedAt).not.toBeNull();
      expect(fetchFinished).toBe(false);
    } finally {
      worker.stop();
    }
  });
});

// ── 2. The gate's written artifact ───────────────────────────────────

describe("W9 / Gate 5 — the checklist artifact", () => {
  test("every §10 item is on the checklist, with a verdict", () => {
    expect(existsSync(CHECKLIST)).toBe(true);
    const doc = readFileSync(CHECKLIST, "utf8");

    for (const item of [
      "2xx < 10 s",
      "X-Hub-Signature",
      "V-b",
      "Owns-only",
      "Host-header allowlist",
      "Accept-path defense-in-depth",
    ]) {
      expect({ item, present: doc.includes(item) }).toEqual({
        item,
        present: true,
      });
    }
  });

  test("every evidence path the checklist cites actually exists", () => {
    const doc = readFileSync(CHECKLIST, "utf8");
    const cited = [...doc.matchAll(/`((?:backend|frontend|docs)\/[\w./-]+)`/g)].map(
      (match) => match[1],
    );

    // A checklist with no citations would pass a "no broken citation" test vacuously.
    expect(cited.length).toBeGreaterThanOrEqual(6);
    for (const path of new Set(cited)) {
      expect({ path, exists: existsSync(resolve(REPO_ROOT, path)) }).toEqual({
        path,
        exists: true,
      });
    }
  });

  test("the checklist records the V-b verdict and the amendment that closed it, not a hope", () => {
    const doc = readFileSync(CHECKLIST, "utf8");

    // DECISIONS records V-b as `risk-deferred`: the derived secret was 43 chars against a 16–32
    // char provider field. The checklist has to say what was DONE about it.
    expect(doc).toContain("16–32");
    expect(doc).toContain("43");
    expect(doc).toContain("risk-deferred");
    expect(doc).toContain("backend/src/__tests__/webhook-secret-length.test.ts");
  });

  test("owns-only is recorded, and no shipped consent sentence promises team-wide capture", () => {
    const doc = readFileSync(CHECKLIST, "utf8");
    // §10: normal Fireflies webhooks fire only for meetings the USER OWNS; team-wide capture
    // needs Enterprise. It bounds what "always there" can honestly promise, so it is written down
    // where the promise is made…
    expect(doc).toMatch(/owns/i);
    expect(doc).toContain("Enterprise");

    // …and the shipped copy is checked against it, negatively: nothing may imply every meeting a
    // user is merely invited to.
    const copy = readFileSync(
      resolve(REPO_ROOT, "frontend/src/lib/connectors/consentCopy.ts"),
      "utf8",
    );
    for (const overclaim of [
      /every meeting (?:in|on|from) your (?:team|workspace|organi[sz]ation)/i,
      /all (?:your )?team meetings/i,
      /team-wide/i,
      /everyone'?s meetings/i,
    ]) {
      expect({ overclaim: overclaim.source, found: overclaim.test(copy) }).toEqual({
        overclaim: overclaim.source,
        found: false,
      });
    }
  });

  test("it does not claim the host allowlist is an authentication boundary", () => {
    const doc = readFileSync(CHECKLIST, "utf8");
    // The HMAC is the boundary; the ingress hop count is UNDETERMINED
    // (docs/connector-webhooks-trust-proxy.md). Overclaiming here is how a control gets trusted
    // for something it cannot do.
    expect(doc).toMatch(/not an authentication boundary/i);
    expect(doc).toContain("docs/connector-webhooks-trust-proxy.md");
  });
});
