import { describe, expect, it } from "bun:test";
import express from "express";
import {
  applyRateLimiters,
  GLOBAL_LIMIT,
  GOOGLE_OAUTH_LIMIT,
  GOOGLE_OAUTH_PATHS,
} from "../rate-limits.js";
import * as rateLimits from "../rate-limits.js";
import { transcriberRecoveryConfigFromEnv } from "../services/transcriber-recovery-config.js";

const realFetch = globalThis.fetch;

function buildApp() {
  const app = express();
  applyRateLimiters(app);
  app.get("/api/signature/:id", (_req, res) => res.json({ ok: true }));
  app.get("/api/attestation/self", (_req, res) => res.json({ ok: true }));
  app.post("/api/chat", (_req, res) => res.json({ ok: true }));
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

describe("rate limiters (ST5)", () => {
  it("configures one-hop proxy trust before registering IP-based limiters", () => {
    const app = express();
    applyRateLimiters(app);
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
      // A subsequent /api/chat must NOT be 429'd by the verification traffic.
      const chat = await realFetch(`http://localhost:${port}/api/chat`, { method: "POST" });
      expect(chat.status).not.toBe(429);
      expect(chat.status).toBe(200);
    });
  });

  it("the global /api/chat limiter still 429s after its own limit", async () => {
    const app = buildApp();
    await withServer(app, async (port) => {
      for (let i = 0; i < GLOBAL_LIMIT; i++) {
        const r = await realFetch(`http://localhost:${port}/api/chat`, { method: "POST" });
        expect(r.status).toBe(200);
      }
      const over = await realFetch(`http://localhost:${port}/api/chat`, { method: "POST" });
      expect(over.status).toBe(429);
    });
  });

  it("does not exempt verification-prefix lookalike paths from the global limiter", async () => {
    const app = express();
    applyRateLimiters(app);
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
    applyRateLimiters(app);
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
    applyRateLimiters(app);
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

describe("recovery-only HMAC limiter (C3)", () => {
  function recoveryExports() {
    expect(typeof (rateLimits as any).recoveryPseudonym).toBe("function");
    expect(typeof (rateLimits as any).createRecoveryRateLimiter).toBe("function");
    return rateLimits as typeof rateLimits & {
      recoveryPseudonym(address: string, key: string): string;
      createRecoveryRateLimiter(options: {
        key: string;
        limit: number;
        windowMs: number;
        now: () => number;
      }): {
        consume(address: string): {
          allowed: boolean;
          correlation: string;
          retryAfterSeconds: number | null;
        };
      };
    };
  }

  it("normalizes addresses and produces a bounded keyed pseudonym with no raw value", () => {
    const { recoveryPseudonym } = recoveryExports();
    const key = "correct-horse-battery-staple-key-material";
    const lower = recoveryPseudonym(ADDRESS_FOR_LIMITER.toLowerCase(), key);
    const mixed = recoveryPseudonym(ADDRESS_FOR_LIMITER, key);
    expect(mixed).toBe(lower);
    expect(mixed).toMatch(/^[0-9a-f]{32}$/);
    expect(mixed).not.toContain(ADDRESS_FOR_LIMITER.toLowerCase());
    expect(recoveryPseudonym(ADDRESS_FOR_LIMITER, `${key}-different`)).not.toBe(mixed);
  });

  it("shares the window across address casing, isolates another address, and resets by clock", () => {
    const { createRecoveryRateLimiter } = recoveryExports();
    let now = 1_000;
    const limiter = createRecoveryRateLimiter({
      key: "correct-horse-battery-staple-key-material",
      limit: 2,
      windowMs: 1_000,
      now: () => now,
    });
    expect(limiter.consume(ADDRESS_FOR_LIMITER).allowed).toBe(true);
    expect(limiter.consume(ADDRESS_FOR_LIMITER.toLowerCase()).allowed).toBe(true);
    expect(limiter.consume(ADDRESS_FOR_LIMITER).allowed).toBe(false);
    expect(limiter.consume(ADDRESS_FOR_LIMITER).retryAfterSeconds).toBe(1);
    expect(limiter.consume("0xBBBBbbbbBBBBbbbbBBBBbbbbBBBBbbbbBBBBbbbb").allowed).toBe(true);
    now += 1_001;
    expect(limiter.consume(ADDRESS_FOR_LIMITER).allowed).toBe(true);
  });

  it("keeps enabled recovery unready for weak, placeholder, reused, or invalid limiter config", () => {
    const base = {
      TRANSCRIBER_RECOVERY_ENABLED: "true",
      TRANSCRIBER_RECOVERY_CONTRACT_VERSION: "space-save-v2",
      TRANSCRIBER_RECOVERY_CAPABILITY_CACHE_MS: "1000",
      TRANSCRIBER_RECOVERY_UPSTREAM_LEASE_MS: "5000",
      TRANSCRIBER_RECOVERY_RATE_LIMIT_MAX: "2",
      TRANSCRIBER_RECOVERY_RATE_LIMIT_WINDOW_MS: "60000",
      TINYCHAT_BUILD_SHA: "a".repeat(40),
      TINYCHAT_BACKEND_IMAGE_DIGEST: `sha256:${"b".repeat(64)}`,
    };
    for (const patch of [
      {},
      { TRANSCRIBER_RECOVERY_PSEUDONYM_KEY: "short" },
      { TRANSCRIBER_RECOVERY_PSEUDONYM_KEY: "x".repeat(32) },
      { TRANSCRIBER_RECOVERY_PSEUDONYM_KEY: "correct-horse-battery-staple-key-material", TRANSCRIBER_RECOVERY_RATE_LIMIT_MAX: "0" },
      { TRANSCRIBER_RECOVERY_PSEUDONYM_KEY: "correct-horse-battery-staple-key-material", TRANSCRIBER_RECOVERY_RATE_LIMIT_WINDOW_MS: "-1" },
    ]) {
      expect(transcriberRecoveryConfigFromEnv({ ...base, ...patch })).toMatchObject({ ready: false });
    }
    const reused = "correct-horse-battery-staple-key-material";
    expect(transcriberRecoveryConfigFromEnv({
      ...base,
      TRANSCRIPTION_API_KEY: reused,
      TRANSCRIBER_RECOVERY_PSEUDONYM_KEY: reused,
    })).toMatchObject({ ready: false, pseudonymKey: null });
    expect(transcriberRecoveryConfigFromEnv({
      ...base,
      TRANSCRIPTION_API_KEY: `  ${reused}  `,
      TRANSCRIBER_RECOVERY_PSEUDONYM_KEY: reused,
    })).toMatchObject({ ready: false, pseudonymKey: null });
    expect(transcriberRecoveryConfigFromEnv({
      ...base,
      TRANSCRIBER_RECOVERY_PSEUDONYM_KEY: reused,
    })).toMatchObject({ enabled: true, ready: true, pseudonymKey: reused });
  });
});

const ADDRESS_FOR_LIMITER = "0xAaaaAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaaAAAA";
