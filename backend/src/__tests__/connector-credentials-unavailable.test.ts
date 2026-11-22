import { describe, expect, test } from "bun:test";
import express from "express";

import {
  CREDENTIALS_ROUTE_UNAVAILABLE,
  ROUTE_UNAVAILABLE_HEADER,
  credentialRouteUnavailable,
} from "../routes/route-unavailable.js";
import { appCorsOptions } from "../cors-origins.js";

// TC-2778: a client forgives a credential-route 404 only when the backend itself marks it. The unmounted
// route's 404 carries the marker; nothing else does.

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
