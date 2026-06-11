import { afterEach, describe, expect, it } from "bun:test";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import { createSignatureRouter } from "../routes/signature.js";

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
  // request() drives the in-process app over loopback, so the app's own fetch()
  // is the only call the mock intercepts.
  const appFetch = realFetch;
  try {
    return await appFetch(`http://localhost:${port}${path}`, init);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

// The route captures REDPILL_BASE_URL at module load, so these assert against
// the default base rather than a per-test override.
const BASE = process.env.REDPILL_BASE_URL ?? "https://api.redpill.ai/v1";

describe("signature route", () => {
  const savedKey = process.env.REDPILL_API_KEY;

  afterEach(() => {
    globalThis.fetch = realFetch;
    if (savedKey === undefined) delete process.env.REDPILL_API_KEY;
    else process.env.REDPILL_API_KEY = savedKey;
  });

  it("injects the server-held key and forwards to RedPill with signing_algo=ecdsa", async () => {
    process.env.REDPILL_API_KEY = "secret-key-123";
    const calls: FetchCall[] = [];
    mockFetch(
      calls,
      () => new Response("upstream-body", { status: 200, headers: { "content-type": "application/json" } }),
    );

    const app = express();
    app.use("/api/signature", createSignatureRouter());
    const res = await request(app, "/api/signature/chat-abc?model=phala/gpt-oss-120b");

    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      `${BASE}/signature/chat-abc?model=phala%2Fgpt-oss-120b&signing_algo=ecdsa`,
    );
    const headers = new Headers(calls[0].init?.headers);
    expect(headers.get("authorization")).toBe("Bearer secret-key-123");
    // The browser never sees the key — it is injected server-side only.
  });

  it("relays upstream status and bytes verbatim with no server-side verdict", async () => {
    process.env.REDPILL_API_KEY = "k";
    const calls: FetchCall[] = [];
    mockFetch(
      calls,
      () => new Response("raw-signature-bytes", { status: 418, headers: { "content-type": "text/plain" } }),
    );

    const app = express();
    app.use("/api/signature", createSignatureRouter());
    const res = await request(app, "/api/signature/xyz?model=m");

    expect(res.status).toBe(418);
    expect(await res.text()).toBe("raw-signature-bytes");
    expect(res.headers.get("content-type")).toContain("text/plain");
  });

  it("returns 500 no_api_key when REDPILL_API_KEY is unset", async () => {
    delete process.env.REDPILL_API_KEY;
    const calls: FetchCall[] = [];
    mockFetch(calls, () => new Response("should-not-be-called", { status: 200 }));

    const app = express();
    app.use("/api/signature", createSignatureRouter());
    const res = await request(app, "/api/signature/x?model=m");

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: "no_api_key",
      message: "REDPILL_API_KEY is not configured on this server.",
    });
    expect(calls).toHaveLength(0);
  });

  it("is reachable only behind auth middleware (gated requests never hit upstream)", async () => {
    process.env.REDPILL_API_KEY = "k";
    const calls: FetchCall[] = [];
    mockFetch(calls, () => new Response("body", { status: 200 }));

    const denyingAuth = (_req: Request, res: Response, _next: NextFunction) => {
      res.status(401).json({ error: "unauthorized" });
    };
    const app = express();
    app.use("/api/signature", denyingAuth, createSignatureRouter());
    const res = await request(app, "/api/signature/x?model=m");

    expect(res.status).toBe(401);
    expect(calls).toHaveLength(0);
  });
});
