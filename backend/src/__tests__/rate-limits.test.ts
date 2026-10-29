import { describe, expect, it } from "bun:test";
import cors from "cors";
import express from "express";
import { issueSessionToken } from "@tinyboilerplate/server";
import { appCorsOptions } from "../cors-origins.js";
import {
  applyRateLimiters,
  ASSEMBLYAI_HOSTED_UPLOAD_LIMIT,
  AUTH_LIMIT,
  bucketFor,
  CALENDAR_AUTOJOIN_LIMIT,
  CALENDAR_AUTOJOIN_MUTATION_LIMIT,
  CALENDAR_AUTOJOIN_PATHS,
  CONNECTOR_COMPANION_LIMIT,
  DELEGATION_LIMIT,
  GLOBAL_LIMIT,
  GlobalBucketRouteCounter,
  GOOGLE_OAUTH_LIMIT,
  GOOGLE_OAUTH_PATHS,
  PAID_CHAT_LIMIT,
  PAID_CHAT_PATHS,
  PRIVATE_CLOUD_TRANSCRIPTION_LIMIT,
  PRIVATE_CLOUD_TRANSCRIPTION_MUTATION_LIMIT,
  PRIVATE_CLOUD_TRANSCRIPTION_PATHS,
  AGGREGATE_LIMITS,
  SESSION_LIMITS,
  SHARED_KEY_HEADROOM,
  TRANSCRIBER_LIMIT,
  VERIFICATION_LIMIT,
} from "../rate-limits.js";

const SESSION_KEY = "synthetic-session-signing-key";

const realFetch = globalThis.fetch;

function buildApp() {
  const app = express();
  applyRateLimiters(app, { sessionKey: SESSION_KEY });
  app.get("/api/signature/:id", (_req, res) => res.json({ ok: true }));
  app.get("/api/attestation/self", (_req, res) => res.json({ ok: true }));
  app.post("/api/chat", (_req, res) => res.json({ ok: true }));
  app.get("/api/manifest", (_req, res) => res.json({ ok: true }));
  return app;
}

async function withServer<T>(
  app: express.Express,
  fn: (port: number) => Promise<T>,
): Promise<T> {
  const server = await new Promise<import("http").Server>((resolve) => {
    const instance = app.listen(0, () => resolve(instance));
  });
  const { port } = server.address() as { port: number };
  try {
    return await fn(port);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

/** `RateLimit: limit=…, remaining=…, reset=…` (draft-7), or null when no limiter ran. */
function rateLimitHeader(r: Response): { limit: number; remaining: number } | null {
  const header = r.headers.get("ratelimit");
  if (!header) return null;
  const limit = /limit=(\d+)/.exec(header);
  const remaining = /remaining=(\d+)/.exec(header);
  if (!limit || !remaining) throw new Error(`unparseable RateLimit header: ${header}`);
  return { limit: Number(limit[1]), remaining: Number(remaining[1]) };
}

describe("rate limiters (ST5)", () => {
  it("configures one-hop proxy trust before registering IP-based limiters", () => {
    const app = express();
    applyRateLimiters(app, { sessionKey: SESSION_KEY });
    expect(app.get("trust proxy")).toBe(1);
  });

  it("verification traffic does NOT exhaust the /api/chat bucket", async () => {
    const app = buildApp();
    await withServer(app, async (port) => {
      // 130 verification hits — over the global 120 limit, but the verification
      // bucket (600) is separate and the global limiter skips these paths.
      for (let i = 0; i < 130; i++) {
        const path = i % 2 === 0 ? `/api/signature/x${i}` : "/api/attestation/self";
        const r = await realFetch(`http://localhost:${port}${path}`);
        expect(r.status).toBe(200);
      }
      // Every hit counted in the verification bucket only…
      const verification = await realFetch(`http://localhost:${port}/api/attestation/self`);
      expect(rateLimitHeader(verification)).toEqual({ limit: VERIFICATION_LIMIT, remaining: VERIFICATION_LIMIT - 131 });
      // …and none in the chat or global buckets.
      const chat = await realFetch(`http://localhost:${port}/api/chat`, { method: "POST" });
      expect(chat.status).toBe(200);
      expect(rateLimitHeader(chat)).toEqual({ limit: PAID_CHAT_LIMIT, remaining: PAID_CHAT_LIMIT - 1 });
      const manifest = await realFetch(`http://localhost:${port}/api/manifest`);
      expect(rateLimitHeader(manifest)).toEqual({ limit: GLOBAL_LIMIT, remaining: GLOBAL_LIMIT - 1 });
    });
  });

  it("the global limiter still 429s after its own limit", async () => {
    const app = buildApp();
    await withServer(app, async (port) => {
      for (let i = 0; i < GLOBAL_LIMIT; i++) {
        const r = await realFetch(`http://localhost:${port}/api/manifest`);
        expect(r.status).toBe(200);
      }
      const over = await realFetch(`http://localhost:${port}/api/manifest`);
      expect(over.status).toBe(429);
    });
  });

  it("does not exempt verification-prefix lookalike paths from the global limiter", async () => {
    const app = express();
    applyRateLimiters(app, { sessionKey: SESSION_KEY });
    app.get("/api/signature-anything", (_req, res) => res.json({ ok: true }));

    await withServer(app, async (port) => {
      for (let i = 0; i < GLOBAL_LIMIT; i++) {
        const r = await realFetch(`http://localhost:${port}/api/signature-anything`);
        expect(r.status).toBe(200);
      }
      const over = await realFetch(`http://localhost:${port}/api/signature-anything`);
      expect(over.status).toBe(429);
    });
  });
});

/**
 * The Google Meet OAuth proxy's own bucket (gmeet plan §4.1 / §6 WP-A). Same failure this file
 * exists for, one surface further: the five routes mount AFTER `applyRateLimiters`, so without a
 * dedicated bucket a consent dance and a couple of reconnects would spend `/api/chat`'s global
 * 120/15min allowance — and `streamChat` treats a 429 as fatal.
 */
describe("google oauth rate limit bucket (WP-A)", () => {
  function buildGoogleApp() {
    const app = express();
    applyRateLimiters(app, { sessionKey: SESSION_KEY });
    app.get("/api/connectors/google/oauth/start", (_req, res) => res.json({ ok: true }));
    app.post("/api/connectors/google/oauth/exchange", (_req, res) => res.json({ ok: true }));
    app.post("/api/chat", (_req, res) => res.json({ ok: true }));
    return app;
  }

  it("is mounted on exactly the OAuth prefix and is far smaller than the global bucket", () => {
    // The mount path is the wiring contract index.ts pins from the other side; a rename on one
    // side only would silently hand the dance back to `globalLimiter`.
    expect(GOOGLE_OAUTH_PATHS).toEqual(["/api/connectors/google/oauth"]);
    // Deliberately the one SMALL bucket here: `/start` is an open 302 and `/callback` renders a
    // page, both unauthenticated, so the ceiling is a real control rather than a formality.
    expect(GOOGLE_OAUTH_LIMIT).toBeLessThan(GLOBAL_LIMIT);
    expect(GOOGLE_OAUTH_LIMIT).toBeGreaterThanOrEqual(30);
  });

  it("an exhausted OAuth bucket 429s the dance and leaves /api/chat untouched", async () => {
    const app = buildGoogleApp();
    await withServer(app, async (port) => {
      const base = `http://localhost:${port}/api/connectors/google/oauth`;
      for (let i = 0; i < GOOGLE_OAUTH_LIMIT; i++) {
        const r =
          i % 2 === 0
            ? await realFetch(`${base}/start`)
            : await realFetch(`${base}/exchange`, { method: "POST" });
        expect(r.status).toBe(200);
      }
      // The bucket is its own ceiling…
      const over = await realFetch(`${base}/start`);
      expect(over.status).toBe(429);
      // …and none of those requests was counted against the bucket /api/chat shares, which is
      // the whole point: the global limiter must SKIP this prefix, not merely under-count it.
      const chat = await realFetch(`http://localhost:${port}/api/chat`, { method: "POST" });
      expect(chat.status).toBe(200);
    });
  });

  it("does not exempt OAuth-prefix lookalike paths from the global limiter", async () => {
    // `…/oauth-anything` is not the mount and not a child of it, so it must fall back to the
    // global bucket rather than borrow the OAuth exemption on a string-prefix technicality.
    const app = express();
    applyRateLimiters(app, { sessionKey: SESSION_KEY });
    app.get("/api/connectors/google/oauth-anything", (_req, res) => res.json({ ok: true }));

    await withServer(app, async (port) => {
      const path = "/api/connectors/google/oauth-anything";
      for (let i = 0; i < GLOBAL_LIMIT; i++) {
        const r = await realFetch(`http://localhost:${port}${path}`);
        expect(r.status).toBe(200);
      }
      const over = await realFetch(`http://localhost:${port}${path}`);
      expect(over.status).toBe(429);
    });
  });
});


describe("Calendar autojoin rate limit bucket", () => {
  it("isolates authenticated status polling from chat and popup OAuth limits", async () => {
    const app = express();
    applyRateLimiters(app, { sessionKey: SESSION_KEY });
    expect(CALENDAR_AUTOJOIN_PATHS).toEqual(["/api/connectors/google/autojoin"]);
    app.get("/api/connectors/google/autojoin/status", (_req, res) => res.json({ ok: true }));
    app.get("/api/connectors/google/oauth/start", (_req, res) => res.json({ ok: true }));
    app.post("/api/chat", (_req, res) => res.json({ ok: true }));
    await withServer(app, async port => {
      const base = `http://localhost:${port}`;
      for (let i = 0; i < CALENDAR_AUTOJOIN_LIMIT; i++) {
        expect((await realFetch(`${base}/api/connectors/google/autojoin/status`)).status).toBe(200);
      }
      expect((await realFetch(`${base}/api/connectors/google/autojoin/status`)).status).toBe(429);
      expect((await realFetch(`${base}/api/connectors/google/oauth/start`)).status).toBe(200);
      expect((await realFetch(`${base}/api/chat`, { method: "POST" })).status).toBe(200);
    });
  });
});

/**
 * 2026-10-14 incident: every client reaches the backend from the gateway's one address, so each
 * bucket is shared by all users. One browser with a running Private job made ~150-200 requests a
 * window and 429'd everyone. Until per-client keying lands, polling ceilings carry headroom for
 * 20-30 concurrent users, paid and consent routes keep small fixed ceilings, and liveness probes
 * sit outside every bucket.
 */
describe("shared-key interim headroom", () => {
  // Clarissa's measurement: peak requests per 15-min window from ONE ordinary browser with one
  // running Private job.
  const PEAK_PER_BROWSER = 148;

  it("the global ceiling fits 30 active browsers behind one shared key", async () => {
    expect(GLOBAL_LIMIT).toBe(6000);
    expect(GLOBAL_LIMIT).toBeGreaterThanOrEqual(30 * PEAK_PER_BROWSER);
    const app = buildApp();
    await withServer(app, async (port) => {
      const r = await realFetch(`http://localhost:${port}/api/manifest`);
      expect(rateLimitHeader(r)).toEqual({ limit: GLOBAL_LIMIT, remaining: GLOBAL_LIMIT - 1 });
    });
  });

  it("pins every bucket constant: polling budgets scaled, paid and consent routes fixed", () => {
    expect(SHARED_KEY_HEADROOM).toBe(50);
    // Scaled polling and read budgets.
    expect(GLOBAL_LIMIT).toBe(120 * SHARED_KEY_HEADROOM);
    expect(VERIFICATION_LIMIT).toBe(600 * SHARED_KEY_HEADROOM);
    expect(CONNECTOR_COMPANION_LIMIT).toBe(600 * SHARED_KEY_HEADROOM);
    expect(TRANSCRIBER_LIMIT).toBe(600 * SHARED_KEY_HEADROOM);
    expect(PRIVATE_CLOUD_TRANSCRIPTION_LIMIT).toBe(600 * SHARED_KEY_HEADROOM);
    expect(ASSEMBLYAI_HOSTED_UPLOAD_LIMIT).toBe(480 * SHARED_KEY_HEADROOM);
    // Fixed: spend, consent and mutations.
    expect(PAID_CHAT_LIMIT).toBe(600);
    expect(GOOGLE_OAUTH_LIMIT).toBe(150);
    expect(PRIVATE_CLOUD_TRANSCRIPTION_MUTATION_LIMIT).toBe(300);
    expect(CALENDAR_AUTOJOIN_LIMIT).toBe(3000);
    expect(CALENDAR_AUTOJOIN_MUTATION_LIMIT).toBe(150);
    expect(DELEGATION_LIMIT).toBe(600);
    // Session minting: one bucket whatever the bearer (auth-mint-rate-limit.test.ts).
    expect(AUTH_LIMIT).toBe(1200);
  });

  it("classifies a path matrix into exactly one bucket, case-insensitively", () => {
    const cases: [string, string, ReturnType<typeof bucketFor>][] = [
      // health: exact, optional trailing slash, any case; never a prefix
      ["GET", "/health", "none"],
      ["GET", "/health/", "none"],
      ["HEAD", "/HEALTH", "none"],
      ["GET", "/Health/", "none"],
      ["GET", "/health/anything", "global"],
      ["GET", "/health/../api/chat", "global"],
      ["POST", "/health/../api/chat", "global"],
      ["GET", "/healthz", "global"],
      ["GET", "/health//", "global"],
      // paid chat: POST to the two send routes only
      ["POST", "/api/chat", "paidChat"],
      ["POST", "/api/chat/", "paidChat"],
      ["POST", "/API/CHAT", "paidChat"],
      ["POST", "/api/agent/chat", "paidChat"],
      ["POST", "/Api/Agent/Chat/", "paidChat"],
      ["POST", "/api/chat//", "paidChat"],
      ["POST", "/api/agent//chat", "paidChat"],
      ["POST", "//api//chat//", "paidChat"],
      ["GET", "/api/chat//", "global"],
      ["POST", "/api/agent//session", "global"],
      ["GET", "/api//transcriber//private-cloud/x", "privateCloudTranscription"],
      ["GET", "/api/chat/models", "global"],
      ["POST", "/api/chat/models", "global"],
      ["GET", "/api/agent/session", "global"],
      ["POST", "/api/chatty", "global"],
      ["POST", "/api/./chat", "global"],
      // private cloud: nested in the transcriber prefix, reads vs mutations, slash boundaries
      ["GET", "/api/transcriber/private-cloud/transcriptions/j1", "privateCloudTranscription"],
      ["GET", "/API/TRANSCRIBER/PRIVATE-CLOUD/transcriptions/j1", "privateCloudTranscription"],
      ["GET", "/api/Transcriber/Private-Cloud", "privateCloudTranscription"],
      ["POST", "/api/transcriber/private-cloud/transcriptions", "privateCloudTranscriptionMutation"],
      ["POST", "/API/transcriber/PRIVATE-cloud/transcriptions/j1/cancel", "privateCloudTranscriptionMutation"],
      ["DELETE", "/api/transcriber/private-cloud/transcriptions/j1", "privateCloudTranscriptionMutation"],
      ["GET", "/api/transcriber/private-cloudish", "transcriber"],
      ["GET", "/api/transcriber/PRIVATE-CLOUDISH/x", "transcriber"],
      ["GET", "/api/transcriber/meetings", "transcriber"],
      ["GET", "/API/TRANSCRIBER/MEETINGS", "transcriber"],
      ["PUT", "/api/transcriber/assemblyai/hosted/uploads/u1/parts/1", "hostedUpload"],
      ["PUT", "/API/Transcriber/AssemblyAI/Hosted/Uploads/u1", "hostedUpload"],
      ["GET", "/api/transcriber/assemblyai/hosted/transcripts/t1", "transcriber"],
      ["GET", "/api/transcriberx", "global"],
      // calendar: reads vs setup
      ["GET", "/api/connectors/google/autojoin/status", "calendarAutojoin"],
      ["POST", "/API/CONNECTORS/GOOGLE/AUTOJOIN/setup", "calendarAutojoinMutation"],
      ["DELETE", "/api/connectors/google/autojoin", "calendarAutojoinMutation"],
      // the rest
      ["GET", "/api/connectors/google/oauth/start", "googleOAuth"],
      ["GET", "/API/Connectors/Google/OAuth/callback", "googleOAuth"],
      ["GET", "/api/connectors/google/oauth-anything", "global"],
      ["GET", "/api/connectors/webhooks/pending", "connectorCompanion"],
      ["GET", "/API/DELEGATIONS/status", "delegation"],
      ["GET", "/API/SIGNATURE/x", "verification"],
      ["GET", "/api/signature-anything", "global"],
      ["GET", "/api/auth/nonce", "auth"],
      ["POST", "/API/Auth/Verify", "auth"],
      ["GET", "/api/authx", "global"],
    ];
    for (const [method, path, bucket] of cases) {
      expect([method, path, bucketFor(method, path)]).toEqual([method, path, bucket]);
    }
  });

  it("an upper-case path counts against one bucket only", async () => {
    const app = buildApp();
    app.get("/api/transcriber/private-cloud/transcriptions/:id", (_req, res) => res.json({ ok: true }));
    app.get("/api/transcriber/meetings", (_req, res) => res.json({ ok: true }));
    await withServer(app, async (port) => {
      const base = `http://localhost:${port}`;
      let last: Response | undefined;
      for (let i = 0; i < 3; i++) {
        last = await realFetch(`${base}/API/TRANSCRIBER/PRIVATE-CLOUD/transcriptions/j1`);
        expect(last.status).toBe(200);
      }
      // One decrement per request in the private-cloud bucket, none anywhere else.
      expect(rateLimitHeader(last!)).toEqual({ limit: PRIVATE_CLOUD_TRANSCRIPTION_LIMIT, remaining: PRIVATE_CLOUD_TRANSCRIPTION_LIMIT - 3 });
      const bot = await realFetch(`${base}/api/transcriber/meetings`);
      expect(rateLimitHeader(bot)).toEqual({ limit: TRANSCRIBER_LIMIT, remaining: TRANSCRIBER_LIMIT - 1 });
      const manifest = await realFetch(`${base}/api/manifest`);
      expect(rateLimitHeader(manifest)).toEqual({ limit: GLOBAL_LIMIT, remaining: GLOBAL_LIMIT - 1 });
    });
  });

  it("paid chat has its own 600 bucket and denies at 601 before the upstream call", async () => {
    expect(PAID_CHAT_PATHS).toEqual(["/api/chat", "/api/agent/chat"]);
    const app = express();
    applyRateLimiters(app, { sessionKey: SESSION_KEY });
    let upstreamCalls = 0;
    const upstream = (_req: express.Request, res: express.Response) => {
      upstreamCalls++;
      res.json({ ok: true });
    };
    app.post("/api/chat", upstream);
    app.post("/api/agent/chat", upstream);
    app.get("/api/manifest", (_req, res) => res.json({ ok: true }));
    await withServer(app, async (port) => {
      const base = `http://localhost:${port}`;
      for (let i = 0; i < PAID_CHAT_LIMIT; i++) {
        const path = i % 2 === 0 ? "/api/chat" : "/api/agent/chat";
        expect((await realFetch(`${base}${path}`, { method: "POST" })).status).toBe(200);
      }
      expect(upstreamCalls).toBe(PAID_CHAT_LIMIT);
      expect((await realFetch(`${base}/api/chat`, { method: "POST" })).status).toBe(429);
      expect((await realFetch(`${base}/API/Agent/Chat`, { method: "POST" })).status).toBe(429);
      expect(upstreamCalls).toBe(PAID_CHAT_LIMIT);
      // The global bucket never counted a send.
      const manifest = await realFetch(`${base}/api/manifest`);
      expect(rateLimitHeader(manifest)).toEqual({ limit: GLOBAL_LIMIT, remaining: GLOBAL_LIMIT - 1 });
    });
  });

  it("/health and /health/ are in no bucket and still answer once the global bucket is drained", async () => {
    const app = buildApp();
    app.get("/health", (_req, res) => res.json({ ok: true }));
    app.get("/health/anything", (_req, res) => res.json({ ok: true }));
    await withServer(app, async (port) => {
      const base = `http://localhost:${port}`;
      for (let i = 0; i < GLOBAL_LIMIT; i++) {
        expect((await realFetch(`${base}/api/manifest`)).status).toBe(200);
      }
      expect((await realFetch(`${base}/api/manifest`)).status).toBe(429);
      for (const path of ["/health", "/health/", "/health?probe=1", "/HEALTH"]) {
        const health = await realFetch(`${base}${path}`);
        expect(health.status).toBe(200);
        expect(rateLimitHeader(health)).toBeNull();
      }
      // A descendant is not exempt: it shares the drained global bucket.
      expect((await realFetch(`${base}/health/anything`)).status).toBe(429);
    });
  });

  it("private cloud job-status polls have their own bucket, apart from transcriber and chat", async () => {
    expect(PRIVATE_CLOUD_TRANSCRIPTION_PATHS).toEqual(["/api/transcriber/private-cloud"]);
    const app = buildApp();
    app.get("/api/transcriber/private-cloud/transcriptions/:id", (_req, res) => res.json({ ok: true }));
    app.get("/api/transcriber/meetings", (_req, res) => res.json({ ok: true }));
    await withServer(app, async (port) => {
      const base = `http://localhost:${port}`;
      // One long job polling every 5 s for an hour: 720 status GETs, more than the old shared
      // 600 transcriber bucket held.
      let last: Response | undefined;
      for (let i = 0; i < 720; i++) {
        last = await realFetch(`${base}/api/transcriber/private-cloud/transcriptions/job-1`);
        expect(last.status).toBe(200);
      }
      expect(rateLimitHeader(last!)).toEqual({
        limit: PRIVATE_CLOUD_TRANSCRIPTION_LIMIT,
        remaining: PRIVATE_CLOUD_TRANSCRIPTION_LIMIT - 720,
      });
      // Neither the transcriber bucket nor the global one counted any of them.
      const bot = await realFetch(`${base}/api/transcriber/meetings`);
      expect(rateLimitHeader(bot)).toEqual({ limit: TRANSCRIBER_LIMIT, remaining: TRANSCRIBER_LIMIT - 1 });
      const manifest = await realFetch(`${base}/api/manifest`);
      expect(rateLimitHeader(manifest)).toEqual({ limit: GLOBAL_LIMIT, remaining: GLOBAL_LIMIT - 1 });
    });
  });

  it("private cloud mutations 429 at their own limit + 1 without touching the polling budget", async () => {
    const app = express();
    applyRateLimiters(app, { sessionKey: SESSION_KEY });
    app.post("/api/transcriber/private-cloud/transcriptions", (_req, res) => res.status(201).json({ ok: true }));
    app.delete("/api/transcriber/private-cloud/transcriptions/:id", (_req, res) => res.json({ ok: true }));
    app.get("/api/transcriber/private-cloud/transcriptions/:id", (_req, res) => res.json({ ok: true }));
    await withServer(app, async (port) => {
      const base = `http://localhost:${port}/api/transcriber/private-cloud/transcriptions`;
      for (let i = 0; i < PRIVATE_CLOUD_TRANSCRIPTION_MUTATION_LIMIT; i++) {
        const r = i % 2 === 0
          ? await realFetch(base, { method: "POST" })
          : await realFetch(`${base}/j${i}`, { method: "DELETE" });
        expect(r.status).toBeLessThan(300);
      }
      expect((await realFetch(base, { method: "POST" })).status).toBe(429);
      const poll = await realFetch(`${base}/j1`);
      expect(poll.status).toBe(200);
      expect(rateLimitHeader(poll)).toEqual({
        limit: PRIVATE_CLOUD_TRANSCRIPTION_LIMIT,
        remaining: PRIVATE_CLOUD_TRANSCRIPTION_LIMIT - 1,
      });
    });
  });

  it("calendar autojoin setup has its own small bucket apart from status reads", async () => {
    const app = express();
    applyRateLimiters(app, { sessionKey: SESSION_KEY });
    app.get("/api/connectors/google/autojoin/status", (_req, res) => res.json({ ok: true }));
    app.post("/api/connectors/google/autojoin/setup", (_req, res) => res.json({ ok: true }));
    await withServer(app, async (port) => {
      const base = `http://localhost:${port}/api/connectors/google/autojoin`;
      for (let i = 0; i < CALENDAR_AUTOJOIN_MUTATION_LIMIT; i++) {
        expect((await realFetch(`${base}/setup`, { method: "POST" })).status).toBe(200);
      }
      expect((await realFetch(`${base}/setup`, { method: "POST" })).status).toBe(429);
      const status = await realFetch(`${base}/status`);
      expect(rateLimitHeader(status)).toEqual({ limit: CALENDAR_AUTOJOIN_LIMIT, remaining: CALENDAR_AUTOJOIN_LIMIT - 1 });
    });
  });
});

describe("global bucket route counter", () => {
  it("counts only global-bucket requests, by route template, without paths' identifying parts", async () => {
    const app = express();
    const { globalRoutes } = applyRateLimiters(app, { sessionKey: SESSION_KEY });
    app.use((_req, res) => res.json({ ok: true }));
    await withServer(app, async (port) => {
      const base = `http://localhost:${port}`;
      await realFetch(`${base}/api/agent/session?token=secret`);
      await realFetch(`${base}/API/Agent/Session`);
      await realFetch(`${base}/api/billing/status`);
      await realFetch(`${base}/api/billing/0xabc/whatever`);
      await realFetch(`${base}/api/chat/models`);
      await realFetch(`${base}/wp-admin/0xdeadbeef`);
      await realFetch(`${base}/zz-${"x".repeat(40)}`);
      // Not the global bucket: none of these are counted.
      await realFetch(`${base}/health`);
      await realFetch(`${base}/api/chat`, { method: "POST" });
      await realFetch(`${base}/api/transcriber/meetings`);
    });
    const { total, top } = globalRoutes.top(10);
    expect(total).toBe(7);
    expect(top).toEqual([
      { route: "GET /api/agent/session", count: 2 },
      { route: "GET other", count: 2 },
      { route: "GET /api/billing/*", count: 1 },
      { route: "GET /api/billing/status", count: 1 },
      { route: "GET /api/chat/models", count: 1 },
    ]);
    expect(JSON.stringify(top)).not.toContain("secret");
    expect(JSON.stringify(top)).not.toContain("0xabc");
  });

  it("labels only allow-listed methods, so the label set is bounded", () => {
    const counter = new GlobalBucketRouteCounter();
    counter.record("PROPFIND", "/api/manifest");
    counter.record("M-SEARCH", "/api/manifest");
    counter.record("GET", "/api//manifest");
    expect(counter.top(10).top).toEqual([
      { route: "OTHER /api/manifest", count: 2 },
      { route: "GET /api/manifest", count: 1 },
    ]);
  });

  it("emits a top-10 interval line and resets the interval, keeping the since-start totals", () => {
    const counter = new GlobalBucketRouteCounter();
    for (let i = 0; i < 12; i++) counter.record("GET", "/api/manifest");
    counter.record("POST", "/api/auth/verify");
    expect(counter.takeInterval()).toBe(
      '[rate-limit] op=global-bucket-routes window=5m total=13 top="GET /api/manifest=12 POST /api/auth/verify=1"',
    );
    expect(counter.takeInterval()).toBe('[rate-limit] op=global-bucket-routes window=5m total=0 top=""');
    expect(counter.top(1)).toMatchObject({ total: 13, top: [{ route: "GET /api/manifest", count: 12 }] });
  });
});

/**
 * 0.5.5: buckets are per verified session. Everything else (no token, a forged, foreign or
 * garbage one) shares one anonymous bucket at the whole-service ceilings, and nothing else a
 * client sends, `X-Forwarded-For` included, can choose or mint a key.
 */
describe("per-session keying", () => {
  const ALICE = "0x00000000000000000000000000000000000a11ce";
  const BOB = "0x0000000000000000000000000000000000000b0b";
  const auth = async (address: string, key = SESSION_KEY) =>
    `Bearer ${(await issueSessionToken(address, key)).token}`;

  it("pins the per-session ceilings", () => {
    expect(SESSION_LIMITS).toEqual({
      global: 120,
      verification: 600,
      connectorCompanion: 600,
      transcriber: 600,
      privateCloudTranscription: 600,
      hostedUpload: 480,
      paidChat: 120,
      privateCloudTranscriptionMutation: 60,
      calendarAutojoin: 240,
      calendarAutojoinMutation: 30,
      googleOAuth: 30,
      delegation: 240,
    });
  });

  it("two signed-in clients get separate buckets", async () => {
    const [alice, bob] = [await auth(ALICE), await auth(BOB)];
    await withServer(buildApp(), async (port) => {
      const url = `http://localhost:${port}/api/manifest`;
      for (let i = 0; i < SESSION_LIMITS.global; i++) {
        expect((await realFetch(url, { headers: { authorization: alice } })).status).toBe(200);
      }
      expect((await realFetch(url, { headers: { authorization: alice } })).status).toBe(429);
      const second = await realFetch(url, { headers: { authorization: bob } });
      expect(second.status).toBe(200);
      expect(rateLimitHeader(second)).toEqual({ limit: SESSION_LIMITS.global, remaining: SESSION_LIMITS.global - 1 });
      // Neither session touched the anonymous bucket.
      const anonymous = await realFetch(url);
      expect(rateLimitHeader(anonymous)).toEqual({ limit: GLOBAL_LIMIT, remaining: GLOBAL_LIMIT - 1 });
    });
  });

  it("a rotating X-Forwarded-For cannot mint buckets: unauthenticated requests share one", async () => {
    await withServer(buildApp(), async (port) => {
      const url = `http://localhost:${port}/api/manifest`;
      let last: Response | undefined;
      for (let i = 0; i < 50; i++) {
        last = await realFetch(url, { headers: { "x-forwarded-for": `198.51.100.${i}, 203.0.113.${i}` } });
      }
      expect(rateLimitHeader(last!)).toEqual({ limit: GLOBAL_LIMIT, remaining: GLOBAL_LIMIT - 50 });
    });
  });

  it("X-Forwarded-For cannot move a session into another bucket", async () => {
    const [alice, bob] = [await auth(ALICE), await auth(BOB)];
    await withServer(buildApp(), async (port) => {
      const url = `http://localhost:${port}/api/manifest`;
      let last: Response | undefined;
      for (let i = 0; i < 5; i++) {
        last = await realFetch(url, { headers: { authorization: alice, "x-forwarded-for": `192.0.2.${i}` } });
      }
      expect(rateLimitHeader(last!)).toEqual({ limit: SESSION_LIMITS.global, remaining: SESSION_LIMITS.global - 5 });
      const second = await realFetch(url, { headers: { authorization: bob } });
      expect(rateLimitHeader(second)).toEqual({ limit: SESSION_LIMITS.global, remaining: SESSION_LIMITS.global - 1 });
    });
  });

  it("a forged, foreign or garbage token is anonymous, never its claimed owner's bucket", async () => {
    const bob = await auth(BOB);
    const forged = await auth(BOB, "another-backend-key");
    await withServer(buildApp(), async (port) => {
      const url = `http://localhost:${port}/api/manifest`;
      for (const authorization of [forged, "Bearer not-a-jwt", forged.slice(7)]) {
        const r = await realFetch(url, { headers: { authorization } });
        expect(rateLimitHeader(r)?.limit).toBe(GLOBAL_LIMIT);
      }
      const anonymous = await realFetch(url);
      expect(rateLimitHeader(anonymous)).toEqual({ limit: GLOBAL_LIMIT, remaining: GLOBAL_LIMIT - 4 });
      const owner = await realFetch(url, { headers: { authorization: bob } });
      expect(rateLimitHeader(owner)).toEqual({ limit: SESSION_LIMITS.global, remaining: SESSION_LIMITS.global - 1 });
    });
  });

  it("accepts a raw token without the Bearer prefix, like createAuthMiddleware", async () => {
    const token = (await auth(ALICE)).slice(7);
    await withServer(buildApp(), async (port) => {
      const r = await realFetch(`http://localhost:${port}/api/manifest`, { headers: { authorization: token } });
      expect(rateLimitHeader(r)?.limit).toBe(SESSION_LIMITS.global);
    });
  });

  it("/health stays in no bucket for a signed-in client too", async () => {
    const app = buildApp();
    app.get("/health", (_req, res) => res.json({ ok: true }));
    const alice = await auth(ALICE);
    await withServer(app, async (port) => {
      const r = await realFetch(`http://localhost:${port}/health`, { headers: { authorization: alice } });
      expect(r.status).toBe(200);
      expect(rateLimitHeader(r)).toBeNull();
    });
  });
});

describe("aggregate ceilings over per-session buckets", () => {
  const session = async (i: number) =>
    `Bearer ${(await issueSessionToken(`0x${(i + 1).toString(16).padStart(40, "0")}`, SESSION_KEY)).token}`;

  it("keeps the 0.5.4 whole-service ceilings for paid chat, private cloud mutations and hosted uploads", () => {
    expect(AGGREGATE_LIMITS).toEqual({
      paidChat: PAID_CHAT_LIMIT,
      privateCloudTranscriptionMutation: PRIVATE_CLOUD_TRANSCRIPTION_MUTATION_LIMIT,
      hostedUpload: ASSEMBLYAI_HOSTED_UPLOAD_LIMIT,
    });
  });

  it("private cloud mutations stop at 300 across fresh sessions", async () => {
    const app = express();
    applyRateLimiters(app, { sessionKey: SESSION_KEY });
    app.post("/api/transcriber/private-cloud/transcriptions", (_req, res) => res.status(201).json({ ok: true }));
    await withServer(app, async (port) => {
      const url = `http://localhost:${port}/api/transcriber/private-cloud/transcriptions`;
      let sent = 0;
      for (let i = 0; sent < PRIVATE_CLOUD_TRANSCRIPTION_MUTATION_LIMIT; i++) {
        const authorization = await session(i);
        for (let j = 0; j < SESSION_LIMITS.privateCloudTranscriptionMutation && sent < PRIVATE_CLOUD_TRANSCRIPTION_MUTATION_LIMIT; j++, sent++) {
          expect((await realFetch(url, { method: "POST", headers: { authorization } })).status).toBe(201);
        }
      }
      expect((await realFetch(url, { method: "POST", headers: { authorization: await session(999) } })).status).toBe(429);
      // A tokenless request is in neither: only its own anonymous bucket counts it (production
      // then 401s it in authMiddleware), so it neither spends nor is stopped by the aggregate.
      expect((await realFetch(url, { method: "POST" })).status).toBe(201);
    });
  });

  it("hosted uploads stop at the aggregate across fresh sessions", async () => {
    const app = express();
    applyRateLimiters(app, { sessionKey: SESSION_KEY });
    app.put("/api/transcriber/assemblyai/hosted/uploads/:id/parts/:n", (_req, res) => res.json({ ok: true }));
    await withServer(app, async (port) => {
      const url = `http://localhost:${port}/api/transcriber/assemblyai/hosted/uploads/u/parts/1`;
      let sent = 0;
      for (let i = 0; sent < ASSEMBLYAI_HOSTED_UPLOAD_LIMIT; i++) {
        const authorization = await session(i);
        for (let j = 0; j < SESSION_LIMITS.hostedUpload && sent < ASSEMBLYAI_HOSTED_UPLOAD_LIMIT; j++, sent++) {
          const r = await realFetch(url, { method: "PUT", headers: { authorization } });
          if (r.status !== 200) throw new Error(`upload ${sent} got ${r.status}`);
        }
      }
      expect((await realFetch(url, { method: "PUT", headers: { authorization: await session(999) } })).status).toBe(429);
    });
  }, 60_000);
});

it("exposes limiter headers on a cross-origin PTX status 429", async () => {
  const origin = "https://tinycloud.chat";
  const app = express();
  app.use(cors(appCorsOptions(origin)));
  applyRateLimiters(app, { sessionKey: SESSION_KEY });
  app.get("/api/transcriber/private-cloud/transcriptions/:id", (_req, res) => res.json({ ok: true }));
  const authorization = `Bearer ${(await issueSessionToken("0x0000000000000000000000000000000000000b0b", SESSION_KEY)).token}`;

  await withServer(app, async (port) => {
    const url = `http://localhost:${port}/api/transcriber/private-cloud/transcriptions/job-1`;
    for (let i = 0; i < SESSION_LIMITS.privateCloudTranscription; i++) {
      const response = await realFetch(url, { headers: { authorization, Origin: origin } });
      expect(response.status).toBe(200);
    }
    const limited = await realFetch(url, { headers: { authorization, Origin: origin } });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("access-control-allow-origin")).toBe(origin);
    expect(limited.headers.has("retry-after")).toBe(true);
    expect(limited.headers.has("ratelimit")).toBe(true);
    expect(limited.headers.has("ratelimit-policy")).toBe(true);
    const exposed = (limited.headers.get("access-control-expose-headers") ?? "")
      .split(",").map((header) => header.trim().toLowerCase());
    expect(exposed).toEqual(expect.arrayContaining(["retry-after", "ratelimit", "ratelimit-policy"]));
  });
}, 30_000);
