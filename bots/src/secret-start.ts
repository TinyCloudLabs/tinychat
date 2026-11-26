// Opens the secret grants at start-up. Both keys come from the CVM's key service (dstack-key.ts); if either can't be
// had, secret requests are refused (503) and the secret tools aren't offered. There is no fallback to a per-request
// requester key under the stable name, and no unsealed storage; everything else runs as usual.

import { createPrivateKey } from "node:crypto";
import * as approvalLinks from "@tinycloud/share-envelope/links";
import { approvalRequesterSeedFromDstack, DSTACK_SOCKET, sealKeyFromDstack } from "./dstack-key";
import type { ApprovalOrigins, SecretReader } from "./secret-grants";
import { SecretGrants } from "./secret-grants";
import { sealedGrantStore } from "./secret-store";

export interface SecretStart {
  grantsDir: string;
  origins: ApprovalOrigins;
  reader: SecretReader;
  socket?: string;
}

// PKCS#8 prefix of an Ed25519 private key; the 32-byte seed follows.
const PKCS8_ED25519 = Buffer.from("302e020100300506032b657004220420", "hex");

/** The Ed25519 JWK of a 32-byte seed: the form the library signs proofs with. */
export function jwkFromSeed(seed: Uint8Array): approvalLinks.Ed25519PrivateJwk {
  const jwk = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, seed]), format: "der", type: "pkcs8" }).export({ format: "jwk" });
  return { kty: "OKP", crv: "Ed25519", x: jwk.x!, d: jwk.d! };
}

export async function startSecretGrants({ grantsDir, origins, reader, socket = DSTACK_SOCKET }: SecretStart): Promise<SecretGrants | undefined> {
  try {
    const key = await sealKeyFromDstack(socket);
    const seed = await approvalRequesterSeedFromDstack(socket);
    const requester = approvalLinks.signerFromSeed(seed);
    // The one place the stable requester's DID is logged: the DID is public, the seed is never logged or returned.
    console.log(JSON.stringify({ gateway: "approval_requester", did: requester.did }));
    const grants = new SecretGrants({ store: sealedGrantStore(grantsDir, key), reader, origins, requester: () => requester, requesterJwk: jwkFromSeed(seed) });
    // The deploy check looks for this line: the gateway's user reached the key service (bots/README.md, Deploying).
    console.log(JSON.stringify({ gateway: "secrets_ready" }));
    return grants;
  } catch (error) {
    console.error(JSON.stringify({ gateway: "secrets_unavailable", reason: error instanceof Error ? error.message.slice(0, 200) : "unknown" }));
    return undefined;
  }
}
