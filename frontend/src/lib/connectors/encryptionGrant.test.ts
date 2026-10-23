import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { resolveManifest } from "@tinycloud/sdk-core";
import type { Manifest } from "@tinycloud/web-sdk";

import {
  encryptionNetworkCreateGrant,
  encryptionNetworkId,
  withEncryptionNetworkCreateGrant,
} from "./encryptionGrant";

// Spelled lowercase on purpose: the owner DID is built from the EIP-55 checksummed
// address, so the helper has to normalize rather than pass the wallet's spelling through.
const LOWER = "0x7d0333579c19e8fa149c2dbf8405cb6f66c373f2";
const CHECKSUMMED = "0x7d0333579C19E8fa149C2dbf8405cb6f66c373f2";
const NETWORK_URN = `urn:tinycloud:encryption:did:pkh:eip155:1:${CHECKSUMMED}:default`;

function baseManifest(): Manifest {
  return JSON.parse(
    readFileSync(new URL("../../../../manifest.json", import.meta.url), "utf8"),
  ) as Manifest;
}

describe("encryptionNetworkId", () => {
  test("builds the default network URN, checksumming the address", () => {
    expect(encryptionNetworkId(LOWER)).toBe(NETWORK_URN);
    expect(encryptionNetworkId(CHECKSUMMED)).toBe(encryptionNetworkId(LOWER));
  });

  test("honours a non-mainnet chain id", () => {
    expect(encryptionNetworkId(LOWER, 8453)).toBe(
      `urn:tinycloud:encryption:did:pkh:eip155:8453:${CHECKSUMMED}:default`,
    );
  });

  test("rejects a malformed address rather than minting a URN that can never match", () => {
    expect(() => encryptionNetworkId("not-an-address")).toThrow();
  });
});

describe("encryptionNetworkCreateGrant", () => {
  test("requests network.create on the default network and nothing else", () => {
    expect(encryptionNetworkCreateGrant(LOWER)).toEqual({
      service: "tinycloud.encryption",
      path: NETWORK_URN,
      actions: ["network.create"],
      skipPrefix: true,
      description: "Create your encrypted vault network.",
    });
  });
});

describe("withEncryptionNetworkCreateGrant", () => {
  test("appends the grant without mutating the fetched manifest", () => {
    const manifest = baseManifest();
    const before = (manifest.permissions ?? []).length;
    const composed = withEncryptionNetworkCreateGrant(manifest, LOWER);

    expect(composed).not.toBe(manifest);
    expect((manifest.permissions ?? []).length).toBe(before);
    expect((composed.permissions ?? []).length).toBe(before + 1);
    expect((composed.permissions ?? [])[before]).toEqual(
      encryptionNetworkCreateGrant(LOWER),
    );
  });

  test("keeps every permission the static manifest already declared", () => {
    const manifest = baseManifest();
    const composed = withEncryptionNetworkCreateGrant(manifest, LOWER);
    for (const entry of manifest.permissions ?? []) {
      expect(composed.permissions).toContainEqual(entry);
    }
    expect(composed.secrets).toEqual(manifest.secrets);
  });

  test("is idempotent: a manifest that already has the grant is returned as-is", () => {
    const manifest = withEncryptionNetworkCreateGrant(baseManifest(), LOWER);
    expect(withEncryptionNetworkCreateGrant(manifest, LOWER)).toBe(manifest);
  });

  test("the composed manifest resolves to network.create and no decrypt", () => {
    // The real resolver decides whether the entry becomes a capability, so the
    // assertion runs against it rather than a hand-written object shape.
    const composed = withEncryptionNetworkCreateGrant(baseManifest(), LOWER);
    const encryption = resolveManifest(composed).resources.filter(
      (resource) => resource.service === "tinycloud.encryption",
    );
    expect(encryption).toHaveLength(1);
    expect(encryption[0].path).toBe(NETWORK_URN);
    expect(encryption[0].actions).toEqual(["tinycloud.encryption/network.create"]);
    expect(encryption[0].actions.some((action) => action.endsWith("/decrypt"))).toBe(false);
  });

  test("a different signer gets a different grant, not a shared one", () => {
    const other = "0x83cD9777d4128012F878376aCbd6a092DcdDE01c";
    const mine = withEncryptionNetworkCreateGrant(baseManifest(), LOWER);
    const theirs = withEncryptionNetworkCreateGrant(baseManifest(), other);
    const minePath = (mine.permissions ?? []).find((p) => p.service === "tinycloud.encryption")?.path;
    const theirsPath = (theirs.permissions ?? []).find((p) => p.service === "tinycloud.encryption")?.path;
    expect(minePath).not.toBe(theirsPath);
    expect(theirsPath).toContain(other);
  });
});
