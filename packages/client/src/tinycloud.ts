import { TinyCloudWeb, BrowserSessionStorage } from "@tinycloud/web-sdk";
import { SESSION_EXPIRATION_MS } from "@tinyboilerplate/core";
import type {
  ClientSession,
  ComposedManifestRequest,
  Config as TinyCloudWebSdkConfig,
  Manifest,
  SessionRestoreResult,
  SiweConfig,
} from "@tinycloud/web-sdk";
import type { ISessionStorage, PersistedSessionData } from "@tinycloud/web-sdk";
import type { EIP1193Provider } from "./openkey.js";

// ── Configuration ────────────────────────────────────────────────────

export interface TinyCloudWebConfig {
  tinycloudHosts?: string[];
  tinycloudRegistryUrl?: string | null;
  tinycloudFallbackHosts?: string[] | null;
  autoCreateSpace?: boolean;
  siweConfig?: SiweConfig;
  /**
   * Manifest driving the SIWE recap at sign-in. If `capabilityRequest`
   * is present, it takes precedence and is signed directly.
   */
  manifest?: Manifest;
  /** Pre-composed manifest request that may include app and delegate manifests. */
  capabilityRequest?: ComposedManifestRequest;
  /** Include implicit account registry permissions when composing `manifest`. Default true in the SDK. */
  includeAccountRegistryPermissions?: boolean;
  /**
   * Session storage backend. Defaults to BrowserSessionStorage (localStorage);
   * the Exo native app passes the OpenKey secure-store adapter so the session
   * key never touches web storage.
   */
  sessionStorage?: ISessionStorage;
  /** SIWE nonce override. If set, `siweConfig.nonce` still wins inside the SDK. */
  nonce?: string;
}

export interface RestoreTinyCloudWebSessionResult {
  tcw: TinyCloudWeb | null;
  status: SessionRestoreResult["status"];
  session?: ClientSession;
  error?: Error;
}

// ── TinyCloudWeb Instance ────────────────────────────────────────────

/**
 * Create a TinyCloudWeb instance with BrowserSessionStorage for session persistence.
 */
export function createTinyCloudWeb(
  web3Provider: EIP1193Provider,
  config?: TinyCloudWebConfig,
): TinyCloudWeb {
  const manifest = config?.manifest ?? config?.capabilityRequest?.manifests;
  const tcwConfig: TinyCloudWebSdkConfig = {
    provider: web3Provider,
    tinycloudHosts: config?.tinycloudHosts,
    tinycloudRegistryUrl: config?.tinycloudRegistryUrl,
    tinycloudFallbackHosts: config?.tinycloudFallbackHosts,
    autoCreateSpace: config?.autoCreateSpace ?? true,
    sessionStorage: config?.sessionStorage ?? new BrowserSessionStorage(),
    sessionExpirationMs: SESSION_EXPIRATION_MS,
    nonce: config?.nonce,
    siweConfig: config?.siweConfig,
    manifest,
    capabilityRequest: config?.capabilityRequest,
    includeAccountRegistryPermissions: config?.includeAccountRegistryPermissions,
    // web-sdk 2.4.x account auto-bootstrap retries /invoke every ~2s for
    // minutes on a fresh origin, outliving the backend's 5-minute SIWE nonce
    // TTL. Disable it (same mitigation as the billing app) until the SDK is
    // on 2.5.x, which gates bootstrap on interactive signers. The option is
    // read at runtime but absent from the published Config type.
    ...({ autoBootstrapAccount: false } as Partial<TinyCloudWebSdkConfig>),
  };

  return new TinyCloudWeb(tcwConfig);
}

/**
 * Create a TinyCloudWeb instance and sign in.
 *
 * Accepts an optional `nonce` to pass through to the SDK's SIWE message
 * construction, and optional manifest/capability request inputs that drive
 * the session's granted capabilities. The SDK's `signIn()` returns a `ClientSession`
 * containing the signed SIWE message and signature.
 */
export async function createAndSignIn(
  web3Provider: EIP1193Provider,
  config?: TinyCloudWebConfig & { address?: string },
): Promise<{ tcw: TinyCloudWeb; session: ClientSession }> {
  const siweConfig = config?.nonce
    ? { ...config?.siweConfig, nonce: config.nonce }
    : config?.siweConfig;
  const tcw = createTinyCloudWeb(web3Provider, { ...config, siweConfig });
  if (config?.nonce) {
    await tcw.clearPersistedSession(config.address);
  }
  const session = await tcw.signIn(config?.nonce ? { nonce: config.nonce } : undefined);
  return { tcw, session };
}

/** Matched by `code` in frontend/src/lib/sessionRestore.ts. */
export const RESTORED_SESSION_MISSING_SPACE_CODE = "restored-session-missing-space";

export class RestoredSessionMissingSpaceError extends Error {
  readonly code = RESTORED_SESSION_MISSING_SPACE_CODE;

  constructor() {
    super(
      "Restored TinyCloud session has no spaceId: the SDK reported none and the persisted session has none",
    );
    this.name = "RestoredSessionMissingSpaceError";
  }
}

interface RecordingStorage {
  storage: ISessionStorage;
  /** Start capturing; returns the record the SDK loaded while capturing. */
  capture: <T>(run: () => Promise<T>) => Promise<{ value: T; record: PersistedSessionData | null }>;
}

/**
 * Proxies the session storage so the exact record the SDK's restore consumes
 * can be read back, instead of reading storage a second time (which could see
 * a different record than the one the SDK installed).
 */
function recordRestoredSession(storage: ISessionStorage): RecordingStorage {
  let capturing = false;
  let record: PersistedSessionData | null = null;

  const proxy = new Proxy(storage, {
    get(target, prop) {
      const member = Reflect.get(target, prop, target);
      if (typeof member !== "function" || prop === "constructor") return member;
      if (prop === "load") {
        return async (address: string) => {
          const data = (await member.call(target, address)) as PersistedSessionData | null;
          if (capturing) record = data;
          return data;
        };
      }
      if (prop === "loadWithStatus") {
        return async (address: string) => {
          const result = await member.call(target, address);
          if (capturing) record = result?.status === "loaded" ? result.data : null;
          return result;
        };
      }
      return member.bind(target);
    },
  });

  return {
    storage: proxy,
    capture: async (run) => {
      capturing = true;
      record = null;
      try {
        const value = await run();
        return { value, record };
      } finally {
        capturing = false;
        record = null;
      }
    },
  };
}

/**
 * @tinycloud/web-sdk 2.11.0 restores a session without an auth instance into
 * `_restoredTcSession`, but its `spaceId` getter only reads the auth instance,
 * so a restored `tcw.spaceId` is undefined. Fall back to the space of the very
 * record the SDK restored from, and fail the restore when it has none. To be
 * reported upstream; remove once the SDK's getter reads the restored session.
 */
function exposeRestoredSpaceId(tcw: TinyCloudWeb, restored: PersistedSessionData | null): void {
  if (tcw.spaceId) return;

  const restoredSpaceId = restored?.tinycloudSession?.spaceId;
  if (!restoredSpaceId) {
    const error = new RestoredSessionMissingSpaceError();
    console.error("[tinycloud] restore failed:", error.message);
    throw error;
  }

  Object.defineProperty(tcw, "spaceId", {
    configurable: true,
    get: () => Reflect.get(Object.getPrototypeOf(tcw), "spaceId", tcw) ?? restoredSpaceId,
  });
}

/**
 * Restore a TinyCloudWeb session from the configured session storage (browser
 * localStorage by default; the Exo native app's secure-store adapter when
 * `sessionStorage` is given). `provider` lets the native app attach a
 * read-only EIP-1193 stub so `tcw.session()` and `spaceId` are populated
 * without any wallet-signing surface.
 */
export async function restoreTinyCloudWebSession(
  address: string,
  config?: TinyCloudWebConfig & { provider?: EIP1193Provider },
): Promise<RestoreTinyCloudWebSessionResult> {
  const manifest = config?.manifest ?? config?.capabilityRequest?.manifests;
  const recording = recordRestoredSession(config?.sessionStorage ?? new BrowserSessionStorage());
  const tcwConfig: TinyCloudWebSdkConfig = {
    tinycloudHosts: config?.tinycloudHosts,
    tinycloudRegistryUrl: config?.tinycloudRegistryUrl,
    tinycloudFallbackHosts: config?.tinycloudFallbackHosts,
    autoCreateSpace: config?.autoCreateSpace ?? false,
    sessionStorage: recording.storage,
    nonce: config?.nonce,
    siweConfig: config?.siweConfig,
    manifest,
    capabilityRequest: config?.capabilityRequest,
    includeAccountRegistryPermissions: config?.includeAccountRegistryPermissions,
  };

  if (config?.provider) {
    tcwConfig.provider = config.provider;
  }

  const tcw = new TinyCloudWeb(tcwConfig);

  try {
    const { value: result, record } = await recording.capture(() => tcw.restoreSession(address));
    if (result.status === "restored") {
      exposeRestoredSpaceId(tcw, record);
      return { tcw, status: result.status, session: result.session };
    }

    tcw.cleanup();
    return { tcw: null, status: result.status, error: result.error };
  } catch (err) {
    tcw.cleanup();
    return {
      tcw: null,
      status: "restore-failed",
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }
}
