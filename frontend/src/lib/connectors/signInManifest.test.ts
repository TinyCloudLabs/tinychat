import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { composeManifestRequest } from "@tinycloud/sdk-core";
import type { ComposedManifestRequest, Manifest } from "@tinycloud/web-sdk";

import { withEncryptionNetworkCreateGrant } from "./encryptionGrant";
import { CONNECTORS } from "./registry";

const MANIFEST_URL = new URL("../../../../manifest.json", import.meta.url);
const SIGN_IN_ADDRESS = "0x7d0333579c19e8fa149c2dbf8405cb6f66c373f2";
const SECRETS_SPACE = "secrets";
const KV_GET = "tinycloud.kv/get";

// Connector secrets the sign-in must be able to read without a decrypt step-up.
const EXPLICIT_SECRET_PATHS = [
  "vault/secrets/FIREFLIES_API_KEY",
  "vault/secrets/GRANOLA_API_KEY",
  "vault/secrets/ASSEMBLYAI_API_KEY",
  "vault/secrets/scoped/google-meet/REFRESH_TOKEN",
];

function secretPath(name: string, scope: string | undefined): string {
  return scope ? `vault/secrets/scoped/${scope}/${name}` : `vault/secrets/${name}`;
}

// Mirrors App.tsx: the app manifest plus the encryption network.create grant,
// composed by the SDK into the single sign-in request.
function signInRequest(): ComposedManifestRequest {
  const manifest = JSON.parse(readFileSync(MANIFEST_URL, "utf8")) as Manifest;
  return composeManifestRequest([withEncryptionNetworkCreateGrant(manifest, SIGN_IN_ADDRESS)]);
}

function grantsSecretGet(resources: ComposedManifestRequest["resources"], path: string): boolean {
  return resources.some(
    (r) => r.service === "tinycloud.kv" && r.space === SECRETS_SPACE && r.path === path && r.actions.includes(KV_GET),
  );
}

describe("sign-in manifest", () => {
  test("grants kv get on every connector secret path in the secrets space", () => {
    const { resources } = signInRequest();
    for (const path of EXPLICIT_SECRET_PATHS) {
      expect(grantsSecretGet(resources, path)).toBe(true);
    }
  });

  test("grants kv get for every connector registry secret, so a new registry secret needs a manifest entry", () => {
    const { resources } = signInRequest();
    const registryPaths = CONNECTORS.map((c) => secretPath(c.secretName, c.secretScope));
    expect(registryPaths.length).toBeGreaterThan(0);
    for (const path of registryPaths) {
      expect(grantsSecretGet(resources, path)).toBe(true);
    }
  });

  test("carries no decrypt permission anywhere in the request", () => {
    expect(JSON.stringify(signInRequest()).toLowerCase()).not.toContain("decrypt");
  });

  test("the only encryption entry is network.create on the default network", () => {
    const encryption = signInRequest().resources.filter((r) => r.service === "tinycloud.encryption");
    expect(encryption.map((r) => r.actions)).toEqual([["tinycloud.encryption/network.create"]]);
    expect(encryption[0]?.path.endsWith(":default")).toBe(true);
  });
});
