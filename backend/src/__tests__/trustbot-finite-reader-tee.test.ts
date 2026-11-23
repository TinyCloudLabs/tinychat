import { expect, test } from "bun:test";
import express from "express";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { makePkhSpaceId } from "@tinycloud/sdk-core";
import type { TinyCloudNode } from "@tinycloud/node-sdk";
import { privateKeyToAccount } from "viem/accounts";

import { signedCallHeader } from "../bots-signed-call.js";
import type { BotsConfig } from "../routes/bots.js";
import {
  createTrustBotReadsInternalRouter, createTrustBotReadsRouter, TRUSTBOT_READS_INTERNAL_PREFIX,
} from "../routes/trustbot-reads.js";
import { areaResources } from "../trustbot-reads/areas.js";
import { TRUSTBOT_READ_GRANT_KEY_PREFIX, TrustBotReadGrants } from "../trustbot-reads/grants.js";
import { backendGrantStore, startTrustBotReads, trustbotReadsFromEnv } from "../trustbot-reads/setup.js";
import { fakeBackendNode } from "./helpers/fake-backend-node";
import { computeDelegationCid, makeSignedTranscriptGrant } from "./helpers/transcript-grant";

const host = "http://127.0.0.1:9137";
const callSecret = "c".repeat(64);
const backendDid = `did:pkh:eip155:1:0x${"12".repeat(20)}`;
const oldDid = `did:pkh:eip155:1:0x${"23".repeat(20)}`;

function fakeReader(did: string, activate = () => {}) {
  return {
    did,
    computeDelegationCid,
    async useDelegation() {
      activate();
      return { kv: {}, sql: {} };
    },
  } as unknown as TinyCloudNode;
}

function fakeEnclave(activate?: () => void) {
  const roots: Buffer[] = [];
  const paths: string[] = [];
  return {
    roots,
    paths,
    dstack: { async getKey(path: string) {
      paths.push(path);
      const root = Buffer.alloc(32, 17);
      roots.push(root);
      return root;
    } },
    async createIdentity({ privateKey }: { privateKey: string }) {
      const address = privateKeyToAccount(privateKey as `0x${string}`).address;
      const did = `did:pkh:eip155:1:${address}`;
      return { did, node: fakeReader(did, activate) };
    },
  };
}

test("finite reads require the enclave and derive the same reader DID on every boot", async () => {
  const env = { TRUSTBOT_READS_ENABLED: "true", BOTS_BACKEND_CALL_SECRET: callSecret };
  expect(trustbotReadsFromEnv(env)).toEqual({ callSecret });
  expect(trustbotReadsFromEnv({ ...env, TRUSTBOT_READS_ENABLED: "false" })).toBeUndefined();

  const { node: backendNode } = fakeBackendNode();
  const enclave = fakeEnclave();
  const options = { backendNode, backendDid, host, otherDelegateDids: [oldDid], ...enclave };
  const first = await startTrustBotReads(options);
  const second = await startTrustBotReads(options);
  expect(first?.serviceDid).toMatch(/^did:pkh:eip155:1:0x[0-9a-fA-F]{40}$/);
  expect(second?.serviceDid).toBe(first!.serviceDid);
  expect(enclave.paths).toEqual(Array(2).fill("tinychat/trustbot-finite-reads/reader-root/v1"));
  expect(enclave.roots.every(root => root.every(byte => byte === 0))).toBe(true);

  expect(await startTrustBotReads({ ...options, otherDelegateDids: [first!.serviceDid.toLowerCase()] })).toBeUndefined();
  expect(await startTrustBotReads({ ...options, backendDid: first!.serviceDid })).toBeUndefined();
  let signedIn = false;
  const unavailable = await startTrustBotReads({
    ...options,
    dstack: { async getKey() { throw new Error("fixture socket unavailable"); } },
    async createIdentity(config) {
      signedIn = true;
      return enclave.createIdentity(config);
    },
  });
  expect(unavailable).toBeUndefined();
  expect(signedIn).toBe(false);
});

test("a legacy audience is refused cleanly and the owner can approve the derived reader", async () => {
  const { node: backendNode, values } = fakeBackendNode();
  const ownerKey = `0x${"31".repeat(32)}` as const;
  const address = privateKeyToAccount(ownerKey).address.toLowerCase();
  const space = makePkhSpaceId(address, 1, "applications");
  const now = Date.now();
  const signedGrant = (audience: string) => makeSignedTranscriptGrant({
    privateKey: ownerKey,
    audience,
    now,
    expiresAt: Math.floor(now / 1_000) + 86_400,
    att: Object.fromEntries(areaResources(["meetings"]).map(({ service, path, actions }) => [
      `${space}/${service}/${path}`, Object.fromEntries(actions.map(action => [action, [{}]])),
    ])),
  });

  const oldGrant = await signedGrant(oldDid);
  const legacy = new TrustBotReadGrants({
    reader: fakeReader(oldDid), store: backendGrantStore(backendNode), host, sealSecret: Buffer.alloc(32, 61),
  });
  await legacy.enable(address, "meetings", oldGrant);
  const legacyKey = `${TRUSTBOT_READ_GRANT_KEY_PREFIX}${address}`;
  const oldRecord = values.get(legacyKey);
  expect(typeof oldRecord).toBe("string");

  let activations = 0;
  const enclave = fakeEnclave(() => { activations++; });
  const options = { backendNode, backendDid, host, otherDelegateDids: [oldDid], ...enclave };
  const grants = await startTrustBotReads(options);
  expect(grants).toBeDefined();
  if (!grants) throw new Error("fixture enclave reader did not start");
  const config = {
    serviceUrl: "http://bots.test", serviceSecret: "fixture", postTimeoutMs: 1_000,
    accountAllowed: (who: string) => who === address,
    fetchImpl: async () => new Response(null, { status: 204 }),
  } satisfies BotsConfig;
  const app = express();
  const settingsPath = "/api/bots/main/reads";
  app.use(settingsPath, createTrustBotReadsRouter({ grants, config, auth: (req, _res, next) => {
    req.user = { address } as typeof req.user;
    next();
  } }));
  app.use(TRUSTBOT_READS_INTERNAL_PREFIX, createTrustBotReadsInternalRouter({ grants, config, callSecret }));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const enable = ({ serialized, siwe, signature }: Awaited<ReturnType<typeof signedGrant>>) => fetch(`${base}${settingsPath}/meetings`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled: true, grant: { serialized, siwe, signature } }),
  });
  try {
    const settings = await fetch(`${base}${settingsPath}`);
    expect(settings.status).toBe(200);
    expect(await settings.json()).toMatchObject({ serviceDid: grants.serviceDid, grantCid: null, areas: { meetings: "off" } });

    const path = `${TRUSTBOT_READS_INTERNAL_PREFIX}/tinycloud_find_meetings`;
    const body = JSON.stringify({ args: {} });
    const authorization = signedCallHeader(callSecret, {
      direction: "to-backend", environment: "private", owner: `did:pkh:eip155:1:${address}`,
      bot: "main", method: "POST", path, body,
    });
    const read = await fetch(`${base}${path}`, { method: "POST", headers: { authorization }, body });
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual({ ok: false, error: "off" });

    const stale = await enable(oldGrant);
    expect(stale.status).toBe(400);
    expect(await stale.json()).toEqual({ error: "invalid_grant", code: "wrong_delegatee" });
    expect(activations).toBe(0);

    const fresh = await signedGrant(grants.serviceDid);
    const approved = await enable(fresh);
    expect(approved.status).toBe(200);
    expect(await approved.json()).toMatchObject({ serviceDid: grants.serviceDid, grantCid: fresh.cid, areas: { meetings: "on" } });
    expect(activations).toBeGreaterThan(0);
    expect(values.get(legacyKey)).toBe(oldRecord);
    const restarted = await startTrustBotReads(options);
    expect(await restarted?.status(address)).toMatchObject({ grantCid: fresh.cid, areas: { meetings: "on" } });
  } finally {
    server.close();
  }
});
