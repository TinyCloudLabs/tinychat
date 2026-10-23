import { describe, expect, test } from "bun:test";
import {
  createLazyWalletProvider,
  type LazyWallet,
  WALLET_ACCOUNT_MISMATCH_MESSAGE,
} from "./lazyWalletProvider";

const STORED = "0xAbC0000000000000000000000000000000000001";

function makeWallet(address: string) {
  const requests: string[] = [];
  const subscriptions: string[] = [];
  const wallet: LazyWallet = {
    address,
    provider: {
      request: async ({ method }) => {
        requests.push(method);
        return "0xsig";
      },
      on: (event) => {
        subscriptions.push(event);
      },
      removeListener: () => {},
    },
  };
  return { wallet, requests, subscriptions };
}

describe("createLazyWalletProvider", () => {
  test("account requests answer with the stored address without opening the wallet", async () => {
    let opens = 0;
    const provider = createLazyWalletProvider({
      address: STORED,
      openWallet: async () => {
        opens += 1;
        return makeWallet(STORED).wallet;
      },
    });
    expect(await provider.request({ method: "eth_accounts" })).toEqual([STORED]);
    expect(await provider.request({ method: "eth_requestAccounts" })).toEqual([STORED]);
    expect(opens).toBe(0);
  });

  test("the first signing request opens the wallet once and later requests reuse it", async () => {
    const fake = makeWallet(STORED);
    let opens = 0;
    const provider = createLazyWalletProvider({
      address: STORED,
      openWallet: async () => {
        opens += 1;
        return fake.wallet;
      },
    });
    const [signed, chainId] = await Promise.all([
      provider.request({ method: "personal_sign", params: ["0x1", STORED] }),
      provider.request({ method: "eth_chainId" }),
    ]);
    await provider.request({ method: "personal_sign", params: ["0x2", STORED] });
    expect(signed).toBe("0xsig");
    expect(chainId).toBe("0xsig");
    expect(opens).toBe(1);
    expect([...fake.requests].sort()).toEqual(["eth_chainId", "personal_sign", "personal_sign"]);
  });

  test("address comparison ignores case", async () => {
    const fake = makeWallet(STORED.toLowerCase());
    const provider = createLazyWalletProvider({ address: STORED, openWallet: async () => fake.wallet });
    expect(await provider.request({ method: "personal_sign", params: [] })).toBe("0xsig");
  });

  test("a wallet on a different account rejects and forwards no request", async () => {
    const fake = makeWallet("0x0000000000000000000000000000000000000099");
    const provider = createLazyWalletProvider({ address: STORED, openWallet: async () => fake.wallet });
    await expect(provider.request({ method: "personal_sign", params: [] })).rejects.toThrow(
      WALLET_ACCOUNT_MISMATCH_MESSAGE,
    );
    expect(fake.requests).toEqual([]);
  });

  test("a failed open is not cached, so the next request retries it", async () => {
    const fake = makeWallet(STORED);
    let attempts = 0;
    const provider = createLazyWalletProvider({
      address: STORED,
      openWallet: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("declined");
        return fake.wallet;
      },
    });
    await expect(provider.request({ method: "personal_sign", params: [] })).rejects.toThrow(
      "declined",
    );
    expect(await provider.request({ method: "personal_sign", params: [] })).toBe("0xsig");
    expect(attempts).toBe(2);
  });

  test("listeners registered before the open attach on open; later ones attach directly", async () => {
    const fake = makeWallet(STORED);
    const provider = createLazyWalletProvider({ address: STORED, openWallet: async () => fake.wallet });
    provider.on("accountsChanged", () => {});
    expect(fake.subscriptions).toEqual([]);
    await provider.request({ method: "personal_sign", params: [] });
    expect(fake.subscriptions).toEqual(["accountsChanged"]);
    provider.on("chainChanged", () => {});
    expect(fake.subscriptions).toEqual(["accountsChanged", "chainChanged"]);
  });
});
