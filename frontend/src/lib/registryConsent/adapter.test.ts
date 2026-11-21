import { afterEach, describe, expect, test } from "bun:test";
import { debugEvents, setDebugLogEnabledForTests } from "../debugLog";
import { REGISTRY_PUBLISH_DISMISSED_KEY, canPublishRegistryRecord, ensureRegistryRecord, readRegistryPublishDismissed } from "./adapter";
import { finishSetupBannerVisible } from "./bannerGate";
import { fakeSdk } from "./testClient.fixture";

afterEach(() => setDebugLogEnabledForTests(false));

describe("the adapter over the SDK client", () => {
  test("an SDK without the method: unsupported, and nothing is called", async () => {
    let touched = 0;
    const withoutMethod = { accountSpaceId: "x", kvForSpace: () => { touched += 1; throw new Error("not read"); } };
    expect(canPublishRegistryRecord(withoutMethod)).toBe(false);
    expect(await ensureRegistryRecord(withoutMethod, { ignoreDismissed: true })).toBe("unsupported");
    expect(await ensureRegistryRecord(null)).toBe("unsupported");
    expect(touched).toBe(0);
  });

  test("a non-function member is not the method", () => {
    expect(canPublishRegistryRecord({ ensureOwnerRegistryRecord: "yes" } as never)).toBe(false);
  });

  test("the SDK is called as a method of the client, with the options", async () => {
    const sdk = fakeSdk(async () => true);
    expect(await ensureRegistryRecord(sdk.client, { ignoreDismissed: true })).toBe("published");
    expect(sdk.calls).toEqual([{ options: { ignoreDismissed: true } }]);
  });

  test("a throw is logged and reported as unavailable", async () => {
    setDebugLogEnabledForTests(true);
    const before = debugEvents().length;
    const broken = { ensureOwnerRegistryRecord: async () => { throw new Error("registry down"); } };
    expect(await ensureRegistryRecord(broken)).toBe("unavailable");
    const added = debugEvents().slice(before);
    expect(added.some((event) => event.kind === "session" && event.operation === "registry_publish" && event.phase === "error")).toBe(true);
  });
});

describe("the dismissed flag read", () => {
  test("reads the flag the SDK stores", async () => {
    const sdk = fakeSdk();
    expect(await readRegistryPublishDismissed(sdk.client)).toBe(false);
    sdk.kv.set(REGISTRY_PUBLISH_DISMISSED_KEY, { dismissed: true, at: "2026-11-21T00:00:00.000Z" });
    expect(await readRegistryPublishDismissed(sdk.client)).toBe(true);
  });

  test("an unreadable flag proves nothing: not dismissed", async () => {
    const failing = { accountSpaceId: "x", kvForSpace: () => ({ get: async () => { throw new Error("offline"); } }) };
    const refused = { accountSpaceId: "x", kvForSpace: () => ({ get: async () => ({ ok: false }) }) };
    const noSpace = { kvForSpace: () => ({ get: async () => ({ ok: true, data: { data: { dismissed: true } } }) }) };
    expect(await readRegistryPublishDismissed(failing)).toBe(false);
    expect(await readRegistryPublishDismissed(refused)).toBe(false);
    expect(await readRegistryPublishDismissed(noSpace)).toBe(false);
  });
});

describe("the finish-setup banner", () => {
  test("stays hidden across sign-ins once the owner said Not now", async () => {
    const sdk = fakeSdk();
    expect(await finishSetupBannerVisible(sdk.client, true)).toBe(true);
    sdk.kv.set(REGISTRY_PUBLISH_DISMISSED_KEY, { dismissed: true });
    expect(await finishSetupBannerVisible(sdk.client, true)).toBe(false);
  });

  test("never shows while the consent is off or the SDK cannot publish", async () => {
    const sdk = fakeSdk();
    expect(await finishSetupBannerVisible(sdk.client, false)).toBe(false);
    expect(await finishSetupBannerVisible({ accountSpaceId: "x" }, true)).toBe(false);
  });
});
