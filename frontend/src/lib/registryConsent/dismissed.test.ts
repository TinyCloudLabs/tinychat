import { describe, expect, test } from "bun:test";
import { createDismissedStore } from "./dismissed";
import { memoryStorage } from "./testClient.fixture";

const ALICE = "did:pkh:eip155:1:0x00000000000000000000000000000000000a11ce";
const BOB = "did:pkh:eip155:1:0x0000000000000000000000000000000000000b0b";

describe("the Not now flag on this device", () => {
  test("is per owner and survives a new page load", () => {
    const storage = memoryStorage();
    createDismissedStore(() => storage).write(ALICE);
    const later = createDismissedStore(() => storage);
    expect(later.read(ALICE)).toBe(true);
    expect(later.read(BOB)).toBe(false);
  });

  test("a value that is not the flag is not a Not now", () => {
    for (const raw of ["", "garbage", "null", "{}", '{"dismissed":false}', '{"dismissed":"yes"}']) {
      const storage = memoryStorage();
      const store = createDismissedStore(() => storage);
      storage.map.set(`tinychat.registryPublishDismissed:${ALICE}`, raw);
      expect(store.read(ALICE)).toBe(false);
    }
  });

  test("storage that cannot be read asks, instead of hiding the question for good", () => {
    const denied = () => ({ getItem: () => { throw new Error("denied"); }, setItem: () => {} });
    expect(createDismissedStore(denied).read(ALICE)).toBe(false);
    expect(createDismissedStore(() => undefined).read(ALICE)).toBe(false);
  });

  test("storage that cannot be written still holds for this page load, so it never loops, and asks again next load", () => {
    const refusing = { getItem: () => null, setItem: () => { throw new Error("quota"); } };
    const store = createDismissedStore(() => refusing);
    store.write(ALICE);
    expect(store.read(ALICE)).toBe(true);
    expect(store.read(BOB)).toBe(false);
    expect(createDismissedStore(() => refusing).read(ALICE)).toBe(false);
  });
});
