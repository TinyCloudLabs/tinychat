import { describe, expect, mock, test } from "bun:test";
import type { ConnectWalletResult } from "@tinyboilerplate/client";
import { connectorKeyDecryptGrants, encryptionDecryptGrant, withConnectorKeyGrants } from "./connectors/encryptionGrant";
import { desktopSignInWithRenewal, webSignInRenewal } from "./renewalReceipt";
import { WEB_APP_MANIFEST } from "./webSignInPrefetch";

// The desktop app signs in through desktopSignInWithRenewal with the manifest App.tsx builds: the connector grants of the
// exact keys. Whether OpenKey is asked for the 90-day lease follows the resources in that grant.

const ADDRESS = "0x0000000000000000000000000000000000000001";
const REQUEST = { protocolVersion: 1 as const, siwe: "prepared desktop SIWE", expiryChangeable: true };
const APPROVED = { protocolVersion: 1 as const, address: ADDRESS, signedMessage: "approved", signature: "signature", selectedActionKeys: [], permissions: [] };
const LEASE_ASK = { version: 1, leaseLifetimeSeconds: 90 * 24 * 60 * 60, purpose: "standing" };

async function requestSentFor(manifest: ReturnType<typeof withConnectorKeyGrants>) {
  const authorize = mock(async (_request: unknown, _options: unknown) => APPROVED);
  const { config } = webSignInRenewal({ authorizeTinyCloud: authorize } as unknown as ConnectWalletResult["openkey"], manifest);
  await desktopSignInWithRenewal(config, async (signInConfig) => signInConfig!.openkey.client.authorizeTinyCloud(REQUEST, { mode: signInConfig!.openkey.mode }));
  return authorize.mock.calls[0][0];
}

describe("desktop sign-in renewal by grant", () => {
  test("asks for the 90-day lease when the grant names only the exact connector keys", async () => {
    expect(await requestSentFor(withConnectorKeyGrants(WEB_APP_MANIFEST, ADDRESS))).toEqual({ ...REQUEST, renewal: LEASE_ASK });
  });

  test("asks for no lease when the grant includes decrypt on the whole encryption network", async () => {
    expect(await requestSentFor({ ...WEB_APP_MANIFEST, permissions: [...(WEB_APP_MANIFEST.permissions ?? []), encryptionDecryptGrant(ADDRESS), ...connectorKeyDecryptGrants(ADDRESS)] } as ReturnType<typeof withConnectorKeyGrants>)).toEqual(REQUEST);
  });
});
