import { expect, test } from "bun:test";
import { createCipheriv, hkdfSync, randomBytes } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import express from "express";
import type { TinyCloudNode } from "@tinycloud/node-sdk";

import { createTrustBotReadsRouter } from "../routes/trustbot-reads.js";
import type { BotsConfig } from "../routes/bots.js";
import { TrustBotReadGrants, TRUSTBOT_READ_GRANT_KEY_PREFIX, type ReadGrantStore } from "../trustbot-reads/grants.js";

const OWNER = "0x" + "11".repeat(20);
const KEY = TRUSTBOT_READ_GRANT_KEY_PREFIX + OWNER;
const SECRET = new Uint8Array(32).fill(7);
const record = { v: 1, areas: ["meetings"], cid: "current", expiresAt: Date.now() + 86_400_000,
  serialized: "fixture", siwe: "fixture", signature: "fixture", replacedGrantCid: "prior" };

function seal(value: unknown) {
  const key = Buffer.from(hkdfSync("sha256", SECRET, Buffer.alloc(0), "tinychat.trustbot-reads.grants/v1", 32));
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(KEY));
  return Buffer.concat([nonce, cipher.update(JSON.stringify(value)), cipher.final(), cipher.getAuthTag()]).toString("base64");
}

async function setup() {
  let stored = { value: seal(record), etag: "1" };
  let race: (() => void) | undefined;
  const store: ReadGrantStore = {
    get: async key => key === KEY ? stored : undefined,
    put: async (key, value, condition) => {
      expect(key).toBe(KEY);
      if (race) { const run = race; race = undefined; run(); }
      if (!("ifMatch" in condition) || condition.ifMatch !== stored.etag) return false;
      stored = { value, etag: String(Number(stored.etag) + 1) };
      return true;
    },
    delete: async () => { throw new Error("cleanup must preserve the active grant"); },
  };
  const grants = new TrustBotReadGrants({
    reader: { did: "did:key:reader" } as TinyCloudNode, store, host: "http://node.test", sealSecret: SECRET,
  });
  const config = { accountAllowed: () => true } as BotsConfig;
  const app = express();
  app.use("/reads", createTrustBotReadsRouter({ grants, config, auth: (req, _res, next) => {
    req.user = { address: OWNER } as typeof req.user;
    next();
  } }));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/reads`;
  return {
    grants, config, close: () => server.close(),
    ack: (cid: string) => fetch(`${base}/renewal/revoked`, {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ cid }),
    }),
    race: (next: typeof record) => { race = () => { stored = { value: seal(next), etag: "2" }; }; },
  };
}

test("owner acknowledgement durably clears only the matching replaced grant", async () => {
  const h = await setup();
  try {
    expect((await h.ack("other")).status).toBe(204);
    expect((await h.grants.renewalStatus(OWNER)).replacedGrantCid).toBe("prior");
    expect((await h.ack("prior")).status).toBe(204);
    expect(await h.grants.renewalStatus(OWNER)).toMatchObject({ grantCid: "current", replacedGrantCid: null, areas: { meetings: "on" } });
    expect((await h.ack("prior")).status).toBe(204);
  } finally { h.close(); }
});

test("a concurrent replacement is not overwritten by an old revoke acknowledgement", async () => {
  const h = await setup();
  try {
    h.race({ ...record, cid: "new-current", replacedGrantCid: "current" });
    expect((await h.ack("prior")).status).toBe(204);
    expect(await h.grants.renewalStatus(OWNER)).toMatchObject({ grantCid: "new-current", replacedGrantCid: "current" });
  } finally { h.close(); }
});

test("the acknowledgement route preserves the account allowlist gate", async () => {
  const h = await setup();
  try {
    h.config.accountAllowed = () => false;
    expect((await h.ack("prior")).status).toBe(404);
    expect((await h.grants.renewalStatus(OWNER)).replacedGrantCid).toBe("prior");
  } finally { h.close(); }
});
