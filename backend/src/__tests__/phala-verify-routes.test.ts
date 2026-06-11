import { afterEach, describe, expect, it } from "bun:test";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import { createPhalaVerifyRouter } from "../routes/phala-verify.js";

const realFetch = globalThis.fetch;

type FetchCall = { url: string; init?: RequestInit };

function mockFetch(calls: FetchCall[], response: () => globalThis.Response) {
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return response();
  }) as typeof fetch;
}

async function request(
  app: express.Express,
  path: string,
  init?: RequestInit,
): Promise<globalThis.Response> {
  const server = await new Promise<import("http").Server>((resolve) => {
    const instance = app.listen(0, () => resolve(instance));
  });
  const { port } = server.address() as { port: number };
  try {
    return await realFetch(`http://localhost:${port}${path}`, init);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

// The route captures PHALA_TDX_VERIFIER_URL at module load, so this asserts
// against the default rather than a per-test override.
const PHALA_TDX_VERIFIER_URL =
  process.env.PHALA_TDX_VERIFIER_URL ??
  "https://cloud-api.phala.network/api/v1/attestations/verify";

describe("phala-verify route", () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("forwards the POST body to Phala and relays status + bytes verbatim", async () => {
    const calls: FetchCall[] = [];
    // Phala's real verdict shape — relayed verbatim, never recomputed here.
    const upstreamBody = JSON.stringify({ success: true, quote: { verified: true } });
    mockFetch(
      calls,
      () => new Response(upstreamBody, { status: 200, headers: { "content-type": "application/json" } }),
    );

    const app = express();
    app.use("/api/phala-verify", express.json({ limit: "256kb" }));
    app.use("/api/phala-verify", createPhalaVerifyRouter());

    const res = await request(app, "/api/phala-verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hex: "deadbeef" }),
    });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe(upstreamBody);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(PHALA_TDX_VERIFIER_URL);
    expect(calls[0].init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ hex: "deadbeef" });
    // No server-side verdict — the body is the upstream's own bytes, byte-for-byte.
  });

  it("relays a non-2xx upstream status verbatim (no verdict substitution)", async () => {
    const calls: FetchCall[] = [];
    mockFetch(
      calls,
      () => new Response('{"success":false}', { status: 422, headers: { "content-type": "application/json" } }),
    );

    const app = express();
    app.use("/api/phala-verify", express.json({ limit: "256kb" }));
    app.use("/api/phala-verify", createPhalaVerifyRouter());

    const res = await request(app, "/api/phala-verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hex: "bad" }),
    });

    expect(res.status).toBe(422);
    expect(await res.text()).toBe('{"success":false}');
    expect(calls).toHaveLength(1);
  });

  it("accepts a body larger than the global 64 KB limit (256 KB mount)", async () => {
    const calls: FetchCall[] = [];
    mockFetch(calls, () => new Response("ok", { status: 200 }));

    const app = express();
    // Mirror index.ts: the roomier phala-verify parser is registered before the
    // global 64 KB parser so larger hex-quote payloads are accepted.
    app.use("/api/phala-verify", express.json({ limit: "256kb" }));
    app.use(express.json({ limit: "64kb" }));
    app.use("/api/phala-verify", createPhalaVerifyRouter());

    const big = "a".repeat(100 * 1024); // 100 KB — over the 64 KB global limit
    const res = await request(app, "/api/phala-verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hex: big }),
    });

    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(JSON.parse(String(calls[0].init?.body)).hex).toBe(big);
  });

  it("is reachable only behind auth middleware (gated requests never hit upstream)", async () => {
    const calls: FetchCall[] = [];
    mockFetch(calls, () => new Response("body", { status: 200 }));

    const denyingAuth = (_req: Request, res: Response, _next: NextFunction) => {
      res.status(401).json({ error: "unauthorized" });
    };
    const app = express();
    app.use("/api/phala-verify", express.json({ limit: "256kb" }));
    app.use("/api/phala-verify", denyingAuth, createPhalaVerifyRouter());

    const res = await request(app, "/api/phala-verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hex: "deadbeef" }),
    });

    expect(res.status).toBe(401);
    expect(calls).toHaveLength(0);
  });
});
