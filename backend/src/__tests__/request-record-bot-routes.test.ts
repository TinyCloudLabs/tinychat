// The request record for the bot routes (TC-3325): each request is recorded under its route template, and each of
// those templates is in the list the log shipper accepts.
//
// Real here: the request-record middleware, the mount recording, the bots routes and the record of bots, mounted in
// the order the backend's entry point uses. Stand-in: the bots service.
import { describe, expect, test } from "bun:test";
import type { Server } from "node:http";
import express from "express";
import { createRequestContextMiddleware, recordMountTemplates, type RequestEvent } from "../request-context.js";
import { REQUEST_LOG_ROUTE_TEMPLATES } from "../request-log-routes.js";
import { BotsRegistry } from "../bots-registry.js";
import { botsFromEnv, createBotsRouter, type BotsConfig } from "../routes/bots.js";
import { fakeRegistryStore } from "./helpers/fake-registry-store.js";

const ADDRESS = `0x${"ab".repeat(20)}`;
const KEY = "1".repeat(32);
type RequestRecord = Extract<RequestEvent, { event: "tinychat_request" }>;

async function world() {
  const waiting: Array<(record: RequestRecord) => void> = [];
  const sink = (event: RequestEvent) => { if (event.event === "tinychat_request") waiting.shift()?.(event); };
  const fetchImpl = (async (_input, init) => ((init?.method ?? "GET") === "GET" ? Response.json({ messages: [] }) : Response.json({ state: "active" }))) as typeof fetch;
  const config: BotsConfig = { ...botsFromEnv({ BOTS_ENABLED: "true", BOTS_TEST_ACCOUNTS: "*", BOTS_SERVICE_URL: "http://bots.test/", BOTS_SERVICE_SECRET: "s".repeat(48) })!, fetchImpl };
  const registry = new BotsRegistry(fakeRegistryStore(), { now: () => new Date("2026-11-19T00:00:00.000Z"), newKey: () => KEY });
  const auth: express.RequestHandler = (req, _res, next) => { req.user = { address: ADDRESS } as typeof req.user; next(); };

  const app = express();
  app.use(createRequestContextMiddleware(sink));
  recordMountTemplates(app);
  app.use(express.json());
  app.use("/api/bots", createBotsRouter({ config, authMiddleware: auth, registry }));
  const server = await new Promise<Server>(done => { const s = app.listen(0, "127.0.0.1", () => done(s)); });
  const listening = server.address();
  if (listening === null || typeof listening === "string") throw new Error("no port");
  const base = `http://127.0.0.1:${listening.port}`;

  /** Sends one request and returns its status with the record made for it. */
  const send = async (method: string, path: string, body?: unknown) => {
    const record = new Promise<RequestRecord>(done => { waiting.push(done); });
    const response = await fetch(`${base}${path}`, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    await response.arrayBuffer();
    return { status: response.status, record: await record };
  };
  return { send, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

describe("request record for the bot routes", () => {
  test("a request to a bot's routes is recorded under the route template", async () => {
    const run = await world();
    try {
      const created = await run.send("POST", "/api/bots", { name: "Research", shape: "sprout", colour: "teal" });
      expect([created.status, created.record.route]).toEqual([201, "/api/bots"]);
      const listed = await run.send("GET", "/api/bots");
      expect([listed.status, listed.record.route]).toEqual([200, "/api/bots"]);

      const calls: Array<[string, string, unknown, string]> = [
        ["PATCH", `/api/bots/${KEY}`, { name: "Notes" }, "/api/bots/:key"],
        ["GET", `/api/bots/${KEY}/messages`, undefined, "/api/bots/:key/messages"],
        ["POST", `/api/bots/${KEY}/messages`, { text: "hello" }, "/api/bots/:key/messages"],
        ["DELETE", `/api/bots/${KEY}`, undefined, "/api/bots/:key"],
      ];
      for (const [method, path, body, template] of calls) {
        const { status, record } = await run.send(method, path, body);
        // The record is for this request, names the template, and the template is one the log shipper accepts.
        expect([method, record.method, record.status, record.route]).toEqual([method, method, status, template]);
        expect(REQUEST_LOG_ROUTE_TEMPLATES).toContain(record.route);
        // The path that was requested is not in the record.
        expect(JSON.stringify(record)).not.toContain(KEY);
      }
    } finally { await run.close(); }
  });

  test("a path under the bots mount that matches no route is recorded as unmatched", async () => {
    const run = await world();
    try {
      const { status, record } = await run.send("GET", `/api/bots/${KEY}/no-such-route`);
      expect([status, record.route]).toEqual([404, "unmatched"]);
      expect(JSON.stringify(record)).not.toContain(KEY);
    } finally { await run.close(); }
  });
});
