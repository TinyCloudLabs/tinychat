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
