import { describe, expect, test } from "bun:test";
import { createNudgedStore } from "./nudged";
import { memoryStorage } from "./testClient.fixture";

const ALICE = "did:pkh:eip155:1:0x00000000000000000000000000000000000A11CE";
const BOB = "did:pkh:eip155:1:0x0000000000000000000000000000000000000b0b";

describe("the registry prompt's once-per-owner flag on this device", () => {
  test("is kept under the lowercased did, per owner, and survives a new page load", () => {
    const storage = memoryStorage();
    createNudgedStore(() => storage).write(ALICE);
    expect([...storage.map.keys()]).toEqual([`tinychat.registryNudged.v1.${ALICE.toLowerCase()}`]);
    const later = createNudgedStore(() => storage);
    expect(later.read(ALICE)).toBe(true);
    expect(later.read(ALICE.toLowerCase())).toBe(true);
    expect(later.read(BOB)).toBe(false);
  });

  test("storage that cannot be read asks again, instead of never asking", () => {
    const denied = () => ({ getItem: () => { throw new Error("denied"); }, setItem: () => {} });
    expect(createNudgedStore(denied).read(ALICE)).toBe(false);
    expect(createNudgedStore(() => undefined).read(ALICE)).toBe(false);
  });

  test("storage that cannot be written still holds for this page load, and asks again next load", () => {
    const refusing = { getItem: () => null, setItem: () => { throw new Error("quota"); } };
    const store = createNudgedStore(() => refusing);
    store.write(ALICE);
    expect(store.read(ALICE)).toBe(true);
    expect(store.read(BOB)).toBe(false);
    expect(createNudgedStore(() => refusing).read(ALICE)).toBe(false);
  });
});
