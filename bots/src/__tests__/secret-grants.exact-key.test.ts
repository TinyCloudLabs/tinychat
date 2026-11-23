import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import type { CheckedApprovalResult, Ed25519PrivateJwk } from "@tinycloud/share-envelope/links";
import * as realLinks from "@tinycloud/share-envelope/links";
import { privateKeyToAccount } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";
import { MAX_GRANT_SECONDS, secretPermissions, verifiedGrant } from "../secret-grants";

// A secret saved with its own key is opened by a grant for that exact key (TC-3284); the whole-network grant stays for
// secrets saved before. Fake keys only.
const OWNER_KEY = privateKeyToAccount(`0x${"11".repeat(32)}`);
const OTHER_KEY = privateKeyToAccount(`0x${"22".repeat(32)}`);
const OWNER = `did:pkh:eip155:1:${OWNER_KEY.address.toLowerCase()}`;
const NETWORK = `urn:tinycloud:encryption:did:pkh:eip155:1:${OWNER_KEY.address}:default`;
const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 10, 22, 12, 0);

function recap(att: Record<string, unknown>): string {
  return `urn:recap:${Buffer.from(JSON.stringify({ att, prf: [] })).toString("base64url")}`;
}

/** A grant for `target` whose signed resources are `resources`, signed by the owner. */
async function grantWith(target: string, resources: string[], recapResources: Record<string, unknown>): Promise<CheckedApprovalResult> {
  const siwe = createSiweMessage({
    domain: "openkey.so", address: OWNER_KEY.address, uri: `${target}#${target.slice("did:key:".length)}`, version: "1", chainId: 1,
    nonce: "abcdefgh12345678", issuedAt: new Date(T0), expirationTime: new Date(T0 + HOUR),
    resources: [...resources, recap(recapResources)],
  });
  const signature = await OWNER_KEY.signMessage({ message: siwe });
  return {
    ownerDid: OWNER,
    delegationExpiresAt: new Date(T0 + HOUR).toISOString(),
    delegation: {
      siwe, signature, delegationCid: "bafy-delegation", spaceId: `tinycloud:pkh:eip155:1:${OWNER_KEY.address}:secrets`, address: OWNER_KEY.address,
      chainId: 1, verificationMethod: `${target}#${target.slice("did:key:".length)}`, delegationHeader: { Authorization: "Bearer fake-ucan" },
    },
  } as CheckedApprovalResult;
}

describe("secretPermissions", () => {
  test("asks for the secret, the whole network, and the secret's own key with the name lowercased", () => {
    expect(secretPermissions("OPENAI_API_KEY", OWNER)).toEqual([
      { service: "tinycloud.kv", space: "secrets", path: "vault/secrets/OPENAI_API_KEY", actions: ["tinycloud.kv/get"] },
      { service: "tinycloud.encryption", space: "encryption", path: NETWORK, actions: ["tinycloud.encryption/decrypt"] },
      { service: "tinycloud.encryption", space: "encryption", path: `${NETWORK}/secrets/openai_api_key`, actions: ["tinycloud.encryption/decrypt"] },
    ]);
  });

  test("names the network with the checksummed address even when the owner is given lowercase", () => {
    const keys = secretPermissions("A_B", OWNER).filter(entry => entry.service === "tinycloud.encryption").map(entry => entry.path);
    expect(keys).toHaveLength(2);
    for (const path of keys) expect(path.startsWith(`urn:tinycloud:encryption:did:pkh:eip155:1:${OWNER_KEY.address}:default`)).toBe(true);
  });
});

describe("verifiedGrant with the exact key", () => {
  const jwk = generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" }) as Ed25519PrivateJwk;
  const target = realLinks.signerFromJwk(jwk).did;
  const expected = { ownerDid: OWNER, targetDid: target, jwk, maxSeconds: MAX_GRANT_SECONDS, now: T0 };
  const kv = `tinycloud:pkh:eip155:1:${OWNER_KEY.address}:secrets/kv/vault/secrets/OPENAI_API_KEY`;
  const exact = `${NETWORK}/secrets/openai_api_key`;

  test("accepts a grant that names the owner's exact key beside the network", async () => {
    const checked = await grantWith(target, [exact], {
      [kv]: { "tinycloud.kv/get": [{}] },
      [NETWORK]: { "tinycloud.encryption/decrypt": [{}] },
      [exact]: { "tinycloud.encryption/decrypt": [{}] },
    });
    await expect(verifiedGrant(checked, expected)).resolves.toMatchObject({ address: OWNER_KEY.address });
  });

  test("refuses an exact key on another owner's network", async () => {
    const other = `urn:tinycloud:encryption:did:pkh:eip155:1:${OTHER_KEY.address}:default/secrets/openai_api_key`;
    const checked = await grantWith(target, [other], {
      [kv]: { "tinycloud.kv/get": [{}] },
      [NETWORK]: { "tinycloud.encryption/decrypt": [{}] },
      [other]: { "tinycloud.encryption/decrypt": [{}] },
    });
    await expect(verifiedGrant(checked, expected)).rejects.toThrow("another owner's resource");
  });

  test("refuses an exact key on another owner's network when only the capabilities name it", async () => {
    const other = `urn:tinycloud:encryption:did:pkh:eip155:1:${OTHER_KEY.address}:default/secrets/openai_api_key`;
    const checked = await grantWith(target, [], {
      [kv]: { "tinycloud.kv/get": [{}] },
      [NETWORK]: { "tinycloud.encryption/decrypt": [{}] },
      [other]: { "tinycloud.encryption/decrypt": [{}] },
    });
    await expect(verifiedGrant(checked, expected)).rejects.toThrow("another owner's resource");
  });
});
