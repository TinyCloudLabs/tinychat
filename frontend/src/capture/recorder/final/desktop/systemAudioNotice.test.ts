import { describe, expect, test } from "bun:test";
import {
  SYSTEM_AUDIO_NOTICE_KEY,
  markSystemAudioNoticeSeen,
  systemAudioNoticeSeen,
} from "./systemAudioNotice";

const memory = () => {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
  };
};

describe("system audio notice storage", () => {
  test("unseen until marked, then seen", () => {
    const storage = memory();
    expect(systemAudioNoticeSeen(storage)).toBe(false);
    markSystemAudioNoticeSeen(storage);
    expect(storage.map.get(SYSTEM_AUDIO_NOTICE_KEY)).toBe("1");
    expect(systemAudioNoticeSeen(storage)).toBe(true);
  });
});
