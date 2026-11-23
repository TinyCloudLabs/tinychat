import { describe, expect, test } from "bun:test";
import express from "express";
import { createCsrfMiddleware, issueSessionToken } from "@tinyboilerplate/server";
import { createAuthMiddleware } from "../middleware/auth.js";
import { BotsRegistry } from "../bots-registry.js";
import { botsFromEnv, createBotsRouter, type BotsConfig } from "../routes/bots.js";
import { fakeRegistryStore } from "./helpers/fake-registry-store.js";

const sessionKey = `0x${"03".repeat(32)}`;
const owner = "0xAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaa";
const secret = "bots-test-secret-not-real";
const ID = "0123456789abcdef01234567";
const BINDING = "c".repeat(64);
const GONE = "f".repeat(32);

interface UpstreamCall { method: string; url: string; body: string | undefined }
type Upstream = (call: UpstreamCall) => Response | Promise<Response>;

/** The real router with a registry holding two bots besides Main, and a recording stand-in for the bots service. */
async function setup(upstream: Upstream, extra: Partial<BotsConfig> = {}) {
  const seen: UpstreamCall[] = [];
  const fetchImpl = (async (input, init) => {
    const call = { method: init?.method ?? "GET", url: String(input), body: typeof init?.body === "string" ? init.body : undefined };
    seen.push(call);
    return upstream(call);
  }) as typeof fetch;
  const config = botsFromEnv({ BOTS_ENABLED: "true", BOTS_TEST_ACCOUNTS: owner, BOTS_SERVICE_URL: "http://bots.test/", BOTS_SERVICE_SECRET: secret })!;
  let next = 0;
  const registry = new BotsRegistry(fakeRegistryStore(), { now: () => new Date("2026-11-19T00:00:00.000Z"), newKey: () => (++next).toString(16).repeat(32) });
  const keys: string[] = [];
  for (const name of ["Scout", "Ledger"]) {
    const created = await registry.create(owner, { name, shape: "sprout", colour: "teal" }, 3);
    if (!created.ok) throw new Error(created.error);
    keys.push(created.bot.key);
  }
  const app = express();
  app.use(express.json()); app.use(createCsrfMiddleware());
  // As index.ts wires it: the registry says which bots Main may message.
  const listForTurn = (_ownerDid: string, sourceKey: string) => registry.listForTurn(owner, sourceKey);
  app.use("/api/bots", createBotsRouter({ config: { ...config, listForTurn, ...extra, fetchImpl }, authMiddleware: createAuthMiddleware(sessionKey), registry }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  const base = `http://127.0.0.1:${address.port}/api/bots/main`;
  const send = async (method: string, path: string, body?: unknown) => fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", "X-Requested-With": "XMLHttpRequest", authorization: `Bearer ${(await issueSessionToken(owner, sessionKey)).token}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { seen, keys, send, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

const proposal = (targets: string[], over: Record<string, unknown> = {}) => ({
  id: ID, kind: "action", action: "message_bots", state: "pending", askedAt: "2026-11-19T12:00:00.000Z", expiresAt: "2026-11-20T12:00:00.000Z",
  outside: false, targets, text: "Status by noon, please.", binding: BINDING, ...over,
});

describe("proposals on the requests routes", () => {
  test("a listed proposal is rebuilt from its fields, each recipient with its current name, a gone one with none", async () => {
    let targets: string[] = [];
    const run = await setup(() => Response.json({ requests: [{ ...proposal(targets), title: "Approve now!", owner: "x" }] }));
    try {
      targets = [run.keys[0]!, GONE];
      const response = await run.send("GET", "/requests");
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ requests: [{ ...proposal([]), targets: [{ key: run.keys[0], name: "Scout" }, { key: GONE, name: null }] }] });
    } finally { await run.close(); }
  });

  test("a proposal outside the contract's shape is refused", async () => {
    for (const over of [{ state: "approved" }, { action: "delete_bots" }, { binding: "nothex" }, { targets: ["../x"] }, { undelivered: false }]) {
      const run = await setup(() => Response.json({ requests: [proposal([GONE], over)] }));
      try { expect((await run.send("GET", "/requests")).status).toBe(502); } finally { await run.close(); }
    }
  });

  test("Send goes on as exactly the binding and the bots Main may message now; anything else is refused unsent", async () => {
    const run = await setup(() => Response.json(proposal([GONE], { state: "sending", text: undefined, binding: undefined })));
    try {
      for (const bad of [{ decision: "approve" }, { decision: "approve", binding: "x" }, { decision: "approve", binding: BINDING, messageableBotKeys: [GONE] }, { decision: "approve", binding: BINDING.toUpperCase() }]) {
        expect((await run.send("POST", `/requests/${ID}/answer`, bad)).status).toBe(400);
      }
      expect(run.seen).toHaveLength(0);
      const response = await run.send("POST", `/requests/${ID}/answer`, { decision: "approve", binding: BINDING });
      expect(response.status).toBe(200);
      expect(((await response.json()) as { state: string }).state).toBe("sending");
      expect(run.seen[0]!.url).toBe(`http://bots.test/v1/bots/main/requests/${ID}/answer`);
      expect(JSON.parse(run.seen[0]!.body!)).toEqual({ decision: "approve", binding: BINDING, messageableBotKeys: [...run.keys].sort() });
    } finally { await run.close(); }
  });

  test("Send is not passed on when the bots Main may message cannot be read", async () => {
    const run = await setup(() => Response.json({}), { listForTurn: async () => { throw new Error("record unreadable"); } });
    try {
      expect((await run.send("POST", `/requests/${ID}/answer`, { decision: "approve", binding: BINDING })).status).toBe(502);
      expect(run.seen).toHaveLength(0);
    } finally { await run.close(); }
  });
});
