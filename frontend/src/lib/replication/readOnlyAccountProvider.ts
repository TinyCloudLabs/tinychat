// A read-only EIP-1193 object for restoring a session with the local copy on.
//
// The SDK admits a restored replica only after asking the connected wallet for its account (web-sdk
// replica.ts `matchesWallet`). A restore client built without a `provider` has no signer, so that
// question has no answer and every prefix is refused as REPLICA_GATED / `gate_unavailable` before the
// SDK looks at the saved copy. On a reload the app has no live wallet and asking OpenKey would mean a
// passkey prompt, so the account query is answered from the restored session's stored address.
//
// It answers exactly two queries and can do nothing else: `eth_chainId` and `eth_accounts`. It never
// signs and never prompts: `eth_requestAccounts` and every other method throw EIP-1193 error 4200.
// The saved copy stays bound to the session's account by the SDK's own principal stamp (see
// replicaRestoreStamp.test.ts), which is checked after this question.
//
// Used only when the replication option was built (replicationRestore.ts), so a restore with the local
// copy off is exactly what it was without it: no provider, no signer.
import type { EIP1193Provider } from "@tinyboilerplate/client";

/** EIP-1193 error code for an unsupported method. */
export const UNSUPPORTED_METHOD_CODE = 4200;

export class UnsupportedMethodError extends Error {
  readonly code = UNSUPPORTED_METHOD_CODE;

  constructor(method: string) {
    super(`Unsupported wallet method: ${method}`);
    this.name = "UnsupportedMethodError";
  }
}

/** The app signs in on chain 1 (the `did:pkh:eip155:1` DID); keep this in step. */
const CHAIN_ID_HEX = "0x1";

export function readOnlyAccountProvider(storedAddress: string): EIP1193Provider {
  return {
    request: async ({ method }) => {
      if (method === "eth_chainId") return CHAIN_ID_HEX;
      if (method === "eth_accounts") return [storedAddress];
      throw new UnsupportedMethodError(method);
    },
    on: () => undefined,
    removeListener: () => undefined,
  };
}
