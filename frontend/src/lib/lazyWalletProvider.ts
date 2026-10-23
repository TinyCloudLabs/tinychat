/**
 * EIP-1193 provider for a restored session. Account requests answer silently
 * with the stored address, so restoring a session never opens the wallet. The
 * wallet opens on the first request that needs it (signing, chain id), once per
 * successful open. A failed open is not cached, so the next request retries it.
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

export type LazyWalletProviderOptions = {
  /** Address of the restored session. Account requests answer exactly this value. */
  address: string;
  /** Opens the wallet. Called again only after a failed open. */
  openWallet: () => Promise<LazyWallet>;
};

/** Neutral message when the opened wallet is a different account. */
export const WALLET_ACCOUNT_MISMATCH_MESSAGE = "Wallet does not match the signed-in account";

const SILENT_ACCOUNT_METHODS: Record<string, true> = {
  eth_accounts: true,
  eth_requestAccounts: true,
};

export function createLazyWalletProvider(options: LazyWalletProviderOptions): LazyWalletProvider {
  const { address } = options;
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
      if (SILENT_ACCOUNT_METHODS[args.method] === true) return [address];
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
