import { afterEach, describe, expect, test } from "bun:test";
import { debugEvents, setDebugLogEnabledForTests } from "../debugLog";
import { ensureRegistryRecord, readRegistryUnregistered } from "./adapter";
import { finishSetupBannerVisible } from "./bannerGate";
import { createDismissedStore } from "./dismissed";
import { fakeSdk, memoryDismissedStore } from "./testClient.fixture";

afterEach(() => setDebugLogEnabledForTests(false));

describe("the adapter over the SDK client", () => {
  test("the SDK is called as a method of the client, with no arguments", async () => {
    const sdk = fakeSdk("published");
    expect(await ensureRegistryRecord(sdk.client)).toBe("published");
    expect(sdk.calls).toEqual([[]]);
    for (const outcome of ["already-current", "needs-one", "unavailable"] as const) {
      expect(await ensureRegistryRecord(fakeSdk(outcome).client)).toBe(outcome);
    }
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
  const canOpen = () => true;

  test("visible for an unregistered account that has not tapped the button on this device", async () => {
    const sdk = fakeSdk();
    expect(await finishSetupBannerVisible(sdk.client, unregistered, canOpen, memoryDismissedStore())).toBe(true);
  });

  test("stays hidden across sign-ins once the owner tapped the button, and only for that owner", async () => {
    const sdk = fakeSdk();
    const store = memoryDismissedStore();
    store.write(sdk.client.did);
    expect(await finishSetupBannerVisible(sdk.client, unregistered, canOpen, store)).toBe(false);
    expect(await finishSetupBannerVisible({ ...sdk.client, did: "did:pkh:eip155:1:0xother" }, unregistered, canOpen, store)).toBe(true);
  });

  test("shows again after sign-out clears the flag", async () => {
    const sdk = fakeSdk();
    const store = memoryDismissedStore();
    store.write(sdk.client.did);
    store.clear(sdk.client.did);
    expect(await finishSetupBannerVisible(sdk.client, unregistered, canOpen, store)).toBe(true);
  });

  test("storage that cannot be read shows the card rather than hiding it for good", async () => {
    const sdk = fakeSdk();
    const broken = createDismissedStore(() => ({ getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); }, removeItem: () => {} }));
    expect(await finishSetupBannerVisible(sdk.client, unregistered, canOpen, broken)).toBe(true);
  });

  test("hidden for an account that already has its record", async () => {
    expect(await finishSetupBannerVisible(fakeSdk().client, registered, canOpen, memoryDismissedStore())).toBe(false);
  });

  test("hidden where the app cannot open TinyCloud One (the desktop app), and the registry is not asked", async () => {
    let asked = 0;
    const counting = async () => { asked += 1; return true; };
    expect(await finishSetupBannerVisible(fakeSdk().client, counting, () => false, memoryDismissedStore())).toBe(false);
    expect(await finishSetupBannerVisible(null, counting, canOpen, memoryDismissedStore())).toBe(false);
    expect(asked).toBe(0);
  });
});
