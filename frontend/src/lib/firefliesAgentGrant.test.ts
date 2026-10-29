import { describe, expect, it } from "bun:test";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { CONNECTORS_KV_PREFIX, SESSION_EXPIRATION_MS, TINYCHAT_KEY_PREFIX } from "@tinyboilerplate/core";
import { makePkhSpaceId, pkhDid } from "@tinycloud/sdk-core";

import { firefliesAgentGrantPermissions, pairFirefliesAgent } from "./firefliesAgentGrant.js";

const OWNER = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
const RECIPIENT = `did:key:z${"1".repeat(40)}#z${"1".repeat(40)}`;
const HOST = "https://node.test";
const KV_PATH = `${CONNECTORS_KV_PREFIX}/credentials/fireflies`;
const KEY_PATH = `${TINYCHAT_KEY_PREFIX}connectors/fireflies`;
const OWNER_DID = pkhDid(OWNER, 1);
const SPACE_ID = makePkhSpaceId(OWNER, 1, "applications");
const KEY_URI = `urn:tinycloud:encryption:${OWNER_DID}:default/${KEY_PATH}`;
const EXPIRY = new Date(Date.now() + SESSION_EXPIRATION_MS - 24 * 60 * 60 * 1000);
const PARENT_EXPIRY = new Date(Date.now() + SESSION_EXPIRATION_MS).toISOString();
const PERMISSIONS = [
  { service: "tinycloud.kv", space: SPACE_ID, path: KV_PATH, actions: ["get"] },
  { service: "tinycloud.encryption", space: "encryption", path: KEY_URI, actions: ["decrypt"] },
];

function tcwStub(overrides: Record<string, unknown> = {}): TinyCloudWeb {
  return {
    address: () => OWNER,
    chainId: () => 1,
    hosts: [HOST],
    session: () => ({ siwe: `Expiration Time: ${PARENT_EXPIRY}` }),
    requestPermissions: async () => { throw new Error("must not request more permissions"); },
    delegateTo: async () => ({
      prompted: false,
      delegation: {
        cid: "urn:cid:fireflies-grant",
        delegateDID: RECIPIENT.split("#", 1)[0],
        path: KV_PATH,
        actions: ["tinycloud.kv/get"],
        spaceId: SPACE_ID,
        expiry: EXPIRY,
        delegationHeader: { Authorization: "Bearer header.payload.signature" },
        resources: [
          { service: "encryption", space: "encryption", path: KEY_URI, actions: ["tinycloud.encryption/decrypt"] },
          { service: "kv", space: SPACE_ID, path: KV_PATH, actions: ["tinycloud.kv/get"] },
        ],
        disableSubDelegation: true,
        ownerAddress: OWNER,
        chainId: 1,
        host: HOST,
      },
    }),
    ...overrides,
  } as unknown as TinyCloudWeb;
}

describe("Fireflies agent pairing", () => {
  it("limits the child grant to the Fireflies envelope and its named key", () => {
    expect(firefliesAgentGrantPermissions(OWNER, 1)).toEqual(PERMISSIONS);
  });

  it("requires at least 29 days on the signed parent session before signing", async () => {
    let signed = false;
    const tooSoon = new Date(Date.now() + SESSION_EXPIRATION_MS - 2 * 24 * 60 * 60 * 1000).toISOString();
    const tcw = tcwStub({
      session: () => ({ siwe: `Expiration Time: ${tooSoon}` }),
      delegateTo: async () => { signed = true; throw new Error("must not be called"); },
    });

    await expect(pairFirefliesAgent(tcw, RECIPIENT)).rejects.toThrow("less than 29 days left");
    expect(signed).toBe(false);
  });

  it("rejects non-session-key recipients before signing", async () => {
    let signed = false;
    const tcw = tcwStub({ delegateTo: async () => { signed = true; throw new Error("must not be called"); } });
    await expect(pairFirefliesAgent(tcw, "did:pkh:eip155:1:0x1234")).rejects.toThrow("agent session DID");
    expect(signed).toBe(false);
  });

  it("exports an exact terminal grant using the signed session without a wallet prompt", async () => {
    let delegation: { recipient: string; permissions: unknown; options: unknown } | undefined;
    const tcw = tcwStub({
      requestPermissions: async () => { throw new Error("must not request more permissions"); },
      delegateTo: async (recipient: string, permissions: unknown, options: unknown) => {
        delegation = { recipient, permissions, options };
        return (tcwStub() as unknown as { delegateTo: () => Promise<unknown> }).delegateTo();
      },
    });

    const artifactText = await pairFirefliesAgent(tcw, RECIPIENT);
    const artifact = JSON.parse(artifactText);
    const expiryMs = SESSION_EXPIRATION_MS - 24 * 60 * 60 * 1000;
    expect(delegation).toEqual({
      recipient: RECIPIENT.split("#", 1)[0],
      permissions: PERMISSIONS,
      options: { expiry: expiryMs, disableSubDelegation: true, requireActivation: true },
    });
    expect(artifact).toMatchObject({
      kind: "tinychat.fireflies.named-grant",
      version: 1,
      ownerDid: OWNER_DID,
      recipientDid: RECIPIENT.split("#", 1)[0],
      cid: "urn:cid:fireflies-grant",
      expiresAt: EXPIRY.toISOString(),
      delegation: { disableSubDelegation: true, delegateDID: RECIPIENT.split("#", 1)[0], host: HOST },
    });
    expect(artifact.delegation.resources).toEqual([
      { service: "encryption", space: "encryption", path: KEY_URI, actions: ["tinycloud.encryption/decrypt"] },
      { service: "kv", space: SPACE_ID, path: KV_PATH, actions: ["tinycloud.kv/get"] },
    ]);
  });
});
