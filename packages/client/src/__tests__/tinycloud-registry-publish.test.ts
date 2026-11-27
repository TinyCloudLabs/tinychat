import { describe, expect, mock, test } from "bun:test";

// TC-3547: the host's registry-publish error callback reaches the SDK config on every TinyCloudWeb this package constructs
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
  onRegistryPublishError: () => {},
};

describe("registry publish error callback", () => {
  test("a fresh sign-in instance carries it", () => {
    createTinyCloudWeb({} as any, { registryPublish });
    expect(lastConfig.onRegistryPublishError).toBe(registryPublish.onRegistryPublishError);
    expect(lastConfig.autoBootstrapAccount).toBe(false);
  });

  test("a restored-session instance carries it", async () => {
    await restoreTinyCloudWebSession("0xabc", { registryPublish });
    expect(lastConfig.onRegistryPublishError).toBe(registryPublish.onRegistryPublishError);
  });

  test("without it the config has no such key", async () => {
    createTinyCloudWeb({} as any);
    expect("onRegistryPublishError" in lastConfig).toBe(false);
    await restoreTinyCloudWebSession("0xabc");
    expect("onRegistryPublishError" in lastConfig).toBe(false);
  });
});
