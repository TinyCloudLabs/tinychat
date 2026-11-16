import type { EIP1193Provider, requestNonce } from "@tinyboilerplate/client";
import { validateManifest, type Manifest } from "@tinycloud/sdk-core";
import appManifest from "../../../manifest.json";

// Web and backend deploy independently. Sign the grants shipped with this client.
export const WEB_APP_MANIFEST: Manifest = validateManifest(appManifest);

// Server nonces expire at five minutes; leave one minute for SDK setup and verification.
const MAX_NONCE_AGE_MS = 4 * 60_000;

type Services = {
  requestNonce: typeof requestNonce;
  now?: () => number;
};

export interface WebSignInPrefetch {
  cancel(): void;
  complete(): void;
  manifest(): Promise<Manifest>;
  nonceForSigning(address: string): Promise<string>;
  guardSigning(provider: EIP1193Provider): EIP1193Provider;
}
/** Each call owns one nonce/signing attempt; the manifest belongs to the deployed client build. */
export function createWebSignInPrefetch(backendUrl: string, services: Services): WebSignInPrefetch {
  const now = services.now ?? Date.now;
  const requestedAt = now();
  // Catch immediately: wallet cancellation must never leave background failures unhandled.
  const prefetchedNonce = services.requestNonce(backendUrl).then(
    (nonce) => ({ nonce, requestedAt }),
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
      return WEB_APP_MANIFEST;
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

/**
 * The same nonce rule as `guardSigning`, for the OpenKey versioned sign-in: no `personal_sign` runs there, so the check
 * wraps the client's `authorizeTinyCloud`. It refuses before OpenKey opens (cancelled, or a nonce already too old) and
 * again when the approval comes back (the owner took too long on OpenKey's screen), so a stale nonce is reported as
 * such rather than as a rejection from the backend. Every other member of the client is passed through untouched.
 */
export function guardOpenKey<T extends object>(prefetch: Pick<WebSignInPrefetch, "guardSigning">, client: T): T {
  const gate = prefetch.guardSigning({ on() {}, removeListener() {}, request: async () => null });
  const check = () => gate.request({ method: "personal_sign", params: [] });
  return new Proxy(client, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (property === "authorizeTinyCloud" && typeof value === "function") {
        return async (...args: unknown[]) => {
          await check();
          const result = await (value as (...inner: unknown[]) => Promise<unknown>).apply(target, args);
          await check();
          return result;
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
