import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PREVIEW, fakeSdk, memoryDismissedStore, memoryStorage } from "./testClient.fixture";
import { createDismissedStore } from "./dismissed";
import {
  answerRegistryConsent,
  cancelPendingRegistryConsent,
  declineRegistryConsent,
  dismissRegistryConsent,
  pendingRegistryConsent,
  registerRegistryConsentHost,
  requestRegistryConsent,
  startSignOutClosingRegistryConsent,
  subscribeRegistryConsent,
} from "./broker";

let unregisterHost: () => void;
beforeEach(() => { unregisterHost = registerRegistryConsentHost(); });
afterEach(() => { cancelPendingRegistryConsent(); unregisterHost(); });

describe("the consent callback", () => {
  test("Publish and continue answers true and clears the question", async () => {
    const asked = requestRegistryConsent(PREVIEW);
    expect(pendingRegistryConsent()).toEqual(PREVIEW);
    answerRegistryConsent(true);
    expect(await asked).toBe(true);
    expect(pendingRegistryConsent()).toBeNull();
  });

  test("Not now answers false", async () => {
    const asked = requestRegistryConsent(PREVIEW);
    answerRegistryConsent(false);
    expect(await asked).toBe(false);
  });

  test("only the first answer counts", async () => {
    const asked = requestRegistryConsent(PREVIEW);
    answerRegistryConsent(true);
    answerRegistryConsent(false);
    expect(await asked).toBe(true);
  });

  test("a second question while one is open joins it", async () => {
    const first = requestRegistryConsent(PREVIEW);
    const second = requestRegistryConsent(PREVIEW);
    answerRegistryConsent(true);
    expect([await first, await second]).toEqual([true, true]);
  });

  test("no dialog mounted: it throws, so the SDK stores no Not now", async () => {
    unregisterHost();
    await expect(requestRegistryConsent(PREVIEW)).rejects.toThrow();
    expect(pendingRegistryConsent()).toBeNull();
    unregisterHost = registerRegistryConsentHost();
  });

  test("a preview with a missing field throws instead of asking about less than will be published", async () => {
    await expect(requestRegistryConsent({ ...PREVIEW, nodeOrigin: "" })).rejects.toThrow();
    expect(pendingRegistryConsent()).toBeNull();
  });

  test("through the SDK: Publish publishes, Not now declines, a throw declines", async () => {
    const accepted = fakeSdk(requestRegistryConsent);
    const accepting = accepted.client.ensureOwnerRegistryRecord({});
    answerRegistryConsent(true);
    expect(await accepting).toBe("published");

    const refused = fakeSdk(requestRegistryConsent);
    const refusing = refused.client.ensureOwnerRegistryRecord({});
    declineRegistryConsent(memoryDismissedStore());
    expect(await refusing).toBe("declined");

    unregisterHost();
    const thrown = fakeSdk(requestRegistryConsent);
    expect(await thrown.client.ensureOwnerRegistryRecord({})).toBe("declined");
    unregisterHost = registerRegistryConsentHost();
  });
});

describe("Not now", () => {
  test("answers false and writes the flag for that owner only", async () => {
    const storage = memoryStorage();
    const store = createDismissedStore(() => storage);
    const asked = requestRegistryConsent(PREVIEW);
    declineRegistryConsent(store);
    expect(await asked).toBe(false);
    expect(pendingRegistryConsent()).toBeNull();
    expect(store.read(PREVIEW.subject)).toBe(true);
    expect(store.read("did:pkh:eip155:1:0xsomeoneelse")).toBe(false);
    // A later page load reads the same storage.
    expect(createDismissedStore(() => storage).read(PREVIEW.subject)).toBe(true);
  });

  test("with nothing pending it writes nothing", () => {
    const storage = memoryStorage();
    declineRegistryConsent(createDismissedStore(() => storage));
    expect(storage.map.size).toBe(0);
  });

  test("a sign-out that closes the dialog answers false but is not a Not now", async () => {
    const storage = memoryStorage();
    const store = createDismissedStore(() => storage);
    const asked = requestRegistryConsent(PREVIEW);
    cancelPendingRegistryConsent();
    expect(await asked).toBe(false);
    expect(store.read(PREVIEW.subject)).toBe(false);
  });
});

describe("dismissing the dialog without an answer (Escape, a tap outside)", () => {
  test("throws and clears the question, so the SDK reads it as declined", async () => {
    const asked = requestRegistryConsent(PREVIEW);
    dismissRegistryConsent();
    await expect(asked).rejects.toThrow();
    expect(pendingRegistryConsent()).toBeNull();
  });

  test("through the SDK: declined and no Not now is stored", async () => {
    const sdk = fakeSdk(requestRegistryConsent);
    const flow = sdk.client.ensureOwnerRegistryRecord({});
    dismissRegistryConsent();
    expect(await flow).toBe("declined");
    expect(sdk.kv.size).toBe(0);
  });

  test("writes no Not now of the host's own either", async () => {
    const storage = memoryStorage();
    const store = createDismissedStore(() => storage);
    const asked = requestRegistryConsent(PREVIEW);
    dismissRegistryConsent();
    await expect(asked).rejects.toThrow();
    expect(store.read(PREVIEW.subject)).toBe(false);
    expect(storage.map.size).toBe(0);
  });

  test("after a button answer it does nothing", async () => {
    const asked = requestRegistryConsent(PREVIEW);
    answerRegistryConsent(false);
    dismissRegistryConsent();
    expect(await asked).toBe(false);
  });
});

describe("sign-out", () => {
  test("resolves the pending consent with false (no throw) and dismisses the dialog", async () => {
    const asked = requestRegistryConsent(PREVIEW);
    let notified = 0;
    const unsubscribe = subscribeRegistryConsent(() => { notified += 1; });
    startSignOutClosingRegistryConsent(() => undefined);
    unsubscribe();
    expect(await asked).toBe(false);
    expect(pendingRegistryConsent()).toBeNull();
    expect(notified).toBe(1);
  });

  test("the next account never sees the previous account's question", async () => {
    const asked = requestRegistryConsent(PREVIEW);
    startSignOutClosingRegistryConsent(() => undefined);
    await asked;
    expect(pendingRegistryConsent()).toBeNull();
    const next = requestRegistryConsent({ ...PREVIEW, subject: "did:pkh:eip155:1:0x00000000000000000000000000000000000beef2" });
    expect(pendingRegistryConsent()?.subject.endsWith("beef2")).toBe(true);
    answerRegistryConsent(true);
    expect(await next).toBe(true);
  });

  test("the SDK's sign-out starts before the question closes, so no Not now is stored for the signed-out account", async () => {
    const sdk = fakeSdk(requestRegistryConsent);
    const flow = sdk.client.ensureOwnerRegistryRecord({});
    startSignOutClosingRegistryConsent(() => sdk.client.signOut());
    expect(await flow).toBe("unavailable");
    expect(sdk.kv.size).toBe(0);
    expect(sdk.log).toEqual(["ensure", "sign-out"]);
  });

  test("a sign-out that throws still closes the question", async () => {
    const asked = requestRegistryConsent(PREVIEW);
    expect(() => startSignOutClosingRegistryConsent(() => { throw new Error("boom"); })).toThrow("boom");
    expect(await asked).toBe(false);
  });
});
