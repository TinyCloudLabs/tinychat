import OpenKey from "@openkey/sdk";
import type { Config as TinyCloudWebSdkConfig } from "@tinycloud/web-sdk";

// ── Configuration ────────────────────────────────────────────────────

export interface ConnectWalletConfig {
  host?: string;
  appName?: string;
  /** EIP-155 chain ID in hex, defaults to "0x1" (Ethereum mainnet) */
  chainId?: string;
  /** False where WebAuthn is unavailable; OpenKey then hides passkey options. Defaults to true. */
  passkeysSupported?: boolean;
}

export interface ConnectWalletResult {
  address: string;
  keyId: string;
  openkey: OpenKey;
  web3Provider: EIP1193Provider;
}

// ── EIP-1193 Provider ────────────────────────────────────────────────

export interface EIP1193Provider {
  on(event: string, listener: (...args: any[]) => void): void;
  removeListener(event: string, listener: (...args: any[]) => void): void;
  request(args: { method: string; params?: any[] }): Promise<any>;
}

/**
 * EIP-1193 compatible provider that routes signing to OpenKey.
 * TinyCloudWeb treats this like any browser wallet.
 */
class OpenKeyEIP1193Provider implements EIP1193Provider {
  constructor(
    private openkey: OpenKey,
    private address: string,
    private keyId: string,
    private chainId: string,
  ) {}

  on(_event: string, _listener: (...args: any[]) => void): void {}
  removeListener(_event: string, _listener: (...args: any[]) => void): void {}

  async request({ method, params }: { method: string; params?: any[] }): Promise<any> {
    switch (method) {
      case "eth_accounts":
      case "eth_requestAccounts":
        return [this.address];
      case "eth_chainId":
        return this.chainId;
      case "personal_sign": {
        const hexMessage = params![0];
        const message = hexToString(hexMessage);
        const result = await this.openkey.signMessage({
          message,
          keyId: this.keyId,
        });
        return result.signature;
      }
      case "eth_getBalance":
        return "0x0";
      default:
        throw new Error(`Unsupported method: ${method}`);
    }
  }
}

function hexToString(hex: string): string {
  const cleaned = hex.startsWith("0x") ? hex.slice(2) : hex;
  const bytes = new Uint8Array(cleaned.match(/.{1,2}/g)!.map((b) => parseInt(b, 16)));
  return new TextDecoder().decode(bytes);
}

// ── Sign-in with renewal ────────────────────────────────────────────

/** The renewal ask for OpenKey's sign-in window (TC-2872). OpenKey offers it only beside `expiryChangeable: true`. */
export interface OpenKeyRenewalAsk {
  version: 1;
  leaseLifetimeSeconds: number;
  purpose?: "standing" | "task";
}

/** What the sign-in result says about renewal. An @openkey/sdk without sign-in renewal leaves both out. */
export interface OpenKeyRenewalOutcome {
  renewalChoice?: unknown;
  /** The lease receipt OpenKey signed, unverified and not yet admitted at the node. */
  renewal?: unknown;
}

type OpenKeySignInClient = NonNullable<TinyCloudWebSdkConfig["openkey"]>["client"];

/**
 * The OpenKey client the SDK's sign-in calls, adding the renewal ask to OpenKey's request and handing what
 * comes back about renewal to `onOutcome` before the SDK builds the session from the signed result.
 */
export function openKeyRenewalClient(
  openkey: OpenKey,
  renewal: OpenKeyRenewalAsk,
  onOutcome: (outcome: OpenKeyRenewalOutcome) => void,
): OpenKeySignInClient {
  return {
    authorizeTinyCloud: async (request, opts) => {
      const result = await openkey.authorizeTinyCloud(
        { ...request, renewal } as Parameters<OpenKey["authorizeTinyCloud"]>[0],
        opts,
      );
      const { renewalChoice, renewal: receipt } = result as OpenKeyRenewalOutcome;
      onOutcome({ renewalChoice, renewal: receipt });
      return result;
    },
  };
}

// ── Connect Wallet ──────────────────────────────────────────────────

/**
 * Connect wallet via OpenKey passkey authentication.
 *
 * Returns an EIP-1193-compatible provider and the wallet address.
 * TinyCloudWeb wraps the provider internally for SIWE signing.
 */
export async function connectWallet(config?: ConnectWalletConfig): Promise<ConnectWalletResult> {
  const openkey = new OpenKey({
    host: config?.host ?? "https://openkey.so",
    appName: config?.appName ?? "TinyCloud App",
    passkeysSupported: config?.passkeysSupported,
  });

  // Passkey authentication via iframe — user authenticates, we get signing capability
  const authResult = await openkey.connect();

  // Create EIP-1193 provider for SIWE signing
  const eip1193 = new OpenKeyEIP1193Provider(
    openkey,
    authResult.address,
    authResult.keyId,
    config?.chainId ?? "0x1",
  );

  return {
    address: authResult.address,
    keyId: authResult.keyId,
    openkey,
    web3Provider: eip1193,
  };
}
