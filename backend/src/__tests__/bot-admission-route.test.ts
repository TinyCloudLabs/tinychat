// POST /api/internal/bots/admit: the verdict comes from the owner named by the signed DID, about the signed source bot;
// anything that does not verify is refused before a record is read. Calls are signed with the bots service's own copy
// of the signing module, as its admission relay signs them. Details: TC-3809
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import express from "express";
import { createCsrfMiddleware } from "@tinyboilerplate/server";
import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { BotsRegistry } from "../bots-registry.js";
import { BOT_ADMISSION_PATH, botAdmissionSecret, mountBotAdmissionRoute } from "../routes/bot-admission.js";
import { createApiBodyParser } from "../body-parsing.js";
import { signClaims, signedCallHeader, bodyHash, type Call } from "../../../bots/src/signed-call";
import { fakeRegistryStore } from "./helpers/fake-registry-store.js";

const secret = "k".repeat(64);
const ownerAddress = `0x${"ab".repeat(20)}`;
const otherAddress = `0x${"cd".repeat(20)}`;
const owner = `did:pkh:eip155:1:${ownerAddress}`;
const other = `did:pkh:eip155:1:${otherAddress}`;
const sibling = "a".repeat(32);
const othersBot = "b".repeat(32);
const T0 = new Date("2026-11-22T00:00:00.000Z");

const kv = fakeRegistryStore();
let reads = 0;
const store = { ...kv, get: (key: string, options: Parameters<typeof kv.get>[1]) => { reads += 1; return kv.get(key, options); } };
let server: Server;
let url: string;

beforeAll(async () => {
  const keys = [sibling, othersBot];
  const registry = new BotsRegistry(store, { now: () => T0, newKey: () => keys.shift()! });
  expect(await registry.create(ownerAddress, { name: "Scout", shape: "sprout", colour: "teal" }, 3)).toMatchObject({ ok: true });
  expect(await registry.create(otherAddress, { name: "Other", shape: "sprout", colour: "teal" }, 3)).toMatchObject({ ok: true });
  const app = express();
  mountBotAdmissionRoute(app, secret, registry);
  // What follows the route in the backend: a call that reached these would not be answered by the route.
  app.use(createApiBodyParser());
  app.use(createCsrfMiddleware());
  app.use((_req, res) => { res.status(418).end(); });
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  url = `http://127.0.0.1:${port}${BOT_ADMISSION_PATH}`;
});
afterAll(() => {
  const { promise, resolve } = Promise.withResolvers<void>();
  server.close(() => resolve());
  return promise;
});

const body = (fields: Record<string, unknown>) => JSON.stringify(fields);
const call = (signedOwner: string, signedBot: string, payload: string, overrides: Partial<Call> = {}): Call => ({
  direction: "to-backend", environment: "private", owner: signedOwner, bot: signedBot, method: "POST", path: BOT_ADMISSION_PATH,
  body: payload, ...overrides,
});
const post = (authorization: string | undefined, payload: string, target = url) => fetch(target, {
  method: "POST", body: payload,
  headers: { "content-type": "application/json", ...(authorization === undefined ? {} : { authorization }) },
});
/** One signed call, as the relay sends it. */
async function admit(signedOwner: string, signedBot: string, fields: Record<string, unknown>) {
  const payload = body(fields);
  const response = await post(signedCallHeader(secret, call(signedOwner, signedBot, payload)), payload);
  return { status: response.status, verdict: response.status === 200 ? await response.json() : undefined };
}

describe("POST /api/internal/bots/admit", () => {
  test("a valid signed call gets the registry's verdict for the signed owner's two active bots", async () => {
    expect(await admit(owner, "main", { owner, sourceKey: "main", targetKey: sibling })).toEqual({ status: 200, verdict: { admitted: true } });
    expect(await admit(owner, sibling, { owner, sourceKey: sibling, targetKey: "main" })).toEqual({ status: 200, verdict: { admitted: true } });
    expect(await admit(owner, "main", { owner, sourceKey: "main", targetKey: "c".repeat(32) })).toEqual({ status: 200, verdict: { admitted: false, reason: "unknown_target" } });
  });

  test("the owner is the signed owner DID: a body naming another owner is refused, and another owner's bot is unknown", async () => {
    expect(await admit(owner, "main", { owner: other, sourceKey: "main", targetKey: othersBot })).toEqual({ status: 400, verdict: undefined });
    // Signed for one owner, the other owner's bot key is not in that owner's record.
    expect(await admit(owner, "main", { owner, sourceKey: "main", targetKey: othersBot })).toEqual({ status: 200, verdict: { admitted: false, reason: "unknown_target" } });
    expect(await admit(other, "main", { owner: other, sourceKey: "main", targetKey: sibling })).toEqual({ status: 200, verdict: { admitted: false, reason: "unknown_target" } });
    expect(await admit(other, sibling, { owner: other, sourceKey: sibling, targetKey: "main" })).toEqual({ status: 200, verdict: { admitted: false, reason: "unknown_source" } });
  });

  test("the source is the signed bot: one bot cannot ask on behalf of another", async () => {
    expect(await admit(owner, "main", { owner, sourceKey: sibling, targetKey: "main" })).toEqual({ status: 400, verdict: undefined });
    expect(await admit(owner, sibling, { owner, sourceKey: "main", targetKey: sibling })).toEqual({ status: 400, verdict: undefined });
    for (const fields of [{ owner, sourceKey: "main" }, { owner, sourceKey: "main", targetKey: "MAIN" }, { owner, sourceKey: "main", targetKey: sibling, extra: 1 }]) {
      expect((await admit(owner, "main", fields)).status).toBe(400);
    }
  });

  test("unsigned, forged, wrong-direction, wrong-environment, altered, expired and replayed calls are refused before any read", async () => {
    const payload = body({ owner, sourceKey: "main", targetKey: sibling });
    const before = reads;
    const now = Date.now();
    const expired = signClaims(secret, {
      v: 1, dir: "to-backend", env: "private", owner, bot: "main", method: "POST", path: BOT_ADMISSION_PATH,
      body: bodyHash(payload), exp: now - 60_000, nonce: "e".repeat(32),
    });
    const refused: Array<[string | undefined, string, string?]> = [
      [undefined, payload],
      [`Bearer ${secret}`, payload],
      [signedCallHeader("f".repeat(64), call(owner, "main", payload)), payload],
      [signedCallHeader(secret, call(owner, "main", payload, { direction: "to-service" })), payload],
      [signedCallHeader(secret, call(owner, "main", payload, { environment: "regular" })), payload],
      [signedCallHeader(secret, call(owner, "main", payload, { method: "PUT" })), payload],
      [signedCallHeader(secret, call(owner, "main", payload, { path: "/api/bots/main/messages" })), payload],
      [signedCallHeader(secret, call(owner, "main", payload)), body({ owner, sourceKey: "main", targetKey: "c".repeat(32) })],
      [signedCallHeader(secret, call(owner, "main", payload)), payload, `${url}?x=1`],
      [`TinyCloud-Signed ${expired}`, payload],
    ];
    for (const [authorization, sent, target] of refused) {
      expect((await post(authorization, sent, target)).status).toBe(401);
    }
    expect(reads).toBe(before);

    const once = signedCallHeader(secret, call(owner, "main", payload));
    expect((await post(once, payload)).status).toBe(200);
    expect((await post(once, payload)).status).toBe(401);
  });

  test("the route needs a 256-bit secret of its own", () => {
    expect(botAdmissionSecret({})).toBeUndefined();
    expect(botAdmissionSecret({ BOTS_BACKEND_CALL_SECRET: "" })).toBeUndefined();
    expect(botAdmissionSecret({ BOTS_BACKEND_CALL_SECRET: "s".repeat(42) })).toBeUndefined();
    expect(botAdmissionSecret({ BOTS_BACKEND_CALL_SECRET: secret, BOTS_SERVICE_SECRET: secret })).toBeUndefined();
    expect(botAdmissionSecret({ BOTS_BACKEND_CALL_SECRET: secret, BOTS_SERVICE_SECRET: "t".repeat(64) })).toBe(secret);
  });
});
