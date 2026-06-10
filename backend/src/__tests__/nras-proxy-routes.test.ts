import { afterEach, describe, expect, it } from "bun:test";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import { createNrasProxyRouter } from "../routes/nras-proxy.js";

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

// The route captures NRAS_URL / NRAS_JWKS_URL at module load, so these assert
// against the defaults rather than per-test overrides.
const NRAS_URL = process.env.NRAS_URL ?? "https://nras.attestation.nvidia.com/v3/attest/gpu";
const NRAS_JWKS_URL =
  process.env.NRAS_JWKS_URL ?? "https://nras.attestation.nvidia.com/.well-known/jwks.json";

describe("nras-proxy route", () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("forwards the POST body to NRAS and relays status + bytes verbatim", async () => {
    const calls: FetchCall[] = [];
    mockFetch(
      calls,
      () => new Response("nras-token-bytes", { status: 201, headers: { "content-type": "application/jwt" } }),
    );

    const app = express();
    app.use("/api/nras-proxy", express.json({ limit: "4mb" }));
    app.use("/api/nras-proxy", createNrasProxyRouter());

    const res = await request(app, "/api/nras-proxy", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ evidence: "gpu-evidence" }),
    });

    expect(res.status).toBe(201);
    expect(await res.text()).toBe("nras-token-bytes");
    expect(res.headers.get("content-type")).toContain("application/jwt");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(NRAS_URL);
    expect(calls[0].init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ evidence: "gpu-evidence" });
    // No server-side verdict — the body is the upstream's own bytes.
  });

  it("relays NVIDIA's JWKS verbatim on GET /jwks", async () => {
    const calls: FetchCall[] = [];
    mockFetch(
      calls,
      () => new Response('{"keys":[]}', { status: 200, headers: { "content-type": "application/json" } }),
    );

    const app = express();
    app.use("/api/nras-proxy", createNrasProxyRouter());

    const res = await request(app, "/api/nras-proxy/jwks");

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"keys":[]}');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(NRAS_JWKS_URL);
    expect(calls[0].init?.method).toBe("GET");
  });

  it("accepts a body larger than the global 64 KB limit (4 MB mount)", async () => {
    const calls: FetchCall[] = [];
    mockFetch(calls, () => new Response("ok", { status: 200 }));

    const app = express();
    // Mirror index.ts: the roomier nras-proxy parser is registered before the
    // global 64 KB parser so large GPU evidence payloads are accepted.
    app.use("/api/nras-proxy", express.json({ limit: "4mb" }));
    app.use(express.json({ limit: "64kb" }));
    app.use("/api/nras-proxy", createNrasProxyRouter());

    const big = "x".repeat(200 * 1024); // 200 KB — over the 64 KB global limit
    const res = await request(app, "/api/nras-proxy", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ evidence: big }),
    });

    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(JSON.parse(String(calls[0].init?.body)).evidence).toBe(big);
  });

  it("is reachable only behind auth middleware (gated requests never hit upstream)", async () => {
    const calls: FetchCall[] = [];
    mockFetch(calls, () => new Response("body", { status: 200 }));

    const denyingAuth = (_req: Request, res: Response, _next: NextFunction) => {
      res.status(401).json({ error: "unauthorized" });
    };
    const app = express();
    app.use("/api/nras-proxy", express.json({ limit: "4mb" }));
    app.use("/api/nras-proxy", denyingAuth, createNrasProxyRouter());

    const res = await request(app, "/api/nras-proxy/jwks");

    expect(res.status).toBe(401);
    expect(calls).toHaveLength(0);
  });
});
