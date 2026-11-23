import { expect, test } from "bun:test";
import express from "express";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { makePkhSpaceId } from "@tinycloud/sdk-core";
import { privateKeyToAccount } from "viem/accounts";
import type { TinyCloudNode } from "@tinycloud/node-sdk";

import type { BotsConfig } from "../routes/bots.js";
import { createTrustBotReadsRouter } from "../routes/trustbot-reads.js";
import { areaResources, type ReadArea } from "../trustbot-reads/areas.js";
import { TrustBotReadGrants } from "../trustbot-reads/grants.js";
import { backendGrantStore } from "../trustbot-reads/setup.js";
import { fakeBackendNode } from "./helpers/fake-backend-node";
import { computeDelegationCid, makeSignedTranscriptGrant } from "./helpers/transcript-grant";

test("the read settings API renews both expired areas and preserves a concurrent turn-off", async () => {
  const day = 86_400_000;
  let now = Date.parse("2026-11-23T12:00:00Z");
  const key = `0x${"11".repeat(32)}` as const;
  const address = privateKeyToAccount(key).address.toLowerCase();
  const did = `did:pkh:eip155:1:0x${"22".repeat(20)}`;
  const space = makePkhSpaceId(address, 1, "applications");
  const signedGrant = (...areas: ReadArea[]) => makeSignedTranscriptGrant({
    privateKey: key, now, audience: did, expiresAt: (now + day) / 1000,
    att: Object.fromEntries(areaResources(areas).map(({ service, path, actions }) => [
      `${space}/${service}/${path}`, Object.fromEntries(actions.map(action => [action, [{}]])),
    ])),
  });

  const { node } = fakeBackendNode();
  const activationStarted = Promise.withResolvers<void>();
  const releaseActivation = Promise.withResolvers<void>();
  let pauseActivation = false;
  const grants = new TrustBotReadGrants({
    reader: { did, computeDelegationCid } as Pick<TinyCloudNode, "did" | "useDelegation" | "computeDelegationCid">,
    store: backendGrantStore(node),
    host: "http://127.0.0.1:9137",
    sealSecret: new Uint8Array(32).fill(7),
    now: () => now,
    activate: async () => {
      if (pauseActivation) {
        activationStarted.resolve();
        await releaseActivation.promise;
      }
      return {} as never;
    },
  });

  const pushed: string[][] = [];
  const config = {
    serviceUrl: "http://bots.test", serviceSecret: "fixture", postTimeoutMs: 1000,
    accountAllowed: () => true, fetchImpl: async (_url, init) => {
      pushed.push(JSON.parse(init?.body as string).areas);
      return new Response(null, { status: 204 });
    },
  } satisfies BotsConfig;
  const app = express();
  app.use("/reads", createTrustBotReadsRouter({ grants, config, auth: (req, _res, next) => {
    req.user = { address } as typeof req.user;
    next();
  } }));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/reads`;
  const put = (area: string, body: unknown) => fetch(`${base}/${area}`, {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const envelope = ({ serialized, siwe, signature }: Awaited<ReturnType<typeof signedGrant>>) => ({ serialized, siwe, signature });

  try {
    expect((await put("meetings", { enabled: true, grant: envelope(await signedGrant("meetings")) })).status).toBe(200);
    const first = await signedGrant("meetings", "feed_chats");
    expect((await put("feed_chats", { enabled: true, grant: envelope(first) })).status).toBe(200);
    now += day;
    expect(await (await fetch(`${base}/renewal`)).json()).toMatchObject({
      renewAfter: now - day / 2, grantCid: first.cid, areas: { meetings: "ended", feed_chats: "ended" },
    });

    const replacement = await signedGrant("meetings", "feed_chats");
    const renewed = await put("renewal", { enabled: true, grant: envelope(replacement), replaces: first.cid });
    expect(renewed.status).toBe(200);
    expect(await renewed.json()).toMatchObject({ grantCid: replacement.cid, areas: { meetings: "on", feed_chats: "on" } });
    expect(pushed.at(-1)).toEqual(["meetings", "feed_chats"]);
    await expect(grants.access(address, "meetings")).resolves.toEqual({});
    await expect(grants.access(address, "feed_chats", areaResources(["feed_chats"])[0]!.path)).resolves.toEqual({});

    now += day * 3 / 4;
    const racing = await signedGrant("meetings", "feed_chats");
    pauseActivation = true;
    const pending = put("renewal", { enabled: true, grant: envelope(racing), replaces: replacement.cid });
    await Promise.race([activationStarted.promise, pending.then(() => { throw new Error("renewal did not activate"); })]);
    expect((await put("feed_chats", { enabled: false })).status).toBe(200);
    releaseActivation.resolve();

    expect(await (await pending).json()).toEqual({ error: "invalid_grant", code: "changed" });
    expect((await grants.status(address)).areas).toEqual({ meetings: "on", feed_chats: "off" });
    expect(pushed.at(-1)).toEqual(["meetings"]);
  } finally {
    releaseActivation.resolve();
    server.close();
  }
});
