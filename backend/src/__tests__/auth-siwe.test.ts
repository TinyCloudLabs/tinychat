import { describe, expect, it } from "bun:test";
import { SiweMessage } from "@tinycloud/sdk-core";
import { verifySIWE, verifySiweSession } from "@tinyboilerplate/server";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

describe("SIWE login without an expiration time", () => {
  it("accepts a valid signed login while leaving delegation expiry absent", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const nonce = "nonce12345678";
    const message = new SiweMessage({
      domain: "localhost",
      address: account.address,
      statement: "Sign in to TinyChat",
      uri: "https://localhost/",
      version: "1",
      chainId: 1,
      nonce,
      issuedAt: new Date().toISOString(),
    }).prepareMessage();
    const signature = await account.signMessage({ message });

    expect(await verifySIWE(message, signature)).toEqual({ address: account.address, nonce, domain: "localhost", uri: "https://localhost/", chainId: 1 });
    expect((await verifySiweSession(message, signature)).expirationTime).toBeUndefined();
  });
});
