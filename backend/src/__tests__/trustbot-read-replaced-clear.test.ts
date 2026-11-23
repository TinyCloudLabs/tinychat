import { expect, test } from "bun:test";
import express from "express";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { makePkhSpaceId } from "@tinycloud/sdk-core";
import { privateKeyToAccount } from "viem/accounts";
import type { TinyCloudNode } from "@tinycloud/node-sdk";

import type { BotsConfig } from "../routes/bots.js";
import { createTrustBotReadsRouter } from "../routes/trustbot-reads.js";
import { areaResources } from "../trustbot-reads/areas.js";
import { TrustBotReadGrants } from "../trustbot-reads/grants.js";
import { backendGrantStore } from "../trustbot-reads/setup.js";
import { fakeBackendNode } from "./helpers/fake-backend-node";
import { computeDelegationCid, makeSignedTranscriptGrant } from "./helpers/transcript-grant";

test("the owner clears the replaced grant after the node confirms its revoke, and only that grant", async () => {
  const day = 86_400_000;
  const now = Date.parse("2026-11-23T12:00:00Z");
  const key = `0x${"11".repeat(32)}` as const;
  const address = privateKeyToAccount(key).address.toLowerCase();
  const did = `did:pkh:eip155:1:0x${"22".repeat(20)}`;
  const space = makePkhSpaceId(address, 1, "applications");
  const signedGrant = (expiresAt: number) => makeSignedTranscriptGrant({
    privateKey: key, now, audience: did, expiresAt: expiresAt / 1000,
    att: Object.fromEntries(areaResources(["meetings"]).map(({ service, path, actions }) => [
      `${space}/${service}/${path}`, Object.fromEntries(actions.map(action => [action, [{}]])),
    ])),
  });

  const { node } = fakeBackendNode();
  const grants = new TrustBotReadGrants({
    reader: { did, computeDelegationCid } as Pick<TinyCloudNode, "did" | "useDelegation" | "computeDelegationCid">,
    store: backendGrantStore(node),
    host: "http://127.0.0.1:9137",
    sealSecret: new Uint8Array(32).fill(7),
    now: () => now,
    activate: async () => ({}) as never,
  });
  const config = {
    serviceUrl: "http://bots.test", serviceSecret: "fixture", postTimeoutMs: 1000,
    accountAllowed: () => true, fetchImpl: async () => new Response(null, { status: 204 }),
  } satisfies BotsConfig;
  const app = express();
  app.use("/reads", createTrustBotReadsRouter({ grants, config, auth: (req, _res, next) => {
    req.user = { address } as typeof req.user;
    next();
  } }));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/reads`;
  const envelope = ({ serialized, siwe, signature }: Awaited<ReturnType<typeof signedGrant>>) => ({ serialized, siwe, signature });
  const replacedNow = async () => (await (await fetch(`${base}/renewal`)).json() as { replacedGrantCid: string | null }).replacedGrantCid;

  try {
    const first = await signedGrant(now + 2 * day);
    await grants.enable(address, "meetings", envelope(first));
    const second = await signedGrant(now + 3 * day);
    await grants.renew(address, first.cid, envelope(second));
    expect(await replacedNow()).toBe(first.cid);

    expect((await fetch(`${base}/renewal`, { method: "DELETE" })).status).toBe(400);
    for (const spelling of ["prior", first.cid.toUpperCase(), `B${first.cid.slice(1)}`, `u${first.cid.slice(1)}`, `Qm${"a".repeat(44)}`]) {
      expect((await fetch(`${base}/renewal?replaced=${spelling}`, { method: "DELETE" })).status).toBe(400);
    }
    expect(await replacedNow()).toBe(first.cid);
    expect((await fetch(`${base}/renewal?replaced=${second.cid}`, { method: "DELETE" })).status).toBe(204);
    expect(await replacedNow()).toBe(first.cid);

    expect((await fetch(`${base}/renewal?replaced=${first.cid}`, { method: "DELETE" })).status).toBe(204);
    expect(await replacedNow()).toBeNull();
    expect(await (await fetch(`${base}/renewal`)).json()).toMatchObject({ grantCid: second.cid, areas: { meetings: "on" } });
    expect((await fetch(`${base}/renewal?replaced=${first.cid}`, { method: "DELETE" })).status).toBe(204);
  } finally {
    server.close();
  }
});
