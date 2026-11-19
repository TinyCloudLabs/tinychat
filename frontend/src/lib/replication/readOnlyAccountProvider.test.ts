import { describe, expect, test } from "bun:test";
import { readOnlyAccountProvider, UNSUPPORTED_METHOD_CODE } from "./readOnlyAccountProvider";

const STORED = "0x00000000000000000000000000000000000000a1";

describe("readOnlyAccountProvider", () => {
  test("answers the chain and the account query, and only those", async () => {
    const provider = readOnlyAccountProvider(STORED);
    expect(await provider.request({ method: "eth_chainId" })).toBe("0x1");
    expect(await provider.request({ method: "eth_accounts" })).toEqual([STORED]);
  });

  const refused = [
    "eth_requestAccounts", // would prompt for a connection
    "personal_sign",
    "eth_sign",
    "eth_signTypedData",
    "eth_signTypedData_v4",
    "eth_sendTransaction",
    "eth_sendRawTransaction",
    "eth_getBalance",
    "wallet_switchEthereumChain",
    "wallet_requestPermissions",
    "wallet_addEthereumChain",
    "",
  ];
  for (const method of refused) {
    test(`${method || "(empty method)"} is refused with code ${UNSUPPORTED_METHOD_CODE}`, async () => {
      const provider = readOnlyAccountProvider(STORED);
      await expect(provider.request({ method, params: ["0x68656c6c6f", STORED] })).rejects.toMatchObject({ code: 4200 });
    });
  }

  test("subscriptions are accepted and do nothing", () => {
    const provider = readOnlyAccountProvider(STORED);
    expect(provider.on("accountsChanged", () => undefined)).toBeUndefined();
    expect(provider.removeListener("accountsChanged", () => undefined)).toBeUndefined();
  });

  test("each provider answers its own stored address", async () => {
    const other = "0x00000000000000000000000000000000000000b2";
    expect(await readOnlyAccountProvider(other).request({ method: "eth_accounts" })).toEqual([other]);
    expect(await readOnlyAccountProvider(STORED).request({ method: "eth_accounts" })).toEqual([STORED]);
  });
});
