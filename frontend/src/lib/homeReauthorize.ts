// The Home site asks for a feature's set by signing in again in the page, on a SEPARATE TinyCloudWeb: the base grant
// plus every flagged set plus the one asked for, in one OpenKey approval. The live session is not touched until the
// new one is approved and verified, because the SDK's sign-in clears its own instance (services, vault, runtime grants)
// before it asks for the signature, and clears a persisted session it would not reuse.
import {
  BrowserSessionStorage,
  type ISessionStorage,
  type Manifest,
  type PersistedSessionData,
  type TinyCloudWeb,
} from "@tinycloud/web-sdk";
import type { ConnectWalletResult, EIP1193Provider, TinyCloudWebConfig } from "@tinyboilerplate/client";
import { isSignInCancelled } from "./authErrors";
import { homeSignInManifest, type HomeFeature } from "./homeFeatures";
import type { WebSignInPrefetch } from "./webSignInPrefetch";

export interface HomeReauthorizeDeps {
  connect(): Promise<Pick<ConnectWalletResult, "address" | "openkey"> & { web3Provider: EIP1193Provider }>;
  prefetch: WebSignInPrefetch;
  createTcw(provider: EIP1193Provider, config: TinyCloudWebConfig): TinyCloudWeb;
  verify(siwe: string, signature: string): Promise<{ token: string; expiresIn: number }>;
  /** Where the live session is saved; the new one is written there only once verified. */
  sessionStorage?: ISessionStorage;
}

export type HomeReauthorizeResult =
  | {
    outcome: "granted";
    tcw: TinyCloudWeb;
    manifest: Manifest;
    verified: { token: string; expiresIn: number };
    openkey: ConnectWalletResult["openkey"];
  }
  | { outcome: "declined" | "failed" };

/**
 * Session storage that hides the saved session and holds the new one until `commit`. Without it, the new instance's
 * sign-in would find the saved session, judge it short of the new grant and clear it before the owner answers.
 */
function stagedSessionStorage(saved: ISessionStorage): { storage: ISessionStorage; commit(): Promise<void> } {
  let staged: Map<string, PersistedSessionData> | null = new Map();
  return {
    storage: {
      save: async (address, session) => { if (staged) staged.set(address, session); else await saved.save(address, session); },
      load: async (address) => (staged ? staged.get(address) ?? null : saved.load(address)),
      clear: async (address) => { if (staged) staged.delete(address); else await saved.clear(address); },
      exists: (address) => (staged ? staged.has(address) : saved.exists(address)),
      isAvailable: () => saved.isAvailable(),
    },
    async commit() {
      const sessions = staged ?? new Map();
      staged = null;
      for (const [address, session] of sessions) await saved.save(address, session);
    },
  };
}

/** Sign `address` in again with the base grant and `features`' sets. Only "granted" has changed anything. */
export async function reauthorizeHome(
  deps: HomeReauthorizeDeps,
  input: { address: string; features: readonly HomeFeature[]; config: Omit<TinyCloudWebConfig, "manifest" | "sessionStorage" | "siweConfig" | "nonce"> },
): Promise<HomeReauthorizeResult> {
  const { prefetch } = deps;
  let next: TinyCloudWeb | null = null;
  try {
    const { address, openkey, web3Provider } = await deps.connect();
    // Another account in OpenKey would sign in as someone else: refuse before anything is signed.
    if (address.toLowerCase() !== input.address.toLowerCase()) return { outcome: "failed" };
    const manifest = homeSignInManifest(await prefetch.manifest(), input.features, address);
    const nonce = await prefetch.nonceForSigning(address);
    const staged = stagedSessionStorage(deps.sessionStorage ?? new BrowserSessionStorage());
    next = deps.createTcw(prefetch.guardSigning(web3Provider), {
      ...input.config,
      manifest,
      sessionStorage: staged.storage,
      siweConfig: { nonce },
    });
    const session = await next.signIn({ nonce });
    const verified = await deps.verify(session.siwe, session.signature);
    await staged.commit();
    prefetch.complete();
    return { outcome: "granted", tcw: next, manifest, verified, openkey };
  } catch (caught) {
    next?.cleanup();
    return { outcome: isSignInCancelled(caught) ? "declined" : "failed" };
  } finally {
    prefetch.cancel();
  }
}
