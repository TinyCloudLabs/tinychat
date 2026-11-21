import { afterEach, describe, expect, test } from "bun:test";
import { debugEvents, setDebugLogEnabledForTests } from "../debugLog";
import { canPublishRegistryRecord, ensureRegistryRecord, readRegistryUnregistered } from "./adapter";
import { finishSetupBannerVisible } from "./bannerGate";
import { createDismissedStore } from "./dismissed";
import { fakeSdk, memoryDismissedStore } from "./testClient.fixture";

afterEach(() => setDebugLogEnabledForTests(false));

describe("the adapter over the SDK client", () => {
  test("an SDK without the method: unsupported, and nothing is called", async () => {
    const withoutMethod = { did: "did:pkh:eip155:1:0xabc" };
    expect(canPublishRegistryRecord(withoutMethod)).toBe(false);
    expect(await ensureRegistryRecord(withoutMethod, { ignoreDismissed: true })).toBe("unsupported");
    expect(await ensureRegistryRecord(null)).toBe("unsupported");
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

describe("the registry verdict read", () => {
  test("only a genuine unregistered answer counts", async () => {
    const sdk = fakeSdk();
    const answers = (verdict: { status: string; offline?: true }) => async () => verdict;
    expect(await readRegistryUnregistered(sdk.client, answers({ status: "unregistered" }))).toBe(true);
    expect(await readRegistryUnregistered(sdk.client, answers({ status: "unregistered", offline: true }))).toBe(false);
    expect(await readRegistryUnregistered(sdk.client, answers({ status: "registered" }))).toBe(false);
    expect(await readRegistryUnregistered(sdk.client, answers({ status: "unavailable" }))).toBe(false);
    expect(await readRegistryUnregistered(sdk.client, async () => { throw new Error("registry down"); })).toBe(false);
    expect(await readRegistryUnregistered({}, answers({ status: "unregistered" }))).toBe(false);
  });

  test("asks about the signed-in owner's DID", async () => {
    const sdk = fakeSdk();
    const asked: string[] = [];
    await readRegistryUnregistered(sdk.client, async (subject) => { asked.push(subject); return { status: "unregistered" }; });
    expect(asked).toEqual([sdk.client.did]);
  });
});

describe("the finish-setup banner gate", () => {
  const unregistered = async () => true;
  const registered = async () => false;

  test("visible for an unregistered account that has not said Not now", async () => {
    const sdk = fakeSdk();
    expect(await finishSetupBannerVisible(sdk.client, true, unregistered, memoryDismissedStore())).toBe(true);
  });

  test("stays hidden across sign-ins once the owner said Not now, and only for that owner", async () => {
    const sdk = fakeSdk();
    const store = memoryDismissedStore();
    store.write(sdk.client.did);
    expect(await finishSetupBannerVisible(sdk.client, true, unregistered, store)).toBe(false);
    expect(await finishSetupBannerVisible({ ...sdk.client, did: "did:pkh:eip155:1:0xother" }, true, unregistered, store)).toBe(true);
  });

  test("a flag the SDK wrote in its own KV does not hide it: the host does not read the KV", async () => {
    const sdk = fakeSdk();
    sdk.kv.set("system/registry-publish/dismissed/v1", { dismissed: true });
    expect(await finishSetupBannerVisible(sdk.client, true, unregistered, memoryDismissedStore())).toBe(true);
  });

  test("storage that cannot be read asks (shows) rather than hiding for good", async () => {
    const sdk = fakeSdk();
    const broken = createDismissedStore(() => ({ getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } }));
    expect(await finishSetupBannerVisible(sdk.client, true, unregistered, broken)).toBe(true);
  });

  test("hidden for an account that already has its record", async () => {
    const sdk = fakeSdk();
    expect(await finishSetupBannerVisible(sdk.client, true, registered, memoryDismissedStore())).toBe(false);
  });

  test("never shows while the consent is off or the SDK cannot publish, and asks nothing then", async () => {
    const sdk = fakeSdk();
    let asked = 0;
    const counting = async () => { asked += 1; return true; };
    const store = memoryDismissedStore();
    expect(await finishSetupBannerVisible(sdk.client, false, counting, store)).toBe(false);
    expect(await finishSetupBannerVisible({ did: "did:pkh:eip155:1:0xabc" }, true, counting, store)).toBe(false);
    expect(await finishSetupBannerVisible(sdk.client, undefined, counting, store)).toBe(false);
    expect(asked).toBe(0);
  });
});
