import { describe, expect, it } from "bun:test";
import express from "express";
import { applyRateLimiters, GLOBAL_LIMIT } from "../rate-limits.js";

const realFetch = globalThis.fetch;

function buildApp() {
  const app = express();
  applyRateLimiters(app);
  app.get("/api/signature/:id", (_req, res) => res.json({ ok: true }));
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
  it("verification traffic does NOT exhaust the /api/chat bucket", async () => {
    const app = buildApp();
    await withServer(app, async (port) => {
      // 130 verification hits — over the global 120 limit, but the verification
      // bucket (600) is separate and the global limiter skips these paths.
      for (let i = 0; i < 130; i++) {
        const r = await realFetch(`http://localhost:${port}/api/signature/x${i}`);
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
});
