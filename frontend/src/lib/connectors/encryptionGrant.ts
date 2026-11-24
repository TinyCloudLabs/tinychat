// WORKAROUND for an SDK gap — see docs/connectors-spec.md §7 "KNOWN BLOCKER".
//
// Reading a secret back is impossible on web-sdk 2.5.1 without this. The secrets
// vault is always network-encrypted (node-sdk's createVaultService passes an
// `encryption` config unconditionally, and `usesNetworkEncryption` is just
// `encryption !== undefined`), and NodeSecretsService.ensurePermission adds, for
// `get` ALONE, a `tinycloud.encryption` / `decrypt` entry on the vault's network
// id. Nothing grants it: no manifest `defaults` tier includes encryption, and the
// SDK's only other route is runtime escalation, which needs a wallet signer a
// restored session does not have.
//
// The manifest cannot declare it statically either, because the network id embeds
// the signed-in user's DID and `expandEncryptionPermissionEntry` rejects any path
// that is not a concrete networkId URN (no wildcards). So the entry has to be
// composed once the address is known and appended to the manifest we hand to
// signIn — capabilities are minted from that manifest, so this is the only moment
// it can be added.
//
// This hardcodes an SDK-INTERNAL URN format. It is a one-line removal (drop the
// withEncryptionDecryptGrant call in App.tsx) the moment the SDK carries the
// capability itself. The format is mirrored from node-sdk:
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
// out of the SPACE ID, whose address is EIP-55 checksummed — so the address is
// normalized here rather than used as the wallet happened to spell it.

import { getAddress } from "viem";
import type { Manifest } from "@tinycloud/web-sdk";

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

/** The permission entry NodeSecretsService demands for a secrets read. */
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
 * `manifest` plus the decrypt grant. Returns a new object — the fetched manifest
 * is left untouched — and is a no-op when an equivalent grant is already present,
 * so it stays safe if the backend ever starts declaring one.
 *
 * Sign-in only. A restored session cannot acquire capabilities, so adding this on
 * the restore path would be misleading noise.
 */
export function withEncryptionDecryptGrant(
  manifest: Manifest,
  address: string,
  chainId = 1,
): Manifest {
  const grant = encryptionDecryptGrant(address, chainId);
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

/**
 * The secrets this app keeps for Connectors, as the named keys they are sealed to (TC-3284): `secrets/<name lowercased>`,
 * or `secrets/scoped/<scope>/<name lowercased>`. A secret saved with its own key is opened only by a grant for that exact
 * key, and saving one creates the key; the whole-network grant above still opens the older ones. Kept in step with the
 * connector rows by a test.
 */
export const CONNECTOR_SECRET_KEYS: readonly { keyPath: string; description: string }[] = [
  { keyPath: "secrets/fireflies_api_key", description: "Keep your Fireflies API key encrypted." },
  { keyPath: "secrets/granola_api_key", description: "Keep your Granola API key encrypted." },
  { keyPath: "secrets/scoped/google-meet/refresh_token", description: "Keep your Google sign-in for Google Meet encrypted." },
];

/** What the approval for a new account's first connector key says (TC-4243). */
export const CONNECTOR_NETWORK_SETUP_DESCRIPTION = "Set up encryption for your connector keys. It can't read anything.";

/** An approval for a new account's first connector key lasts no longer than this. */
export const CONNECTOR_NETWORK_SETUP_MAX_MS = 3_600_000;

/**
 * The one permission asked for on demand when a new account saves its first connector key: `network.create` on the owner's
 * encryption network and nothing else (no decrypt, no key). Never part of a sign-in.
 */
export function connectorNetworkSetupPermission(
  address: string,
  chainId = 1,
): { service: string; path: string; actions: string[]; skipPrefix: true; description: string } {
  return {
    service: "tinycloud.encryption",
    path: encryptionNetworkId(address, chainId),
    skipPrefix: true,
    actions: ["network.create"],
    description: CONNECTOR_NETWORK_SETUP_DESCRIPTION,
  };
}

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
 * `manifest` plus the whole-network decrypt grant (older secrets) and the exact-key grants (secrets saved with their own
 * key). Sign-in only, like {@link withEncryptionDecryptGrant}; entries already present are left as they are.
 */
export function withConnectorDecryptGrants(manifest: Manifest, address: string, chainId = 1): Manifest {
  const base = withEncryptionDecryptGrant(manifest, address, chainId);
  const existing = base.permissions ?? [];
  const added = connectorKeyDecryptGrants(address, chainId).filter(
    (grant) => !existing.some((entry) => entry.service === grant.service && entry.path === grant.path),
  );
  return added.length === 0 ? base : ({ ...base, permissions: [...existing, ...added] } as Manifest);
}
