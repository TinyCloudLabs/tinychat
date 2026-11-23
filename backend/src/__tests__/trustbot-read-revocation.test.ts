import { expect, test } from "bun:test";
import type { TinyCloudNode } from "@tinycloud/node-sdk";

import { areaResources } from "../trustbot-reads/areas.js";
import { TrustBotReadGrants } from "../trustbot-reads/grants.js";
import { backendGrantStore } from "../trustbot-reads/setup.js";
import { fakeBackendNode } from "./helpers/fake-backend-node";
import { computeDelegationCid, makeSignedTranscriptGrant } from "./helpers/transcript-grant";

test("a committed replacement retains its superseded CID across backend instances", async () => {
  const { node } = fakeBackendNode();
  const day = 86_400_000;
  const now = Date.parse("2026-11-23T12:00:00Z");
  const did = "did:pkh:eip155:1:0x" + "22".repeat(20);
  const reader = { did, computeDelegationCid } as Pick<TinyCloudNode, "did" | "useDelegation" | "computeDelegationCid">;
  const options = {
    reader,
    store: backendGrantStore(node),
    host: "http://127.0.0.1:9137",
    sealSecret: new Uint8Array(32).fill(7),
    now: () => now,
    activate: async () => ({}) as never,
  };
  const { address, spaceId } = await makeSignedTranscriptGrant({ now });
  const sign = (expiresAt: number) => makeSignedTranscriptGrant({
    now, audience: did, expiresAt: expiresAt / 1000,
    att: Object.fromEntries(areaResources(["meetings"]).map(({ service, path, actions }) => [
      `${spaceId}/${service}/${path}`, Object.fromEntries(actions.map(action => [action, [{}]])),
    ])),
  });
  const { cid: prior, serialized, siwe, signature } = await sign(now + day);
  const replacement = await sign(now + 2 * day);
  const grants = new TrustBotReadGrants(options);
  await grants.enable(address, "meetings", { serialized, siwe, signature });
  await grants.renew(address, prior, {
    serialized: replacement.serialized, siwe: replacement.siwe, signature: replacement.signature,
  });

  const next = new TrustBotReadGrants(options);
  expect(await next.renewalStatus(address)).toMatchObject({
    grantCid: replacement.cid, replacedGrantCid: prior, areas: { meetings: "on", feed_chats: "off" },
  });
});
