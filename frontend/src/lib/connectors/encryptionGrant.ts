// Connector secrets are read back through `tinycloud.encryption` grants. The secrets vault is always network-encrypted,
// and a secret saved with its own key is opened by a grant for that exact key alone (TC-3284), so the sign-in names the
// exact keys and never asks for decrypt on the whole encryption network. Secrets still sealed to the whole network are
// opened through the separate one-hour approval, {@link legacyNetworkDecryptRequest}.
//
// The manifest cannot declare these entries statically, because the network id embeds the signed-in user's DID and
// `expandEncryptionPermissionEntry` rejects any path that is not a concrete networkId URN (no wildcards). So the entries
// are composed once the address is known and appended to the manifest handed to signIn: capabilities are minted from
// that manifest, so this is the only moment they can be added.
//
// This hardcodes an SDK-INTERNAL URN format. It is mirrored from node-sdk:
//
//   getEncryptionNetworkIdForSpace(spaceId, name = DEFAULT_ENCRYPTION_NETWORK_NAME) {
//     const ownerDid = this.ownerDidFromSpaceId(spaceId) ?? this.did;
//     return `urn:tinycloud:encryption:${ownerDid}:${name}`;
//   }
//   ownerDidFromSpaceId(spaceId) {           // "tinycloud:pkh:eip155:1:0xAbC…:secrets"
//     const body = spaceId.slice("tinycloud:".length);
//     const owner = body.slice(0, body.lastIndexOf(":"));   // "pkh:eip155:1:0xAbC…"
//     return owner.startsWith("did:") ? owner : `did:${owner}`;
//   }
//
// with `DEFAULT_ENCRYPTION_NETWORK_NAME = "default"`. Note the owner DID is read
// out of the SPACE ID, whose address is EIP-55 checksummed, so the address is
// normalized here rather than used as the wallet happened to spell it.

import { getAddress } from "viem";
import type { Manifest } from "@tinycloud/web-sdk";
import { LEGACY_KEYS_APPROVAL_DESCRIPTION } from "../homeStrings";

/** A permission entry this app asks the SDK for on the owner's encryption network. */
export interface ConnectorGrantEntry {
  service: string;
  path: string;
  actions: string[];
  skipPrefix: true;
  description: string;
}

/** The network name node-sdk uses when none is given. */
const DEFAULT_ENCRYPTION_NETWORK_NAME = "default";

/**
 * The network id the secrets vault will decrypt against, for `address` on
 * `chainId`. Mirrors node-sdk's getEncryptionNetworkIdForSpace.
 *
 * @throws if `address` is not a valid EVM address (viem's getAddress).
 */
export function encryptionNetworkId(address: string, chainId = 1): string {
  const ownerDid = `did:pkh:eip155:${chainId}:${getAddress(address)}`;
  return `urn:tinycloud:encryption:${ownerDid}:${DEFAULT_ENCRYPTION_NETWORK_NAME}`;
}

/**
 * Decrypt on the owner's whole network. Only the separate older-keys approval asks for it
 * ({@link legacyNetworkDecryptRequest}); no sign-in grant or coverage set contains it.
 */
export function encryptionDecryptGrant(
  address: string,
  chainId = 1,
): { service: string; path: string; actions: string[]; skipPrefix: true; description: string } {
  return {
    service: "tinycloud.encryption",
    path: encryptionNetworkId(address, chainId),
    actions: ["decrypt"],
    // Encryption resources are top-level and owner-scoped; the app-id prefix
    // would corrupt the URN. (sdk-core forces this anyway for this service.)
    skipPrefix: true,
    description: "Decrypt secrets stored in your encrypted vault.",
  };
}

/**
 * The secrets this app keeps for Connectors, as the named keys they are sealed to (TC-3284): `secrets/<name lowercased>`,
 * or `secrets/scoped/<scope>/<name lowercased>`. A secret saved with its own key is opened only by a grant for that exact
 * key, and saving one creates the key. Kept in step with the
 * connector rows by a test.
 */
export const CONNECTOR_SECRET_KEYS: readonly { keyPath: string; description: string }[] = [
  { keyPath: "secrets/fireflies_api_key", description: "Keep your Fireflies API key encrypted." },
  { keyPath: "secrets/granola_api_key", description: "Keep your Granola API key encrypted." },
  { keyPath: "secrets/scoped/google-meet/refresh_token", description: "Keep your Google sign-in for Google Meet encrypted." },
];

/**
 * One entry per connector secret key, on the owner's network: `<network>/<key path>` with decrypt (read it) and
 * key.create (a save makes the key). These are the only actions the SDK accepts on a secret's key.
 */
export function connectorKeyDecryptGrants(
  address: string,
  chainId = 1,
): { service: string; path: string; actions: string[]; skipPrefix: true; description: string }[] {
  const network = encryptionNetworkId(address, chainId);
  return CONNECTOR_SECRET_KEYS.map(({ keyPath, description }) => ({
    service: "tinycloud.encryption",
    path: `${network}/${keyPath}`,
    actions: ["decrypt", "key.create"],
    skipPrefix: true,
    description,
  }));
}

/**
 * `manifest` plus the exact-key grants only: nothing here reaches the whole network, so a grant built from it can carry
 * the renewal lease. Older secrets still sealed to the whole network are opened through
 * {@link legacyNetworkDecryptRequest}, in a separate short approval.
 */
export function withConnectorKeyGrants(manifest: Manifest, address: string, chainId = 1): Manifest {
  const existing = manifest.permissions ?? [];
  const added = connectorKeyDecryptGrants(address, chainId).filter(
    (grant) => !existing.some((entry) => entry.service === grant.service && entry.path === grant.path),
  );
  return added.length === 0 ? manifest : ({ ...manifest, permissions: [...existing, ...added] } as Manifest);
}

/** The longest the separate approval for older, whole-network secrets lasts: one hour. It is never renewed. */
export const LEGACY_NETWORK_APPROVAL_MAX_MS = 60 * 60 * 1000;

/** The one permission the separate approval asks for: decrypt on the owner's whole network. */
export function legacyNetworkDecryptRequest(address: string, chainId = 1): ConnectorGrantEntry[] {
  return [{ ...encryptionDecryptGrant(address, chainId), description: LEGACY_KEYS_APPROVAL_DESCRIPTION }];
}
