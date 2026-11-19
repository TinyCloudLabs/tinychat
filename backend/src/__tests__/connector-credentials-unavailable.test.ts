import { describe, expect, test } from "bun:test";
import express from "express";

import { CredentialStore, InMemoryCredentialRowStore } from "../services/credential-store.js";
import { createConnectorCredentialRouter } from "../routes/connector-credentials.js";
import {
  CREDENTIALS_ROUTE_UNAVAILABLE,
  ROUTE_UNAVAILABLE_HEADER,
  credentialRouteUnavailable,
} from "../routes/route-unavailable.js";
import { appCorsOptions } from "../cors-origins.js";

// TC-2778: a client forgives a credential-route 404 only when the backend itself marks it. Every 404 this router
// sends for "not available to you" carries the marker; an unmounted route's 404 does too; nothing else does.

const ENROLLED = "0x7d033300000000000000000000000000000073f2";
const OUTSIDER = "0x00000000000000000000000000000000000000b2";

function app(address: string, mode: "backend" | "browser" | "no-modes"): express.Express {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => { req.user = { address }; next(); });
  a.use(
    "/api/connectors/credentials",
    createConnectorCredentialRouter({
      credentials: new CredentialStore(new InMemoryCredentialRowStore(), { upstreamRevoker: async () => {} }),
      oauth: {} as never,
      ...(mode === "no-modes" ? {} : { modes: { mode: async () => mode } }),
    }),
  );
  return a;
}

async function get(a: express.Express, path: string): Promise<Response> {
  const server = await new Promise<import("http").Server>((resolve) => { const s = a.listen(0, () => resolve(s)); });
  try {
    const { port } = server.address() as { port: number };
    return await fetch(`http://127.0.0.1:${port}${path}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("credential-route 404 marker", () => {
  test("an owner outside the cohort, a router without modes, and an unknown source all get the marked 404", async () => {
    for (const [mode, path] of [
      ["browser", "/api/connectors/credentials/fireflies"],
      ["no-modes", "/api/connectors/credentials/fireflies"],
      ["backend", "/api/connectors/credentials/not-a-source"],
    ] as const) {
      const response = await get(app(ENROLLED, mode), path);
      expect(response.status).toBe(404);
      expect(response.headers.get(ROUTE_UNAVAILABLE_HEADER)).toBe(CREDENTIALS_ROUTE_UNAVAILABLE);
      expect(await response.json()).toEqual({ error: "not_found" });
    }
    const outsider = await get(app(OUTSIDER, "browser"), "/api/connectors/credentials/fireflies");
    expect(outsider.headers.get(ROUTE_UNAVAILABLE_HEADER)).toBe(CREDENTIALS_ROUTE_UNAVAILABLE);
  });

  test("an enrolled owner's answer carries no marker", async () => {
    const response = await get(app(ENROLLED, "backend"), "/api/connectors/credentials/fireflies");
    expect(response.status).toBe(200);
    expect(response.headers.get(ROUTE_UNAVAILABLE_HEADER)).toBeNull();
    expect(await response.json()).toMatchObject({ connected: false, source: "fireflies" });
  });

  test("the unmounted-route handler answers 404 with the marker and the same body", async () => {
    const a = express();
    a.use("/api/connectors/credentials", (_req, res) => credentialRouteUnavailable(res));
    const response = await get(a, "/api/connectors/credentials/fireflies");
    expect(response.status).toBe(404);
    expect(response.headers.get(ROUTE_UNAVAILABLE_HEADER)).toBe(CREDENTIALS_ROUTE_UNAVAILABLE);
    expect(await response.json()).toEqual({ error: "not_found" });
    const elsewhere = await get(a, "/somewhere/else");
    expect(elsewhere.status).toBe(404);
    expect(elsewhere.headers.get(ROUTE_UNAVAILABLE_HEADER)).toBeNull();
  });

  test("the browser may read the marker: it is an exposed CORS header", () => {
    expect(appCorsOptions(["https://app.example"]).exposedHeaders).toContain(ROUTE_UNAVAILABLE_HEADER);
  });
});
