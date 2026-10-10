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
  test("storage that throws never breaks Settings: an unreadable flag shows the notice, a failed write is only logged", () => {
    const throwing = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    };
    const warn = console.warn;
    const warnings: unknown[][] = [];
    console.warn = (...args: unknown[]) => void warnings.push(args);
    try {
      expect(systemAudioNoticeSeen(throwing)).toBe(false);
      expect(() => markSystemAudioNoticeSeen(throwing)).not.toThrow();
    } finally {
      console.warn = warn;
    }
    expect(warnings).toHaveLength(2);
  });
});
