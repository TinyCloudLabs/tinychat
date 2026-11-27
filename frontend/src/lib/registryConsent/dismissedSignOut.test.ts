import { expect, test } from "bun:test";
import { clearAccountSignOutStorage } from "../accountSignOutStorage";
import { createDismissedStore } from "./dismissed";

const OWNER = "did:pkh:eip155:1:0x00000000000000000000000000000000000a11ce";
const ADDRESS = "0x00000000000000000000000000000000000a11ce";

/** A localStorage stand-in with the key listing the sign-out wipe walks. */
function listedStorage() {
  const map = new Map<string, string>();
  return {
    map,
    get length() { return map.size; },
    key: (index: number) => [...map.keys()][index] ?? null,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { map.set(key, value); },
    removeItem: (key: string) => { map.delete(key); },
  };
}

test("the card's flag stays for that account on this device through the sign-out wipe", () => {
  const storage = listedStorage();
  storage.setItem(`tinychat:index:${OWNER}`, "x");
  createDismissedStore(() => storage).write(OWNER);
  clearAccountSignOutStorage(OWNER, ADDRESS, storage);
  expect(storage.map.has(`tinychat:index:${OWNER}`)).toBe(false);
  expect(createDismissedStore(() => storage).read(OWNER)).toBe(true);
});
