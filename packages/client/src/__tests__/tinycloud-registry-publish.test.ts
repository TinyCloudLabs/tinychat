import { describe, expect, mock, test } from "bun:test";

// TC-3547: the host's registry-publish callbacks reach the SDK config on every TinyCloudWeb this package constructs
// for a sign-in or a restore, and nothing is added when the host gives none.
let lastConfig: any = null;

// bun's module registry is shared by every test file of the run: keep this mock a superset of what other
// files import from the SDK, and load tinycloud.ts under a private specifier so no other file reuses this copy.
mock.module("@tinycloud/web-sdk", () => ({
  serializeDelegation: () => "serialized-delegation",
  BrowserSessionStorage: class BrowserSessionStorage {
    async load() {
      return null;
    }
  },
  TinyCloudWeb: class TinyCloudWeb {
    constructor(config: any) {
      lastConfig = config;
    }
    cleanup() {}
    get spaceId() {
      return "space";
    }
    async restoreSession() {
      return { status: "restored", session: { address: "0xabc" } };
    }
  },
}));

const { createTinyCloudWeb, restoreTinyCloudWebSession } = await import("../tinycloud.js?registry-publish");

const registryPublish = {
  onRegistryPublishConsent: async () => true,
  onRegistryPublishError: () => {},
};

describe("registry publish callbacks", () => {
  test("a fresh sign-in instance carries both", () => {
    createTinyCloudWeb({} as any, { registryPublish });
    expect(lastConfig.onRegistryPublishConsent).toBe(registryPublish.onRegistryPublishConsent);
    expect(lastConfig.onRegistryPublishError).toBe(registryPublish.onRegistryPublishError);
    expect(lastConfig.autoBootstrapAccount).toBe(false);
  });

  test("a restored-session instance carries both", async () => {
    await restoreTinyCloudWebSession("0xabc", { registryPublish });
    expect(lastConfig.onRegistryPublishConsent).toBe(registryPublish.onRegistryPublishConsent);
    expect(lastConfig.onRegistryPublishError).toBe(registryPublish.onRegistryPublishError);
  });

  test("without them the config has neither key", async () => {
    createTinyCloudWeb({} as any);
    expect("onRegistryPublishConsent" in lastConfig).toBe(false);
    expect("onRegistryPublishError" in lastConfig).toBe(false);
    await restoreTinyCloudWebSession("0xabc");
    expect("onRegistryPublishConsent" in lastConfig).toBe(false);
  });
});
