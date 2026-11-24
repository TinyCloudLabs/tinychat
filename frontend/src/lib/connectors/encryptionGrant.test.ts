import { describe, expect, test } from "bun:test";

import {
  encryptionDecryptGrant,
  encryptionNetworkId,
} from "./encryptionGrant";

// The address the lane signs in as, spelled lowercase on purpose: the SDK reads
// the owner DID out of the space id, whose address is EIP-55 checksummed, so the
// helper has to normalize rather than pass the wallet's spelling through.
const LOWER = "0x4db6e7be716ba504cd103bc16b9329fe6bbe41f2";
const CHECKSUMMED = "0x4db6e7Be716bA504Cd103BC16B9329FE6BBE41F2";

describe("encryptionNetworkId", () => {
  test("mirrors node-sdk's getEncryptionNetworkIdForSpace, checksumming the address", () => {
    // Exactly the URN the probe read out of a live session's space id
    // (tinycloud:pkh:eip155:1:0x7d03…:secrets → did:pkh:eip155:1:0x7d03…).
    expect(encryptionNetworkId(LOWER)).toBe(
      `urn:tinycloud:encryption:did:pkh:eip155:1:${CHECKSUMMED}:default`,
    );
    // Case in, same case out — the wallet's spelling must not leak through.
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

describe("encryptionDecryptGrant", () => {
  test("is the entry shape NodeSecretsService asks for on get", () => {
    expect(encryptionDecryptGrant(LOWER)).toEqual({
      service: "tinycloud.encryption",
      path: `urn:tinycloud:encryption:did:pkh:eip155:1:${CHECKSUMMED}:default`,
      actions: ["decrypt"],
      skipPrefix: true,
      description: "Decrypt secrets stored in your encrypted vault.",
    });
  });
});
