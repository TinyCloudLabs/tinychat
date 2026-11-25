import { describe, expect, test } from "bun:test";
import { createDismissedStore } from "./dismissed";
import { memoryStorage } from "./testClient.fixture";

const ALICE = "did:pkh:eip155:1:0x00000000000000000000000000000000000a11ce";
const BOB = "did:pkh:eip155:1:0x0000000000000000000000000000000000000b0b";

describe("the finish-setup card's flag on this device", () => {
  test("is per owner and survives a new page load", () => {
    const storage = memoryStorage();
    createDismissedStore(() => storage).write(ALICE);
    const later = createDismissedStore(() => storage);
    expect(later.read(ALICE)).toBe(true);
    expect(later.read(BOB)).toBe(false);
  });

  test("a value that is not the flag is not a flag", () => {
    for (const raw of ["", "garbage", "null", "{}", '{"dismissed":false}', '{"dismissed":"yes"}']) {
      const storage = memoryStorage();
      const store = createDismissedStore(() => storage);
      storage.map.set(`tcw.tc3547.dismissed.${ALICE.toLowerCase()}`, raw);
      expect(store.read(ALICE)).toBe(false);
    }
  });

  test("storage that cannot be read shows the card, instead of hiding it for good", () => {
    const denied = () => ({ getItem: () => { throw new Error("denied"); }, setItem: () => {} });
    expect(createDismissedStore(denied).read(ALICE)).toBe(false);
    expect(createDismissedStore(() => undefined).read(ALICE)).toBe(false);
  });

  test("storage that cannot be written still holds for this page load, and shows the card again next load", () => {
    const refusing = { getItem: () => null, setItem: () => { throw new Error("quota"); } };
    const store = createDismissedStore(() => refusing);
    store.write(ALICE);
    expect(store.read(ALICE)).toBe(true);
    expect(store.read(BOB)).toBe(false);
    expect(createDismissedStore(() => refusing).read(ALICE)).toBe(false);
  });

  test("is stored under the lowercased did:pkh with the time, so case variants of one owner are one owner", () => {
    const storage = memoryStorage();
    const store = createDismissedStore(() => storage);
    const mixed = "did:pkh:eip155:1:0xAbCd000000000000000000000000000000000001";
    store.write(mixed);
    expect([...storage.map.keys()]).toEqual(["tcw.tc3547.dismissed.did:pkh:eip155:1:0xabcd000000000000000000000000000000000001"]);
    const written = JSON.parse([...storage.map.values()][0]!) as { dismissed: boolean; at: string };
    expect(written.dismissed).toBe(true);
    expect(Number.isNaN(Date.parse(written.at))).toBe(false);
    expect(createDismissedStore(() => storage).read(mixed.toLowerCase())).toBe(true);
  });
});
