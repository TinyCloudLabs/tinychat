import type { EIP1193Provider, requestNonce } from "@tinyboilerplate/client";
import type { Manifest } from "@tinycloud/sdk-core";

// Server nonces expire at five minutes; leave one minute for SDK setup and verification.
const MAX_NONCE_AGE_MS = 4 * 60_000;

type Services = {
  requestNonce: typeof requestNonce;
  loadManifest: () => Promise<Manifest>;
  now?: () => number;
};

export interface WebSignInPrefetch {
  cancel(): void;
  complete(): void;
  manifest(): Promise<Manifest>;
  nonceForSigning(address: string): Promise<string>;
  guardSigning(provider: EIP1193Provider): EIP1193Provider;
}
/** Each call belongs to exactly one web sign-in attempt; nothing is cached across attempts. */
export function createWebSignInPrefetch(backendUrl: string, services: Services): WebSignInPrefetch {
  const now = services.now ?? Date.now;
  const requestedAt = now();
  // Catch immediately: wallet cancellation must never leave background failures unhandled.
  const prefetchedNonce = services.requestNonce(backendUrl).then(
    (nonce) => ({ nonce, requestedAt }),
    (error: unknown) => ({ error }),
  );
  const prefetchedManifest = services.loadManifest().then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  let cancelled = false;
  let completed = false;
  let consumed = false;
  let signingNonceAt: number | undefined;

  function assertActive() {
    if (cancelled) throw new Error("Sign-in attempt cancelled");
  }

  return {
    cancel() { cancelled = true; },
    complete() { assertActive(); completed = true; },
    async manifest() {
      assertActive();
      const result = await prefetchedManifest;
      assertActive();
      if ("error" in result) throw result.error;
      return result.value;
    },
    async nonceForSigning(address: string) {
      assertActive();
      if (consumed) throw new Error("Sign-in nonce already used by this attempt");
      consumed = true;
      const result = await prefetchedNonce;
      assertActive();
      if ("error" in result) throw result.error;
      if (now() - result.requestedAt >= MAX_NONCE_AGE_MS) {
        // A stale/unbound nonce is discarded; the replacement is bound to this signer.
        const freshAt = now();
        const nonce = await services.requestNonce(backendUrl, address);
        assertActive();
        if (now() - freshAt >= MAX_NONCE_AGE_MS) throw new Error("Sign-in nonce expired; try again");
        signingNonceAt = freshAt;
        return nonce;
      }
      signingNonceAt = result.requestedAt;
      return result.nonce;
    },
    guardSigning(provider: EIP1193Provider): EIP1193Provider {
      return {
        on: (event, listener) => provider.on(event, listener),
        removeListener: (event, listener) => provider.removeListener(event, listener),
        request: (args) => {
          if (args.method === "personal_sign" && !completed) {
            if (cancelled) return Promise.reject(new Error("Sign-in attempt cancelled"));
            if (signingNonceAt === undefined || now() - signingNonceAt >= MAX_NONCE_AGE_MS) {
              return Promise.reject(new Error("Sign-in nonce expired; try again"));
            }
          }
          return provider.request(args);
        },
      };
    },
  };
}
