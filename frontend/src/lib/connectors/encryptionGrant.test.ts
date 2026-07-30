import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import type { Manifest } from "@tinycloud/web-sdk";

import {
  encryptionDecryptGrant,
  encryptionNetworkId,
  withEncryptionDecryptGrant,
} from "./encryptionGrant";

// The address the lane signs in as, spelled lowercase on purpose: the SDK reads
// the owner DID out of the space id, whose address is EIP-55 checksummed, so the
// helper has to normalize rather than pass the wallet's spelling through.
const LOWER = "0x7d0333579c19e8fa149c2dbf8405cb6f66c373f2";
const CHECKSUMMED = "0x7d0333579C19E8fa149C2dbf8405cb6f66c373f2";

function baseManifest(): Manifest {
  return JSON.parse(
    readFileSync(new URL("../../../../manifest.json", import.meta.url), "utf8"),
  ) as Manifest;
}

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

describe("withEncryptionDecryptGrant", () => {
  test("appends the grant without mutating the fetched manifest", () => {
    const manifest = baseManifest();
    const before = (manifest.permissions ?? []).length;
    const composed = withEncryptionDecryptGrant(manifest, LOWER);

    expect(composed).not.toBe(manifest);
    expect((manifest.permissions ?? []).length).toBe(before);
    expect((composed.permissions ?? []).length).toBe(before + 1);

    const added = (composed.permissions ?? [])[before];
    expect(added).toEqual(encryptionDecryptGrant(LOWER));
  });

  test("keeps every permission the static manifest already declared", () => {
    const manifest = baseManifest();
    const composed = withEncryptionDecryptGrant(manifest, LOWER);
    for (const entry of manifest.permissions ?? []) {
      expect(composed.permissions).toContainEqual(entry);
    }
    // The secrets shorthand rides along untouched — it grants the vault/ path
    // this entry does NOT replace.
    expect(composed.secrets).toEqual(manifest.secrets);
  });

  test("is idempotent — a manifest that already grants it is returned as-is", () => {
    const manifest = withEncryptionDecryptGrant(baseManifest(), LOWER);
    const again = withEncryptionDecryptGrant(manifest, LOWER);
    expect(again).toBe(manifest);
  });

  test("the composed manifest resolves to the exact resource the SDK demands", async () => {
    // The real resolver is the only authority on whether this entry survives
    // validation and lands as a usable capability — a hand-checked object shape
    // would not catch a rejected path.
    const { resolveManifest } = await import("@tinycloud/sdk-core");
    const composed = withEncryptionDecryptGrant(baseManifest(), LOWER);
    const encryption = resolveManifest(composed).resources.filter(
      (resource) => resource.service === "tinycloud.encryption",
    );
    expect(encryption).toHaveLength(1);
    expect(encryption[0].path).toBe(
      `urn:tinycloud:encryption:did:pkh:eip155:1:${CHECKSUMMED}:default`,
    );
    expect(encryption[0].actions).toEqual(["tinycloud.encryption/decrypt"]);
  });

  test("the static manifest alone resolves to NO encryption grant", async () => {
    // Pins why this helper has to exist at all. If this ever fails, the SDK (or
    // the manifest) started carrying the capability and the workaround in
    // App.tsx should be deleted.
    const { resolveManifest } = await import("@tinycloud/sdk-core");
    const resolved = resolveManifest(baseManifest());
    expect(
      resolved.resources.filter((resource) => resource.service === "tinycloud.encryption"),
    ).toHaveLength(0);
  });

  test("a different signer gets a different grant, not a shared one", () => {
    const other = "0x83cD9777d4128012F878376aCbd6a092DcdDE01c";
    const mine = withEncryptionDecryptGrant(baseManifest(), LOWER);
    const theirs = withEncryptionDecryptGrant(baseManifest(), other);
    const path = (m: Manifest) =>
      (m.permissions ?? []).find((p) => p.service === "tinycloud.encryption")?.path;
    expect(path(mine)).not.toBe(path(theirs));
    expect(path(theirs)).toContain(other);
  });
});

// Which call site uses it is the whole point: capabilities are minted at sign-in,
// so adding this on the restore path would be misleading noise that never
// changes what a restored session can do. Asserted against the source because
// the alternative is rendering App with a mock wallet.
describe("App wiring", () => {
  const app = readFileSync(new URL("../../App.tsx", import.meta.url), "utf8");

  test("sign-in passes the composed manifest to createAndSignIn", () => {
    const signInCall = app.slice(app.indexOf("await createAndSignIn("));
    const args = signInCall.slice(0, signInCall.indexOf("});"));
    expect(args).toContain("manifest: withEncryptionDecryptGrant(manifest, connectedAddress)");
  });

  test("the restore path passes the plain manifest", () => {
    const restoreCall = app.slice(app.indexOf("await restoreTinyCloudWebSession("));
    const args = restoreCall.slice(0, restoreCall.indexOf("});"));
    expect(args).toContain("manifest,");
    expect(args).not.toContain("withEncryptionDecryptGrant");
  });

  test("the workaround has exactly one call site, so removing it is one line", () => {
    expect(app.split("withEncryptionDecryptGrant(").length - 1).toBe(1);
  });
});
