import { describe, expect, mock, test } from "bun:test";

// Every TinyCloudWeb this package constructs must hide the SDK's floating button (TC-2130):
// the app owns whether it shows, through its own Settings toggle.
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

const { createTinyCloudWeb, restoreTinyCloudWebSession } = await import("../tinycloud.js?ui-button");

describe("TinyCloud button is hidden by default", () => {
  test("fresh sign-in instance", () => {
    lastConfig = null;
    createTinyCloudWeb({} as any);
    expect(lastConfig.ui).toEqual({ button: false, platform: "web" });
  });

  test("restored-session instance", async () => {
    lastConfig = null;
    await restoreTinyCloudWebSession("0xabc");
    expect(lastConfig.ui).toEqual({ button: false, platform: "web" });
  });

  test("the native apps ask for the native panel layout, button still hidden", async () => {
    createTinyCloudWeb({} as any, { uiPlatform: "native" });
    expect(lastConfig.ui).toEqual({ button: false, platform: "native" });
    await restoreTinyCloudWebSession("0xabc", { uiPlatform: "native" });
    expect(lastConfig.ui).toEqual({ button: false, platform: "native" });
  });
});
