import { beforeEach, describe, expect, mock, test } from "bun:test";

let capturedConfig: unknown;

mock.module("@openkey/sdk", () => ({
  default: class MockOpenKey {
    constructor(config: unknown) {
      capturedConfig = config;
    }

    async connect() {
      return {
        address: "0xabc",
        keyId: "key-1",
      };
    }

    async signMessage() {
      return {
        signature: "0xsig",
      };
    }
  },
}));

const { connectWallet } = await import("../openkey.js");

describe("connectWallet", () => {
  beforeEach(() => {
    capturedConfig = undefined;
  });

  test("uses an explicit app name for OpenKey consent", async () => {
    await connectWallet({
      host: "https://openkey.example",
      appName: "Quote Pilot",
    });

    expect(capturedConfig).toMatchObject({
      host: "https://openkey.example",
      appName: "Quote Pilot",
    });
  });

  test("falls back to a neutral OpenKey consent app name", async () => {
    await connectWallet();

    expect(capturedConfig).toMatchObject({
      appName: "TinyCloud App",
    });
  });
});
