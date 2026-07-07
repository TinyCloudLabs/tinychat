import { TinyCloudWeb, BrowserSessionStorage } from "@tinycloud/web-sdk";
import type {
  ClientSession,
  ComposedManifestRequest,
  Config as TinyCloudWebSdkConfig,
  Manifest,
  SessionRestoreResult,
  SiweConfig,
} from "@tinycloud/web-sdk";
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
    sessionStorage: new BrowserSessionStorage(),
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

/**
 * Restore a browser TinyCloudWeb session from BrowserSessionStorage without
 * connecting a wallet. The returned instance is session-only: it can use the
 * restored TinyCloud delegation for direct storage, but cannot create new
 * wallet-signed delegations until a provider is connected later.
 */
export async function restoreTinyCloudWebSession(
  address: string,
  config?: TinyCloudWebConfig,
): Promise<RestoreTinyCloudWebSessionResult> {
  const manifest = config?.manifest ?? config?.capabilityRequest?.manifests;
  const tcwConfig: TinyCloudWebSdkConfig = {
    tinycloudHosts: config?.tinycloudHosts,
    tinycloudRegistryUrl: config?.tinycloudRegistryUrl,
    tinycloudFallbackHosts: config?.tinycloudFallbackHosts,
    autoCreateSpace: config?.autoCreateSpace ?? false,
    sessionStorage: new BrowserSessionStorage(),
    nonce: config?.nonce,
    siweConfig: config?.siweConfig,
    manifest,
    capabilityRequest: config?.capabilityRequest,
    includeAccountRegistryPermissions: config?.includeAccountRegistryPermissions,
  };

  const tcw = new TinyCloudWeb(tcwConfig);

  try {
    const result = await tcw.restoreSession(address);
    if (result.status === "restored") {
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
