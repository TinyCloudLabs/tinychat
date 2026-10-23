// Sign-in manifest entry for the owner's default encryption network.
//
// Sign-in requests `network.create` on the network, so the network can be created
// on the first secret save (see ensureEncryptionNetwork in connectorSecrets.ts).
// Sign-in does not request `decrypt`; reads request it separately, only from an
// explicit user action (see readConnectorKey and ensureDecryptStepUp in connectorSecrets.ts).
//
// The network id embeds the owner's DID, so the entry cannot be declared in the
// static manifest. It is composed once the address is known and appended to the
// manifest passed to signIn. The URN format mirrors node-sdk's network id
// derivation. The owner DID is built from the address, so the address is
// normalized (EIP-55) here.

import { getAddress } from "viem";
import type { Manifest } from "@tinycloud/web-sdk";

/** The network name node-sdk uses when none is given. */
const DEFAULT_ENCRYPTION_NETWORK_NAME = "default";

/**
 * The default encryption network id for `address` on `chainId`.
 *
 * @throws if `address` is not a valid EVM address (viem's getAddress).
 */
export function encryptionNetworkId(address: string, chainId = 1): string {
  const ownerDid = `did:pkh:eip155:${chainId}:${getAddress(address)}`;
  return `urn:tinycloud:encryption:${ownerDid}:${DEFAULT_ENCRYPTION_NETWORK_NAME}`;
}

/** The sign-in permission entry that lets the owner create their encryption network. */
export function encryptionNetworkCreateGrant(
  address: string,
  chainId = 1,
): { service: string; path: string; actions: string[]; skipPrefix: true; description: string } {
  return {
    service: "tinycloud.encryption",
    path: encryptionNetworkId(address, chainId),
    actions: ["network.create"],
    // Encryption resources are top-level and owner-scoped, so the app-id prefix
    // is not applied. sdk-core forces this for this service.
    skipPrefix: true,
    description: "Create your encrypted vault network.",
  };
}

/**
 * `manifest` plus the network-create entry. Returns a new object; the fetched
 * manifest is left untouched. It is a no-op when an entry for the same service
 * and path is already present.
 *
 * Used at sign-in only.
 */
export function withEncryptionNetworkCreateGrant(
  manifest: Manifest,
  address: string,
  chainId = 1,
): Manifest {
  const grant = encryptionNetworkCreateGrant(address, chainId);
  const existing = manifest.permissions ?? [];
  const alreadyGranted = existing.some(
    (entry) => entry.service === grant.service && entry.path === grant.path,
  );
  if (alreadyGranted) return manifest;
  return {
    ...manifest,
    permissions: [...existing, grant],
  } as Manifest;
}
