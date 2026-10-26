// Native OpenKey sign-in for the Exo app (TC-775, OpenKey spec
// docs/native-tinycloud-delegation.md). Inside the Capacitor app — iOS and
// Android only — sign-in runs PAR + PKCE in the system browser
// (ASWebAuthenticationSession / Custom Tabs) and returns a TinyCloud
// delegation to an Ed25519 session key the OpenKey SDK keeps in the device
// secure store — nothing wallet-shaped ever signs in the WebView, and the
// session JWK never touches localStorage.
//
// The delegation is limited to the manifest's applications-space KV/SQL
// entries plus capabilities/read. It has no secrets or vault access, so every
// secrets-dependent flow is gated behind `secretsAvailable()` below.
//
// `@openkey/sdk-capacitor` is pinned to an exact published beta in
// frontend/package.json and mobile/package.json.

import { appPlatform, type AppPlatform } from "./platform";
import type { EIP1193Provider, TinyCloudWebConfig } from "@tinyboilerplate/client";
import type { Manifest, SpaceHostResult } from "@tinycloud/sdk-core";
import type {
  NativeDelegationPermission,
  NativeSession,
  OpenKeyNative,
} from "@openkey/sdk-capacitor";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { authErrorMessage, UserFacingError } from "./authErrors";
import { nativeRenewAt, renewalLeadMs, terminalRenewalError, nativeCode } from "./openkeyNativeRenewal";
import { withAbortTimeout } from "./abortTimeout";

// ── Gate ──────────────────────────────────────────────────────────────

/**
 * Whether sign-in runs through the native OpenKey flow: the Capacitor app on
 * iOS or Android. Web and the Tauri desktop app keep the embedded iframe
 * widget until a Tauri native adapter ships.
 */
export function isNativeOpenKeySignIn(platform: AppPlatform = appPlatform()): boolean {
  return platform === "ios" || platform === "android";
}

/**
 * Whether secrets/vault flows are available. Native delegation sessions have
 * no secrets capability, so every flow that unlocks or stores credentials is
 * gated on this inside the app.
 */
const NATIVE_SESSION_KIND_KEY = "xyz.tinycloud.tinychat:auth-kind";
let nativeSessionActive = false;

/** A native JWT is marked separately from a legacy widget session. No key material is stored here. */
export function nativeSessionWasActive(): boolean {
  try {
    return localStorage.getItem(NATIVE_SESSION_KIND_KEY) === "native";
  } catch {
    return false;
  }
}

export function setNativeSessionActive(active: boolean): void {
  nativeSessionActive = active;
  try {
    if (active) localStorage.setItem(NATIVE_SESSION_KIND_KEY, "native");
    else localStorage.removeItem(NATIVE_SESSION_KIND_KEY);
  } catch {
    // The SDK secure store is still authoritative if web storage is unavailable.
  }
}

export function isNativeOpenKeySession(): boolean {
  return nativeSessionActive || nativeSessionWasActive();
}

export function secretsAvailable(): boolean {
  return secretsAvailableOverride ?? !isNativeOpenKeySession();
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
 * The entries OpenKey's native-client ceiling covers today, relative to the app folder as
 * `service:path`. Widen this list only together with the ceiling (TC-1990).
 */
const NATIVE_CEILING = new Set([
  "tinycloud.kv:threads/",
  "tinycloud.kv:connectors/",
  "tinycloud.sql:threads",
  "tinycloud.sql:canvas",
  "tinycloud.sql:connectors",
]);

/**
 * The delegation's permission list: the manifest's applications-space KV/SQL
 * entries that OpenKey's native-client ceiling covers today, paths prefixed
 * with the app id and actions expanded to full URNs, plus the mandatory
 * capabilities/read. Nothing else — the OpenKey ceiling refuses secrets, vault
 * and other spaces, so native sessions simply cannot hold them. Entries the
 * ceiling does not cover (the broad Home entries, the meeting databases, the
 * Exo mailbox folders) stay web-only until the ceiling is widened (TC-1990):
 * requesting one makes OpenKey refuse the whole native request, so a feature
 * that needs one must fail when it is used, not at sign-in.
 */
export function nativePermissions(manifest: Manifest): NativeDelegationPermission[] {
  const permissions: NativeDelegationPermission[] = [CAPABILITIES_READ];
  const prefix = manifest.prefix === undefined ? manifest.app_id : manifest.prefix;
  for (const entry of manifest.permissions ?? []) {
    const space = entry.space ?? "applications";
    if (space !== "applications" || !NATIVE_SERVICES.has(entry.service)) continue;
    const path = entry.skipPrefix || prefix === "" ? entry.path : `${prefix}/${entry.path}`;
    if (prefix !== "" && !NATIVE_CEILING.has(`${entry.service}:${path.slice(prefix.length + 1)}`)) continue;
    if (prefix !== "" && !path.startsWith(`${prefix}/`)) continue;
    permissions.push({
      service: entry.service,
      space: "applications",
      path,
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
export const NATIVE_SIGN_IN_NONCE_MESSAGE =
  "Sign-in took too long. Please try again.";
export const NATIVE_SIGN_IN_SPACE_MESSAGE =
  "Your TinyCloud space is unavailable right now. Please try again later.";
export const NATIVE_SIGN_IN_NETWORK_MESSAGE =
  "Can't reach OpenKey right now. Check your connection and try again.";
export const NATIVE_SIGN_IN_STORAGE_MESSAGE =
  "Couldn't access secure storage on this device. Please try again.";
export const NATIVE_SIGN_IN_SERVER_MESSAGE =
  "OpenKey couldn't complete sign-in. The app or server may need configuration; please try again later.";
export const NATIVE_SIGN_IN_FAILED_MESSAGE =
  "Native sign-in failed. Please try again.";

class NativeSpaceUnavailableError extends Error {
  readonly code = "SPACE_UNAVAILABLE";
}

class NativeHandoffRetryError extends Error {
  readonly code = "HANDOFF_RETRY";
}

function nativeErrorCode(error: unknown): string | null {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : null;
}

/** Keep diagnostics useful without printing credentials carried by SDK or fetch errors. */
function safeErrorMessage(message: string): string {
  return message
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/([?&](?:code|token|refresh_token|access_token|session_key|key)=)[^&\s]+/gi, "$1[redacted]")
    .replace(/("(?:d|privateJwk|refreshToken|accessToken|sessionKey)"\s*:\s*")[^"]+"/gi, "$1[redacted]\"")
    .replace(/((?:token|secret|password|refresh[_-]?token|access[_-]?token|private[_-]?key|sessionKey|authorization)\s*[:=]\s*)\S+/gi, "$1[redacted]")
    .replace(/\b(?:eyJ[A-Za-z0-9_-]+\.){2}[A-Za-z0-9_-]+\b/g, "[redacted]")
    .replace(/\b0x[a-f\d]{64,}\b/gi, "[redacted]")
    .replace(/\b[A-Za-z0-9_-]{80,}\b/g, "[redacted]")
    .slice(0, 240);
}

export function logNativeOpenKeyError(operation: string, error: unknown): void {
  const code = nativeErrorCode(error);
  const { status, serverError } = (error ?? {}) as { status?: unknown; serverError?: unknown };
  const name = error instanceof Error ? error.name : "unknown error";
  const message = error instanceof Error ? safeErrorMessage(error.message) : "";
  console.warn(`[OpenKey native] ${operation}: ${name}${code ? ` code=${code}` : ""}${typeof status === "number" ? ` status=${status}` : ""}${typeof serverError === "string" && /^[a-z_]{1,64}$/.test(serverError) ? ` serverError=${serverError}` : ""}${message ? ` message=${message}` : ""}`);
}

/**
 * The message for a failed sign-in or restore. The failure is logged through the
 * redacting logger above (a code or message string, never the error object or its
 * cause chain); a UserFacingError was already logged where it was thrown.
 */
export function describeAuthFailure(error: unknown): string {
  if (!(error instanceof UserFacingError)) logNativeOpenKeyError("sign-in", error);
  return authErrorMessage(error);
}

/** Map an OpenKey native failure to a user-facing message. */
export function nativeSignInErrorMessage(error: unknown): string {
  const code = nativeErrorCode(error);
  if (code === "USER_CANCELLED") return NATIVE_SIGN_IN_CANCELLED_MESSAGE;
  if (code === "ACCESS_DENIED") return NATIVE_SIGN_IN_DENIED_MESSAGE;
  if (error instanceof Error && /invalid_nonce|nonce.{0,45}(invalid|expired|already used)/i.test(error.message)) {
    return NATIVE_SIGN_IN_NONCE_MESSAGE;
  }
  if (code === "SPACE_UNAVAILABLE") return NATIVE_SIGN_IN_SPACE_MESSAGE;
  if (code === "STORAGE") return NATIVE_SIGN_IN_STORAGE_MESSAGE;
  if (code === "NETWORK" || code === "TEMPORARILY_UNAVAILABLE" ||
    (error instanceof Error && /failed to fetch|network|fetch failed|load failed/i.test(error.message))) {
    return NATIVE_SIGN_IN_NETWORK_MESSAGE;
  }
  if (code === "SERVER" || code === "STATE_MISMATCH" || code === "INVALID_GRANT" || code === "UNAVAILABLE") {
    return NATIVE_SIGN_IN_SERVER_MESSAGE;
  }
  return NATIVE_SIGN_IN_FAILED_MESSAGE;
}

export const NATIVE_SIGN_OUT_WARNING =
  "Exo signed out locally. OpenKey will retry any queued revocation when the app opens again. Check your grants at openkey.so if it remains active.";
export const NATIVE_SIGN_OUT_STORAGE_WARNING =
  "Couldn't access secure storage on this device. Your OpenKey session may still be stored. Please try signing out again when storage is available.";

export function isNativeStorageError(error: unknown): boolean {
  return nativeErrorCode(error) === "STORAGE";
}

// ── Sign-in ───────────────────────────────────────────────────────────

/** What Exo's own sign-in screen tells OpenKey, so its sheet opens on that step. The server treats both as hints. */
export interface NativeSignInHints {
  /** Only with `loginMethod: "email"`. A normalised address (see `normalizeLoginHint`). */
  loginHint?: string;
  loginMethod: "email" | "passkey" | "google";
}

/** The login_hint rule: no whitespace, exactly one "@" with text either side, at most 254 characters. Lowercased. Null when it is not an address. */
export function normalizeLoginHint(value: string): string | null {
  const email = value.trim();
  if (email.length === 0 || email.length > 254 || /\s/.test(email)) return null;
  const parts = email.split("@");
  if (parts.length !== 2 || parts[0] === "" || parts[1] === "") return null;
  return email.toLowerCase();
}

export interface NativeSignInConfig {
  backendUrl: string;
  /** The configured TinyCloud node the delegation must name (VITE_TINYCLOUD_HOST). */
  tinycloudHost: string;
  tinycloudHosts?: string[];
  env?: {
    VITE_OPENKEY_NATIVE_CLIENT_ID?: string;
    /** The same widget host App.tsx reads (OPENKEY_HOST); defaults to https://openkey.so. */
    VITE_OPENKEY_HOST?: string;
  };
}

export interface NativeSignInResult {
  address: string;
  /** Ready TinyCloudWeb instance with the delegation restored. */
  tcw: unknown;
  /** SIWE + signature the backend /api/auth/verify exchanged for a session token. */
  verified: { token: string; expiresIn: number; address: string };
  delegationExpiresAt: string;
  session: NativeSession;
  openkey: OpenKeyNative;
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
  ) => Promise<SpaceHostResult>;
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

/** The client's registered redirect; the Exo app's own reverse-DNS scheme. */
const NATIVE_REDIRECT_URI = "xyz.tinycloud.exo://openkey/callback";
const DEFAULT_OPENKEY_HOST = "https://openkey.so";

/**
 * Derive the OpenKey OAuth API host from the widget host, exactly like
 * `@openkey/sdk`'s own (private) `OpenKey.deriveOAuthHost`: prefix `api.` to
 * the hostname, except for a loopback host (local dev, where the API and
 * widget share one origin). One OpenKey host config, read the same way App.tsx
 * reads it for the widget (`VITE_OPENKEY_HOST`) — no second override. A
 * malformed host is a broken build and throws; it never falls back to prod.
 */
function deriveOAuthHost(host: string): string {
  let url: URL;
  try {
    url = new URL(host);
  } catch {
    throw new Error(`Native sign-in is not configured in this build (VITE_OPENKEY_HOST is not a valid URL: ${JSON.stringify(host)}).`);
  }
  if (url.hostname === "localhost" || url.hostname === "127.0.0.1") {
    return host.replace(/\/$/, "");
  }
  url.hostname = `api.${url.hostname}`;
  return url.toString().replace(/\/$/, "");
}

function nativeIssuer(openKeyHost: string): string {
  return `${deriveOAuthHost(openKeyHost)}/api/auth`;
}

let defaultOpenKeyNative: OpenKeyNative | null = null;

/** Exported for tests only: the exact options a native sign-in hands to OpenKeyNative. */
export function nativeClientOptions(
  env: NativeSignInConfig["env"] | undefined,
  tinycloudHost: string,
): Parameters<NativeSignInDeps["createOpenKeyNative"]>[0] {
  const clientId = env?.VITE_OPENKEY_NATIVE_CLIENT_ID;
  if (!clientId) {
    throw new Error("Native sign-in is not configured in this build (VITE_OPENKEY_NATIVE_CLIENT_ID is unset).");
  }
  return {
    clientId,
    redirectUri: NATIVE_REDIRECT_URI,
    issuer: nativeIssuer(env?.VITE_OPENKEY_HOST || DEFAULT_OPENKEY_HOST),
    tinycloudHost,
  };
}

function nativeClient(
  options: Parameters<NativeSignInDeps["createOpenKeyNative"]>[0],
  create: NativeSignInDeps["createOpenKeyNative"],
): OpenKeyNative {
  return defaultOpenKeyNative ??= create(options);
}

const NATIVE_FETCH_TIMEOUT_MS = 10_000;

export const NATIVE_SIGN_OUT_DEADLINE_MS = 10_000;

function withNativeDeadline<T>(run: Promise<T>, ms = NATIVE_SIGN_OUT_DEADLINE_MS): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("OpenKey sign-out timed out")), ms);
    run.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

/** Tests only: isolate the module-level SDK client between mocked flows. */
export function resetNativeOpenKeyClientForTests(): void {
  defaultOpenKeyNative = null;
}

/** Android Custom Tabs chrome, matching OpenKey's dark native page. iOS has nothing to style and ignores it. */
export const NATIVE_BROWSER_THEME = { toolbarColor: "#09090B", colorScheme: "dark" } as const;

async function defaultDeps(): Promise<NativeSignInDeps> {
  const [{ OpenKeyNative }, { activateSessionWithHost }, client] = await Promise.all([
    import("@openkey/sdk-capacitor"),
    import("@tinycloud/sdk-core"),
    import("@tinyboilerplate/client"),
  ]);
  return {
    createOpenKeyNative: (options) => new OpenKeyNative({ ...options, ephemeralSession: true,
      browserTheme: NATIVE_BROWSER_THEME,
      fetchFn: (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) =>
        withAbortTimeout(NATIVE_FETCH_TIMEOUT_MS, (signal) => fetch(url, { ...init, signal })),
    }),
    requestNonce: (backendUrl, address) => withAbortTimeout(NATIVE_FETCH_TIMEOUT_MS, (signal) => client.requestNonce(backendUrl, address, { signal })),
    loadManifest: client.loadAppManifest,
    activateSession: activateSessionWithHost,
    restoreSession: client.restoreTinyCloudWebSession,
    verifySession: (backendUrl, siwe, signature) => withAbortTimeout(NATIVE_FETCH_TIMEOUT_MS, (signal) => client.verifySession(backendUrl, siwe, signature, { signal })),
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
  hints?: NativeSignInHints,
  deps?: NativeSignInDeps,
): Promise<NativeSignInResult> {
  const env = config.env ?? import.meta.env;
  try {
    const d = deps ?? (await defaultDeps());
    const openkey = nativeClient(
      nativeClientOptions(env, config.tinycloudHost), d.createOpenKeyNative,
    );
    // The SDK keeps any existing session until the replacement commits. A
    // failed sign-in (including immediate renewal) handles its own cleanup.

    // The delegation's signer is unknown until OpenKey signs, so the backend
    // nonce is unbound; /verify binds it to the recovered address.
    const [siweNonce, manifest] = await Promise.all([
      d.requestNonce(config.backendUrl),
      d.loadManifest(`${config.backendUrl}/api/manifest`),
    ]);

    const session = await openkey.signIn({
      capabilities: nativePermissions(manifest),
      siweNonce,
      ...hints,
    });
    try {
      return await handoffNativeSession(openkey, session, config, d);
    } catch (error) {
      try {
        await openkey.signOut();
      } catch (revokeError) {
        logNativeOpenKeyError("cleanup revoke", revokeError);
      }
      throw error;
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Native sign-in is not configured")) {
      logNativeOpenKeyError("sign-in", error);
      throw new UserFacingError(error.message, { cause: error });
    }
    logNativeOpenKeyError("sign-in", error);
    throw new UserFacingError(nativeSignInErrorMessage(error), { cause: error });
  }
}

export type NativeBootOutcome =
  | { kind: "none" }
  | { kind: "restored"; address: string; tcw: TinyCloudWeb; session: NativeSession; openkey: OpenKeyNative; verified?: NativeSignInResult["verified"]; renewAt?: number }
  | { kind: "unavailable" }
  | { kind: "failed" }
  | { kind: "storage" }
  | { kind: "configuration" }
  | { kind: "terminal"; revoke: () => Promise<void> };

/** Restore before the backend JWT gate: a live native grant can mint a new JWT. */
export async function restoreNativeAtBoot(
  config: NativeSignInConfig,
  backendJwtValid: boolean,
  deps?: NativeSignInDeps,
): Promise<NativeBootOutcome> {
  let openkey: OpenKeyNative | null = null;
  try {
    const d = deps ?? await defaultDeps();
    openkey = nativeClient(nativeClientOptions(config.env ?? import.meta.env, config.tinycloudHost), d.createOpenKeyNative);
    let session = await openkey.current();
    if (!session) return { kind: "none" };
    let renewed = false;
    let renewAt: number | undefined;
    const expiresAt = new Date(session.delegation.expiresAt).getTime();
    const issuedAt = session.delegation.issuedAt ? new Date(session.delegation.issuedAt).getTime() : NaN;
    const minimumAt = Number.isFinite(issuedAt)
      ? issuedAt + Math.min(60_000, renewalLeadMs(session.delegation)) : 0;
    const wantsRenewal = !backendJwtValid || Date.now() >= nativeRenewAt(session);
    if (wantsRenewal && Date.now() < minimumAt && Date.now() < expiresAt) {
      // OpenKey rejects renewal inside its minimum interval. Restore the live
      // delegation now and let the scheduler refresh the JWT at the first legal time.
      renewAt = minimumAt;
    } else if (wantsRenewal) {
      let siweNonce: string | undefined;
      try { siweNonce = await d.requestNonce(config.backendUrl, session.delegation.address); }
      catch { /* A nonce fetch outage does not prevent delegation renewal. */ }
      try {
        session = await openkey.renew(siweNonce ? { siweNonce } : {});
        renewed = true;
      } catch (error) {
        if (Date.now() >= expiresAt || nativeCode(error) !== "RENEWAL_TOO_SOON") throw error;
        const retryAfterSeconds = (error as { retryAfterSeconds?: unknown }).retryAfterSeconds;
        renewAt = Date.now() + (typeof retryAfterSeconds === "number" ? retryAfterSeconds * 1000 : 15_000);
      }
    }
    const installed = await installNativeSession(openkey, session, config, d, undefined, !renewed, true);
    let verified: NativeSignInResult["verified"] | undefined;
    if (renewed) {
      try {
        verified = await d.verifySession(config.backendUrl, session.delegation.siwe!, session.delegation.signature!);
      } catch (error) {
        installed.tcw.cleanup();
        logNativeOpenKeyError("backend verification", error);
        return { kind: isNetworkRestoreError(error) ? "unavailable" : "failed" };
      }
    }
    return { kind: "restored", address: installed.address, tcw: installed.tcw, session, openkey, verified, renewAt };
  } catch (error) {
    logNativeOpenKeyError("boot restore", error);
    if (error instanceof Error && error.message.startsWith("Native sign-in is not configured")) return { kind: "configuration" };
    if (nativeCode(error) === "STORAGE") return { kind: "storage" };
    if (!terminalRenewalError(error)) return { kind: isNetworkRestoreError(error) ? "unavailable" : "failed" };
    const client = openkey;
    return { kind: "terminal", revoke: () => {
      if (!client) return Promise.reject(new Error("Native OpenKey client unavailable during terminal revoke"));
      return withNativeDeadline(client.signOut());
    } };
  }
}

export function isNetworkRestoreError(error: unknown): boolean {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return true;
  const code = nativeCode(error);
  if (code === "NETWORK" || code === "TEMPORARILY_UNAVAILABLE") return true;
  return error instanceof Error && /(?:failed to fetch|network request failed|network connection was lost|internet connection appears to be offline|load failed)/i.test(error.message);
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
  const installed = await installNativeSession(openkey, session, config, d);
  const verified = await d.verifySession(config.backendUrl, session.delegation.siwe!, session.delegation.signature!);
  return { ...installed, verified, delegationExpiresAt: delegationExpiryIso(session.delegation.expiresAt), session, openkey };
}

/** Reuse the same SDK instance and E1 handoff for every live renewal. */
export async function nativeRenewalServices(
  config: NativeSignInConfig,
  openkey: OpenKeyNative,
  deps?: NativeSignInDeps,
) {
  const d = deps ?? await defaultDeps();
  return {
    requestNonce: (address: string) => d.requestNonce(config.backendUrl, address),
    verifySession: (siwe: string, signature: string) => d.verifySession(config.backendUrl, siwe, signature),
    install: (session: NativeSession, tcw: TinyCloudWeb) => installNativeSession(openkey, session, config, d, tcw).then(() => undefined),
  };
}

/** SDK persistence precedes this; the adapter record is saved, activated, then swapped. */
export async function installNativeSession(
  openkey: OpenKeyNative,
  session: NativeSession,
  config: NativeSignInConfig,
  d: NativeSignInDeps,
  liveTcw?: TinyCloudWeb,
  alreadyStored = false,
  restoringExisting = false,
): Promise<{ address: string; tcw: TinyCloudWeb }> {
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
    (!restoringExisting && delegation.tinycloudHost !== config.tinycloudHost)
  ) {
    throw new Error("OpenKey returned an incomplete delegation for a different TinyCloud node.");
  }

  const storage = openkey.sessionStorageAdapter();
  const stored = alreadyStored ? await storage.load(address) : null;
  if (!stored || stored.tinycloudSession?.delegationCid !== delegation.delegationCid) await storage.save(address, {
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
  if (!activation.success) {
    throw new NativeHandoffRetryError(activation.error ?? "TinyCloud space activation failed");
  }
  // OpenKey may already have hosted the space during consent. In that case
  // /delegate returns a successful reconciliation with activated: [].
  if (activation.skipped?.includes(delegation.spaceId)) {
    throw new NativeSpaceUnavailableError("TinyCloud could not host the delegated space");
  }

  if (liveTcw) {
    const restored = await liveTcw.restoreSession(address);
    if (restored.status !== "restored") throw new NativeHandoffRetryError("TinyCloud live session swap failed");
    return { address, tcw: liveTcw };
  }
  const restored = await d.restoreSession(address, {
    includeAccountRegistryPermissions: false,
    tinycloudHosts: [delegation.tinycloudHost, ...(config.tinycloudHosts ?? [config.tinycloudHost])].filter((host, index, hosts) => hosts.indexOf(host) === index),
    autoCreateSpace: false,
    sessionStorage: storage,
    provider: createNativeReadOnlyProvider(address, chainId),
  });
  if (restored.status !== "restored" || !restored.tcw) {
    throw new NativeHandoffRetryError(restored.error?.message ?? "TinyCloud session restore failed");
  }
  return { address, tcw: restored.tcw as TinyCloudWeb };
}

/** Sign the native OpenKey session out: revoke the delegation grant and drop the secure-store record. */
export async function signOutNative(deps?: {
  createOpenKeyNative?: NativeSignInDeps["createOpenKeyNative"];
  env?: NativeSignInConfig["env"] & { VITE_TINYCLOUD_HOST?: string };
}): Promise<void> {
  const env = deps?.env ?? import.meta.env;
  const create = deps?.createOpenKeyNative ?? (await defaultDeps()).createOpenKeyNative;
  const openkey = nativeClient(
    nativeClientOptions(env, env.VITE_TINYCLOUD_HOST ?? "https://tee.node.tinycloud.xyz"),
    create,
  );
  await withNativeDeadline(openkey.signOut());
}
