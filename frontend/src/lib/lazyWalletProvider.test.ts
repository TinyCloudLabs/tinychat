import { describe, expect, test } from "bun:test";
import {
  createLazyWalletProvider,
  type LazyWallet,
  WALLET_ACCOUNT_MISMATCH_MESSAGE,
} from "./lazyWalletProvider";

const STORED = "0xAbC0000000000000000000000000000000000001";
const CHAIN_ID = 1;

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

function makeProvider(openWallet: () => Promise<LazyWallet>) {
  return createLazyWalletProvider({ address: STORED, chainId: CHAIN_ID, openWallet });
}

describe("createLazyWalletProvider", () => {
  test("account requests answer with the stored address without opening the wallet", async () => {
    let opens = 0;
    const provider = makeProvider(async () => {
      opens += 1;
      return makeWallet(STORED).wallet;
    });
    expect(await provider.request({ method: "eth_accounts" })).toEqual([STORED]);
    expect(await provider.request({ method: "eth_requestAccounts" })).toEqual([STORED]);
    expect(opens).toBe(0);
  });

  test("eth_chainId answers with the configured chain locally without opening the wallet", async () => {
    const fake = makeWallet(STORED);
    let opens = 0;
    const provider = makeProvider(async () => {
      opens += 1;
      return fake.wallet;
    });
    expect(await provider.request({ method: "eth_chainId" })).toBe("0x1");
    expect(opens).toBe(0);
    expect(fake.requests).toEqual([]);
  });

  test("personal_sign opens the wallet once and later signing requests reuse it", async () => {
    const fake = makeWallet(STORED);
    let opens = 0;
    const provider = makeProvider(async () => {
      opens += 1;
      return fake.wallet;
    });
    const [first, second] = await Promise.all([
      provider.request({ method: "personal_sign", params: ["0x1", STORED] }),
      provider.request({ method: "personal_sign", params: ["0x2", STORED] }),
    ]);
    expect(first).toBe("0xsig");
    expect(second).toBe("0xsig");
    expect(opens).toBe(1);
    expect(fake.requests).toEqual(["personal_sign", "personal_sign"]);
  });

  test.each([
    "eth_getBalance",
    "eth_call",
    "eth_sign",
    "eth_sendTransaction",
    "eth_signTypedData_v4",
    "wallet_switchEthereumChain",
  ])("%s is refused with EIP-1193 4200 and never reaches the wallet", async (method) => {
    const fake = makeWallet(STORED);
    let opens = 0;
    const provider = makeProvider(async () => {
      opens += 1;
      return fake.wallet;
    });
    await expect(provider.request({ method, params: [] })).rejects.toMatchObject({ code: 4200 });
    expect(opens).toBe(0);
    expect(fake.requests).toEqual([]);
  });

  test("address comparison ignores case", async () => {
    const fake = makeWallet(STORED.toLowerCase());
    const provider = makeProvider(async () => fake.wallet);
    expect(await provider.request({ method: "personal_sign", params: [] })).toBe("0xsig");
  });

  test("a wallet on a different account rejects and forwards no request", async () => {
    const fake = makeWallet("0x0000000000000000000000000000000000000099");
    const provider = makeProvider(async () => fake.wallet);
    await expect(provider.request({ method: "personal_sign", params: [] })).rejects.toThrow(
      WALLET_ACCOUNT_MISMATCH_MESSAGE,
    );
    expect(fake.requests).toEqual([]);
  });

  test("onOpened runs only after the account check passes", async () => {
    const seen: string[] = [];
    const mismatched = makeWallet("0x0000000000000000000000000000000000000099");
    const bad = createLazyWalletProvider({
      address: STORED,
      chainId: CHAIN_ID,
      openWallet: async () => mismatched.wallet,
      onOpened: (opened) => seen.push(opened.address),
    });
    await expect(bad.request({ method: "personal_sign", params: [] })).rejects.toThrow(
      WALLET_ACCOUNT_MISMATCH_MESSAGE,
    );
    expect(seen).toEqual([]);

    const matched = makeWallet(STORED);
    const good = createLazyWalletProvider({
      address: STORED,
      chainId: CHAIN_ID,
      openWallet: async () => matched.wallet,
      onOpened: (opened) => seen.push(opened.address),
    });
    await good.request({ method: "personal_sign", params: [] });
    await good.request({ method: "personal_sign", params: [] });
    expect(seen).toEqual([STORED]);
  });

  test("a failed open is not cached, so the next request retries it", async () => {
    const fake = makeWallet(STORED);
    let attempts = 0;
    const provider = makeProvider(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("declined");
      return fake.wallet;
    });
    await expect(provider.request({ method: "personal_sign", params: [] })).rejects.toThrow(
      "declined",
    );
    expect(await provider.request({ method: "personal_sign", params: [] })).toBe("0xsig");
    expect(attempts).toBe(2);
  });

  test("listeners registered before the open attach on open; later ones attach directly", async () => {
    const fake = makeWallet(STORED);
    const provider = makeProvider(async () => fake.wallet);
    provider.on("accountsChanged", () => {});
    expect(fake.subscriptions).toEqual([]);
    await provider.request({ method: "personal_sign", params: [] });
    expect(fake.subscriptions).toEqual(["accountsChanged"]);
    provider.on("chainChanged", () => {});
    expect(fake.subscriptions).toEqual(["accountsChanged", "chainChanged"]);
  });
});
