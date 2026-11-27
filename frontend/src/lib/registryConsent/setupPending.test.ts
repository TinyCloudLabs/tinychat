import { describe, expect, test } from "bun:test";
import { createSetupPendingStore } from "./setupPending";
import { fakeSdk, memoryDismissedStore } from "./testClient.fixture";

describe("the notice's ask for an owner", () => {
  test("is raised once per owner in a page load and spent by an answer", () => {
    const sdk = fakeSdk();
    const store = createSetupPendingStore(memoryDismissedStore(), () => true);
    store.request(sdk.client);
    expect(store.current()).toBe(sdk.client);
    store.clear();
    expect(store.current()).toBeNull();
    store.request(sdk.client);
    expect(store.current()).toBeNull();
  });

  test("is not raised in an app that cannot open TinyCloud One, where the Home card is hidden too", () => {
    const store = createSetupPendingStore(memoryDismissedStore(), () => false);
    store.request(fakeSdk().client);
    expect(store.current()).toBeNull();
  });

  test("is not raised for an owner whose record was published from this device", () => {
    const sdk = fakeSdk();
    const dismissed = memoryDismissedStore();
    dismissed.write(sdk.client.did);
    const store = createSetupPendingStore(dismissed, () => true);
    store.request(sdk.client);
    expect(store.current()).toBeNull();
  });

  test("is not raised for a client with no owner id", () => {
    const store = createSetupPendingStore(memoryDismissedStore(), () => true);
    store.request({ async ensureOwnerRegistryRecord() { return "published"; } });
    expect(store.current()).toBeNull();
  });

  test("tells a listener when it opens and when it closes", () => {
    const sdk = fakeSdk();
    const store = createSetupPendingStore(memoryDismissedStore(), () => true);
    let calls = 0;
    const stop = store.subscribe(() => { calls += 1; });
    store.request(sdk.client);
    store.clear();
    store.clear();
    stop();
    store.request(fakeSdk().client);
    expect(calls).toBe(2);
  });
});
