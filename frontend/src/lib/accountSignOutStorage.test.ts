import { describe, expect, test } from "bun:test";
import { clearAccountSignOutStorage } from "./accountSignOutStorage";

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    get length() { return values.size; },
    key(index: number) { return [...values.keys()][index] ?? null; },
    getItem(key: string) { return values.get(key) ?? null; },
    setItem(key: string, value: string) { values.set(key, value); },
    removeItem(key: string) { values.delete(key); },
    values,
  };
}

describe("clearAccountSignOutStorage", () => {
  test("removes only the signed-out account's index, manifest and Exo keys", () => {
    const address = "0xd9Fbf2af3d21311c179775f26B3557B4FDD787d4";
    const did = `did:pkh:eip155:1:${address}`;
    const otherDid = "did:pkh:eip155:1:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const storage = memoryStorage({
      [`tinychat:index:${did}`]: "account index",
      [`xyz.tinycloud.tinychat:manifest-revision:${address.toLowerCase()}`]: "revision",
      [`exo-audio-receipt-pass:${did}:applications`]: "receipt",
      [`exo.voiceNotes.partialAudio.${encodeURIComponent(did)}.applications`]: "partial audio metadata",
      [`tinychat:index:${otherDid}`]: "other index",
      [`exo.voiceNotes.partialAudio.${encodeURIComponent(otherDid)}.applications`]: "other account metadata",
      "exo.capture.transitionGen": "7",
      "exo.voiceNotes.partialAudio.signed-out.local": "local recording",
    });

    clearAccountSignOutStorage(did, address, storage);

    expect(storage.values.has(`tinychat:index:${did}`)).toBe(false);
    expect(storage.values.has(`xyz.tinycloud.tinychat:manifest-revision:${address.toLowerCase()}`)).toBe(false);
    expect(storage.values.has(`exo-audio-receipt-pass:${did}:applications`)).toBe(false);
    expect(storage.values.has(`exo.voiceNotes.partialAudio.${encodeURIComponent(did)}.applications`)).toBe(false);
    expect(storage.values.has(`tinychat:index:${otherDid}`)).toBe(true);
    expect(storage.values.has(`exo.voiceNotes.partialAudio.${encodeURIComponent(otherDid)}.applications`)).toBe(true);
    expect(storage.values.get("exo.capture.transitionGen")).toBe("7");
    expect(storage.values.get("exo.voiceNotes.partialAudio.signed-out.local")).toBe("local recording");
  });
});
