// The bots service's credential reaches only its allow-listed backend routes, and none of them is on the never-list
// (bots/src/tool-policy.ts, imported like the signing module: dependency-free).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import express from "express";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { BOTS_SERVICE_ROUTES, createBotsServiceGuardRouter } from "../bots-service-routes.js";
import { signedCallHeader } from "../bots-signed-call.js";
import { NEVER, neverRoute } from "../../../bots/src/tool-policy";

const secret = "b".repeat(64);
const owner = `did:pkh:eip155:1:${"a".repeat(40)}`;
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];

let server: Server;
let base: string;
const reached: string[] = [];

beforeAll(async () => {
  const app = express();
  app.use(createBotsServiceGuardRouter());
  app.use((req, res) => {
    reached.push(`${req.method} ${req.originalUrl}`);
    res.json({ reached: true });
  });
  server = app.listen(0);
  await once(server, "listening");
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

/** A call signed exactly as the bots service signs one (bot-admission.ts). */
const signed = (method: string, path: string, body?: string) =>
  fetch(`${base}${path}`, {
    method,
    headers: {
      authorization: signedCallHeader(secret, { direction: "to-backend", environment: "private", owner, bot: "main", method, path, body }),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body }),
  });

describe("the bots service's backend routes", () => {
  test("none is on the never-list", () => {
    for (const route of BOTS_SERVICE_ROUTES) {
      expect({ ...route, never: neverRoute(route.method, route.path) }).toEqual({ ...route, never: undefined });
    }
  });

  test("every never-list route is refused with the bots credential before any router runs", async () => {
    reached.length = 0;
    const routes = NEVER.flatMap(entry => entry.routes);
    expect(routes.length).toBeGreaterThan(0);
    for (const route of routes) {
      for (const method of route.method ? [route.method] : METHODS) {
        const response = await signed(method, route.prefix, method === "GET" ? undefined : "{}");
        expect({ route: `${method} ${route.prefix}`, status: response.status }).toEqual({ route: `${method} ${route.prefix}`, status: 403 });
      }
    }
    expect(reached).toEqual([]);
  });

  test("an allow-listed route passes only as listed: method, path and case exact, no query", async () => {
    reached.length = 0;
    const body = JSON.stringify({ owner, sourceKey: "main", targetKey: "c".repeat(32) });
    expect((await signed("POST", "/api/internal/bots/admit", body)).status).toBe(200);
    expect((await signed("GET", "/api/internal/bots/admit")).status).toBe(403);
    expect((await signed("POST", "/API/internal/bots/admit", body)).status).toBe(403);
    expect((await signed("POST", "/api/internal/bots/admit?x=1", body)).status).toBe(403);
    expect((await signed("POST", "/api/internal/bots/admit/", body)).status).toBe(403);
    expect(reached).toEqual(["POST /api/internal/bots/admit"]);
  });

  test("the scheme is matched in any case, and a request without it is left to the routes", async () => {
    reached.length = 0;
    const lower = await fetch(`${base}/api/billing/checkout`, { method: "POST", headers: { authorization: "tinycloud-signed x.y" } });
    expect(lower.status).toBe(403);
    expect((await fetch(`${base}/api/billing/checkout`, { method: "POST", headers: { authorization: "Bearer x" } })).status).toBe(200);
    expect((await fetch(`${base}/api/billing/checkout`, { method: "POST" })).status).toBe(200);
    expect(reached).toEqual(["POST /api/billing/checkout", "POST /api/billing/checkout"]);
  });
});
