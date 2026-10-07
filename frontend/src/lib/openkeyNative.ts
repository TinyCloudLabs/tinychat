// Native OpenKey sign-in for the Exo app (TC-775 E1, OpenKey spec
// docs/native-tinycloud-delegation.md). Inside the Capacitor app, and only when
// the build sets VITE_EXO_NATIVE_OPENKEY=true, sign-in runs PAR + PKCE in the
// system browser (ASWebAuthenticationSession / Custom Tabs) and returns a
// TinyCloud delegation to an Ed25519 session key the OpenKey SDK keeps in the
// device secure store — nothing wallet-shaped ever signs in the WebView, and
// the session JWK never touches localStorage.
//
// The delegation is limited to the manifest's applications-space KV/SQL
// entries plus capabilities/read. It has no secrets or vault access, so every
// secrets-dependent flow is gated behind `secretsAvailable()` below.
//
// TODO(E1 → prod): `@openkey/sdk-capacitor` is vendored from the TC-774 S2
// branch at 087d175 as a file: tarball (frontend/package.json, vendor/). When the SDK
// publishes, replace the file: specs in frontend/package.json and
// mobile/package.json with `"0.1.0"` and delete vendor/.

import { appPlatform, type AppPlatform } from "./platform";
import type { EIP1193Provider, TinyCloudWebConfig } from "@tinyboilerplate/client";
import type { Manifest } from "@tinycloud/sdk-core";
import type {
  NativeDelegationPermission,
  NativeSession,
  OpenKeyNative,
} from "@openkey/sdk-capacitor";

// ── Gate ──────────────────────────────────────────────────────────────

/** Whether this build offers the native OpenKey sign-in path at all. */
export function nativeOpenKeyEnabled(
  env: { VITE_EXO_NATIVE_OPENKEY?: string } = import.meta.env,
): boolean {
  return env.VITE_EXO_NATIVE_OPENKEY === "true";
}

/**
 * Whether sign-in runs through the native OpenKey flow: the Capacitor app AND
 * the build flag. Web and the Tauri desktop app always keep the embedded
 * iframe widget.
 */
export function useNativeOpenKey(
  platform: AppPlatform = appPlatform(),
  env: { VITE_EXO_NATIVE_OPENKEY?: string } = import.meta.env,
): boolean {
  return (platform === "ios" || platform === "android") && nativeOpenKeyEnabled(env);
}

/**
 * Whether secrets/vault flows are available. Native delegation sessions have
 * no secrets capability, so every flow that unlocks or stores credentials is
 * gated on this inside the app.
 */
export function secretsAvailable(): boolean {
  return secretsAvailableOverride ?? !useNativeOpenKey();
}

let secretsAvailableOverride: boolean | null = null;

/** Tests only: pin the gate without mocking Capacitor or the env. */
export function setSecretsAvailableForTests(available: boolean | null): void {
  secretsAvailableOverride = available;
}

/** User-facing message for secrets-dependent features inside the app. */
export const SECRETS_UNAVAILABLE_IN_APP_MESSAGE =
  "This uses stored credentials, which aren't available in the Exo app yet. Set it up from Exo on the web or desktop — everything you connect there works here.";

// ── Capabilities ──────────────────────────────────────────────────────

const CAPABILITIES_READ: NativeDelegationPermission = {
  service: "tinycloud.capabilities",
  space: "applications",
  path: "",
  actions: ["tinycloud.capabilities/read"],
};

const NATIVE_SERVICES = new Set(["tinycloud.kv", "tinycloud.sql"]);

/**
 * The delegation's permission list: every applications-space KV/SQL entry of
 * the app manifest, paths prefixed with the app id and actions expanded to
 * full URNs, plus the mandatory capabilities/read. Nothing else — the OpenKey
 * ceiling refuses secrets, vault and other spaces, so native sessions simply
 * cannot hold them.
 */
export function nativePermissions(manifest: Manifest): NativeDelegationPermission[] {
  const permissions: NativeDelegationPermission[] = [CAPABILITIES_READ];
  const prefix = manifest.prefix === undefined ? manifest.app_id : manifest.prefix;
  for (const entry of manifest.permissions ?? []) {
    const space = entry.space ?? "applications";
    if (space !== "applications" || !NATIVE_SERVICES.has(entry.service)) continue;
    permissions.push({
      service: entry.service,
      space: "applications",
      path: entry.skipPrefix || prefix === "" ? entry.path : `${prefix}/${entry.path}`,
      actions: entry.actions.map((action) =>
        action.includes("/") ? action : `${entry.service}/${action}`,
      ),
    });
  }
  return permissions;
}

// ── Read-only provider ────────────────────────────────────────────────

/**
 * An EIP-1193 stub for a restored delegation session: it answers account and
 * chain queries so `tcw.session()`/`spaceId` are populated, and refuses every
 * signing method — the canonical key never signs inside the app.
 */
export function createNativeReadOnlyProvider(
  address: string,
  chainId: number,
): EIP1193Provider {
  return {
    // EIP-1193 listeners: a delegation session never emits, so these are no-ops.
    on: () => undefined,
    removeListener: () => undefined,
    request: async ({ method }: { method: string }) => {
      if (method === "eth_accounts" || method === "eth_requestAccounts") return [address];
      if (method === "eth_chainId") return `0x${chainId.toString(16)}`;
      throw new Error("Wallet signing is unavailable in a delegated session");
    },
  };
}

// ── Error mapping ─────────────────────────────────────────────────────

export const NATIVE_SIGN_IN_CANCELLED_MESSAGE = "Sign-in was cancelled.";
export const NATIVE_SIGN_IN_DENIED_MESSAGE =
  "OpenKey denied the sign-in. Nothing was signed in.";
export const NATIVE_SIGN_IN_FAILED_MESSAGE =
  "Native sign-in failed. Check your connection and try again.";

/** Map an OpenKey native failure to a user-facing message. */
export function nativeSignInErrorMessage(error: unknown): string {
  const code =
    error && typeof error === "object" && "code" in error
      ? String((error as { code: unknown }).code)
      : undefined;
  if (code === "USER_CANCELLED") return NATIVE_SIGN_IN_CANCELLED_MESSAGE;
  if (code === "ACCESS_DENIED") return NATIVE_SIGN_IN_DENIED_MESSAGE;
  return NATIVE_SIGN_IN_FAILED_MESSAGE;
}

// ── Sign-in ───────────────────────────────────────────────────────────

export interface NativeSignInConfig {
  backendUrl: string;
  /** The configured TinyCloud node the delegation must name (VITE_TINYCLOUD_HOST). */
  tinycloudHost: string;
  tinycloudHosts?: string[];
  env?: {
    VITE_OPENKEY_ISSUER?: string;
    VITE_OPENKEY_NATIVE_CLIENT_ID?: string;
    VITE_OPENKEY_NATIVE_REDIRECT_URI?: string;
  };
}

export interface NativeSignInResult {
  address: string;
  /** Ready TinyCloudWeb instance with the delegation restored. */
  tcw: unknown;
  /** SIWE + signature the backend /api/auth/verify exchanged for a session token. */
  verified: { token: string; expiresIn: number; address: string };
  delegationExpiresAt: string;
}

/** Injectable seams so unit tests drive the flow without a device or network. */
export interface NativeSignInDeps {
  createOpenKeyNative: (options: {
    clientId: string;
    redirectUri: string;
    issuer: string;
    tinycloudHost: string;
  }) => OpenKeyNative;
  requestNonce: (backendUrl: string, address?: string) => Promise<string>;
  loadManifest: (url: string) => Promise<Manifest>;
  activateSession: (
    host: string,
    delegationHeader: { Authorization: string },
  ) => Promise<{ success: boolean; activated?: string[]; error?: string }>;
  restoreSession: (
    address: string,
    config: TinyCloudWebConfig & { provider?: EIP1193Provider },
  ) => Promise<{ tcw: unknown; status: string; error?: Error }>;
  verifySession: (
    backendUrl: string,
    siwe: string,
    signature: string,
  ) => Promise<{ token: string; expiresIn: number; address: string }>;
}

const DEFAULT_REDIRECT_URI = "xyz.tinycloud.exo://openkey/callback";
const DEFAULT_ISSUER = "https://api.openkey.so/api/auth";

async function defaultDeps(): Promise<NativeSignInDeps> {
  const [{ OpenKeyNative }, { activateSessionWithHost }, client] = await Promise.all([
    import("@openkey/sdk-capacitor"),
    import("@tinycloud/sdk-core"),
    import("@tinyboilerplate/client"),
  ]);
  return {
    createOpenKeyNative: (options) => new OpenKeyNative({ ...options, ephemeralSession: true }),
    requestNonce: client.requestNonce,
    loadManifest: client.loadAppManifest,
    activateSession: activateSessionWithHost,
    restoreSession: client.restoreTinyCloudWebSession,
    verifySession: client.verifySession,
  };
}

function delegationExpiryIso(expiresAt: string | number): string {
  if (typeof expiresAt === "number") {
    return new Date(expiresAt * 1000).toISOString();
  }
  return new Date(expiresAt).toISOString();
}

/**
 * The native sign-in flow: OpenKey delegation → TinyCloud session.
 * Throws `Error(nativeSignInErrorMessage(...))` on cancel/deny/failure; the
 * caller leaves the user signed out.
 */
export async function signInNative(
  config: NativeSignInConfig,
  deps?: NativeSignInDeps,
): Promise<NativeSignInResult> {
  const env = config.env ?? import.meta.env;
  const clientId = env.VITE_OPENKEY_NATIVE_CLIENT_ID;
  if (!clientId) {
    throw new Error(
      "Native sign-in is not configured in this build (VITE_OPENKEY_NATIVE_CLIENT_ID is unset).",
    );
  }
  const d = deps ?? (await defaultDeps());
  const openkey = d.createOpenKeyNative({
    clientId,
    redirectUri: env.VITE_OPENKEY_NATIVE_REDIRECT_URI ?? DEFAULT_REDIRECT_URI,
    issuer: env.VITE_OPENKEY_ISSUER ?? DEFAULT_ISSUER,
    tinycloudHost: config.tinycloudHost,
  });

  try {
    // The delegation's signer is unknown until OpenKey signs, so the backend
    // nonce is unbound; /verify binds it to the recovered address.
    const [siweNonce, manifest] = await Promise.all([
      d.requestNonce(config.backendUrl),
      d.loadManifest(`${config.backendUrl}/api/manifest`),
    ]);

    const session = await openkey.signIn({
      capabilities: nativePermissions(manifest),
      siweNonce,
    });
    return await handoffNativeSession(openkey, session, config, d);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Native sign-in is not configured")) {
      throw error;
    }
    throw new Error(nativeSignInErrorMessage(error), { cause: error });
  }
}

/**
 * Persist the OpenKey session into TinyCloud session storage (the native
 * secure-store adapter), activate the delegation on its node, restore
 * TinyCloudWeb over it, then verify the backend session.
 */
async function handoffNativeSession(
  openkey: OpenKeyNative,
  session: NativeSession,
  config: NativeSignInConfig,
  d: NativeSignInDeps,
): Promise<NativeSignInResult> {
  const { delegation, sessionKey } = session;
  const address = delegation.address;
  const chainId = delegation.chainId;
  if (
    !address ||
    chainId === undefined ||
    !delegation.siwe ||
    !delegation.signature ||
    !delegation.delegationHeader ||
    !delegation.delegationCid ||
    !delegation.spaceId ||
    delegation.tinycloudHost !== config.tinycloudHost
  ) {
    throw new Error("OpenKey returned an incomplete delegation for a different TinyCloud node.");
  }

  const storage = openkey.sessionStorageAdapter();
  await storage.save(address, {
    address,
    chainId,
    sessionKey: JSON.stringify(sessionKey.privateJwk),
    siwe: delegation.siwe,
    signature: delegation.signature,
    tinycloudSession: {
      delegationHeader: delegation.delegationHeader,
      delegationCid: delegation.delegationCid,
      spaceId: delegation.spaceId,
      verificationMethod: delegation.verificationMethod,
    },
    expiresAt: delegationExpiryIso(delegation.expiresAt),
    createdAt: new Date().toISOString(),
    version: "1",
    tinycloudHosts: [delegation.tinycloudHost],
  });

  const activation = await d.activateSession(delegation.tinycloudHost, delegation.delegationHeader);
  if (!activation.success || !activation.activated?.includes(delegation.spaceId)) {
    throw new Error(activation.error ?? "TinyCloud space activation failed");
  }

  const restored = await d.restoreSession(address, {
    tinycloudHosts: config.tinycloudHosts ?? [delegation.tinycloudHost],
    autoCreateSpace: false,
    sessionStorage: storage,
    provider: createNativeReadOnlyProvider(address, chainId),
  });
  if (restored.status !== "restored" || !restored.tcw) {
    throw restored.error ?? new Error("TinyCloud session restore failed");
  }

  const verified = await d.verifySession(config.backendUrl, delegation.siwe, delegation.signature);
  return {
    address,
    tcw: restored.tcw,
    verified,
    delegationExpiresAt: delegationExpiryIso(delegation.expiresAt),
  };
}

/** Sign the native OpenKey session out: revoke the delegation grant and drop the secure-store record. */
export async function signOutNative(deps?: {
  createOpenKeyNative?: NativeSignInDeps["createOpenKeyNative"];
  env?: NativeSignInConfig["env"] & { VITE_TINYCLOUD_HOST?: string };
}): Promise<void> {
  const env = deps?.env ?? import.meta.env;
  const clientId = env.VITE_OPENKEY_NATIVE_CLIENT_ID;
  if (!clientId) return;
  const create = deps?.createOpenKeyNative ?? (await defaultDeps()).createOpenKeyNative;
  const openkey = create({
    clientId,
    redirectUri: env.VITE_OPENKEY_NATIVE_REDIRECT_URI ?? DEFAULT_REDIRECT_URI,
    issuer: env.VITE_OPENKEY_ISSUER ?? DEFAULT_ISSUER,
    tinycloudHost: env.VITE_TINYCLOUD_HOST ?? "https://tee.node.tinycloud.xyz",
  });
  await openkey.signOut();
}
