// Opens the secret grants at start-up. Both keys come from the CVM's key service (dstack-key.ts); if either can't be
// had, secret requests are refused (503) and the secret tools aren't offered. There is no fallback to a per-request
// requester key under the stable name, and no unsealed storage; everything else runs as usual.

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

export async function startSecretGrants({ grantsDir, origins, reader, socket = DSTACK_SOCKET }: SecretStart): Promise<SecretGrants | undefined> {
  try {
    const key = await sealKeyFromDstack(socket);
    const requester = approvalLinks.signerFromSeed(await approvalRequesterSeedFromDstack(socket));
    // The one place the stable requester's DID is logged: the DID is public, the seed is never logged or returned.
    console.log(JSON.stringify({ gateway: "approval_requester", did: requester.did }));
    const grants = new SecretGrants({ store: sealedGrantStore(grantsDir, key), reader, origins, requester: () => requester });
    // The deploy check looks for this line: the gateway's user reached the key service (bots/README.md, Deploying).
    console.log(JSON.stringify({ gateway: "secrets_ready" }));
    return grants;
  } catch (error) {
    console.error(JSON.stringify({ gateway: "secrets_unavailable", reason: error instanceof Error ? error.message.slice(0, 200) : "unknown" }));
    return undefined;
  }
}
