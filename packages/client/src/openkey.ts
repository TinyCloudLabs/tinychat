import OpenKey from "@openkey/sdk";

// ── Configuration ────────────────────────────────────────────────────

export interface ConnectWalletConfig {
  host?: string;
  appName?: string;
  /** EIP-155 chain ID in hex, defaults to "0x1" (Ethereum mainnet) */
  chainId?: string;
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
  });

  // Passkey authentication via iframe — user authenticates, we get signing capability
  console.log("[openkey] Calling openkey.connect()...");
  const authResult = await openkey.connect();
  console.log("[openkey] connect() done. Address:", authResult.address);

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
