/**
 * EIP-1193 provider for a restored session. Only the methods the wallet signer
 * uses are served: account requests answer silently with the stored address,
 * `eth_chainId` answers from the configured chain, and `personal_sign` opens the
 * wallet on first use (once per successful open; a failed open is not cached, so
 * the next request retries it). Every other method is refused with EIP-1193
 * error 4200 and never reaches the wallet.
 */

export type Listener = (...args: unknown[]) => void;

export type LazyWalletRequest = { method: string; params?: unknown };

/** The subset of the wallet provider this module drives. */
export type LazyWalletProvider = {
  request(args: LazyWalletRequest): Promise<unknown>;
  on(event: string, listener: Listener): void;
  removeListener(event: string, listener: Listener): void;
};

/** The wallet behind the provider, opened on demand. */
export type LazyWallet = {
  address: string;
  provider: LazyWalletProvider;
};

export type LazyWalletProviderOptions<W extends LazyWallet = LazyWallet> = {
  /** Address of the restored session. Account requests answer exactly this value. */
  address: string;
  /** Chain the session is on. `eth_chainId` answers this value without opening the wallet. */
  chainId: number;
  /** Opens the wallet. Called again only after a failed open. */
  openWallet: () => Promise<W>;
  /**
   * Runs once per successful open, after the account check passes and before the
   * wallet serves its first request. Not called for a wallet that fails the check.
   */
  onOpened?: (wallet: W) => void;
};

/** EIP-1193 error code for an unsupported method. */
export const UNSUPPORTED_METHOD_CODE = 4200;

export class UnsupportedMethodError extends Error {
  readonly code = UNSUPPORTED_METHOD_CODE;

  constructor(method: string) {
    super(`Unsupported wallet method: ${method}`);
    this.name = "UnsupportedMethodError";
  }
}

/** Neutral message when the opened wallet is a different account. */
export const WALLET_ACCOUNT_MISMATCH_MESSAGE = "Wallet does not match the signed-in account";

const SILENT_ACCOUNT_METHODS: Record<string, true> = {
  eth_accounts: true,
  eth_requestAccounts: true,
};

const OPENING_METHODS: Record<string, true> = {
  personal_sign: true,
};

export function createLazyWalletProvider<W extends LazyWallet>(
  options: LazyWalletProviderOptions<W>,
): LazyWalletProvider {
  const { address, chainId } = options;
  let wallet: LazyWalletProvider | null = null;
  let opening: Promise<LazyWalletProvider> | null = null;
  const listeners = new Map<string, Set<Listener>>();

  const ensureOpen = (): Promise<LazyWalletProvider> => {
    if (!opening) {
      opening = options
        .openWallet()
        .then((opened) => {
          if (opened.address.toLowerCase() !== address.toLowerCase()) {
            throw new Error(WALLET_ACCOUNT_MISMATCH_MESSAGE);
          }
          options.onOpened?.(opened);
          for (const [event, set] of listeners) {
            for (const listener of set) opened.provider.on(event, listener);
          }
          wallet = opened.provider;
          return opened.provider;
        })
        .catch((error: unknown) => {
          opening = null;
          throw error;
        });
    }
    return opening;
  };

  return {
    async request(args: LazyWalletRequest): Promise<unknown> {
      if (args.method === "eth_chainId") return `0x${chainId.toString(16)}`;
      if (SILENT_ACCOUNT_METHODS[args.method] === true) return [address];
      if (OPENING_METHODS[args.method] !== true) throw new UnsupportedMethodError(args.method);
      const target = await ensureOpen();
      return target.request(args);
    },
    on(event: string, listener: Listener): void {
      const set = listeners.get(event) ?? new Set<Listener>();
      set.add(listener);
      listeners.set(event, set);
      wallet?.on(event, listener);
    },
    removeListener(event: string, listener: Listener): void {
      listeners.get(event)?.delete(listener);
      wallet?.removeListener(event, listener);
    },
  };
}
