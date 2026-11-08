// The Home site asks for a feature's set by signing in again in the page, on a SEPARATE TinyCloudWeb: the base grant
// plus every set the session has or this device used, plus the one asked for, in one OpenKey approval. The live session
// is not touched until the new one is approved, covers everything asked, and is verified, because the SDK's sign-in
// clears its own instance (services, vault, runtime grants) before it asks for the signature, and clears a persisted
// session it would not reuse.
import {
  BrowserSessionStorage,
  composeManifestRequest,
  type ISessionStorage,
  type Manifest,
  type PermissionEntry,
  type PersistedSessionData,
  type TinyCloudWeb,
} from "@tinycloud/web-sdk";
import type { ConnectWalletResult, EIP1193Provider, TinyCloudWebConfig } from "@tinyboilerplate/client";
import { isSignInCancelled } from "./authErrors";
import { homeSignInManifest, type HomeFeature } from "./homeFeatures";
import { setHomeReauthorizing } from "./homeReauthorizing";
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
  | { outcome: "declined" | "failed" | "wrong-account" | "busy" | "signed-out" };

/**
 * Session storage that hides the saved session and holds the new one until `commit`. Without it, the new instance's
 * sign-in would find the saved session, judge it short of the new grant and clear it before the owner answers.
 * `commit` is all or nothing: if a save fails, what was saved before is put back and it throws, so the persisted
 * session always matches the one the app keeps.
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
      const sessions = [...(staged ?? new Map<string, PersistedSessionData>())];
      const before = await Promise.all(sessions.map(([address]) => saved.load(address)));
      try {
        for (const [address, session] of sessions) await saved.save(address, session);
      } catch (caught) {
        for (const [index, [address]] of sessions.entries()) {
          const previous = before[index];
          await (previous ? saved.save(address, previous) : saved.clear(address)).catch(() => undefined);
        }
        throw caught;
      }
      staged = null;
    },
  };
}

/**
 * Sign `address` in again with the base grant and `features`' sets. Only "granted" has changed anything: the new
 * session is kept only when it covers everything asked for, the backend accepts it, and `canCommit` still allows it
 * (the owner is still signed in, and nothing has started that a swap would cut off).
 */
export async function reauthorizeHome(
  deps: HomeReauthorizeDeps,
  input: {
    address: string;
    features: readonly HomeFeature[];
    config: Omit<TinyCloudWebConfig, "manifest" | "sessionStorage" | "siweConfig" | "nonce">;
    canCommit(): "signed-out" | "busy" | null;
  },
): Promise<HomeReauthorizeResult> {
  const { prefetch } = deps;
  let next: TinyCloudWeb | null = null;
  setHomeReauthorizing(true);
  try {
    const { address, openkey, web3Provider } = await deps.connect();
    // Another account in OpenKey would sign in as someone else: refuse before anything is signed.
    if (address.toLowerCase() !== input.address.toLowerCase()) return { outcome: "wrong-account" };
    const manifest = homeSignInManifest(await prefetch.manifest(), input.features, address);
    const nonce = await prefetch.nonceForSigning(address);
    const staged = stagedSessionStorage(deps.sessionStorage ?? new BrowserSessionStorage());
    const created = deps.createTcw(prefetch.guardSigning(web3Provider), {
      ...input.config,
      manifest,
      sessionStorage: staged.storage,
      siweConfig: { nonce },
    });
    next = created;
    const session = await created.signIn({ nonce });
    // An approval of less than was asked (the base, or some of the sets) is not kept.
    const asked = composeManifestRequest([manifest], { includeAccountRegistryPermissions: false }).resources as PermissionEntry[];
    if (!created.hasPermissions(asked)) {
      created.cleanup();
      return { outcome: "failed" };
    }
    const verified = await deps.verify(session.siwe, session.signature);
    const blocked = input.canCommit();
    if (blocked) {
      created.cleanup();
      return { outcome: blocked };
    }
    await staged.commit();
    prefetch.complete();
    return { outcome: "granted", tcw: created, manifest, verified, openkey };
  } catch (caught) {
    next?.cleanup();
    return { outcome: isSignInCancelled(caught) ? "declined" : "failed" };
  } finally {
    prefetch.cancel();
    setHomeReauthorizing(false);
  }
}
