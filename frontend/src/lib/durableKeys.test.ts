import { afterEach, describe, expect, test } from "bun:test";
import {
  DURABLE_KEYS_RECONCILED,
  hydrateDurableKeys,
  resetDurableKeysForTest,
  writeDurableKey,
  type DurableStore,
} from "./durableKeys";

const KEY = "xyz.tinycloud.home:app-lock";
const OTHER = "xyz.tinycloud.tinychat:auth-kind";

function preferences(initial: Record<string, string> = {}, failGet = false) {
  const values = new Map(Object.entries(initial));
  const store: DurableStore = {
    get: async (key) => {
      if (failGet) throw new Error("bridge unavailable");
      return values.get(key) ?? null;
    },
    set: async (key, value) => { values.set(key, value); },
    remove: async (key) => { values.delete(key); },
  };
  return { values, store };
}

function webStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

afterEach(() => resetDurableKeysForTest());

describe("hydrateDurableKeys", () => {
  test("a new WebView storage takes what native storage kept", async () => {
    const native = preferences({ [KEY]: "on" });
    const web = webStorage();
    await hydrateDurableKeys([KEY, OTHER], native.store, web);
    expect(web.values.get(KEY)).toBe("on");
    expect(web.values.has(OTHER)).toBe(false);
    expect(web.values.get(DURABLE_KEYS_RECONCILED)).toBe("1");
  });

  test("the first launch with native storage copies localStorage into it", async () => {
    const native = preferences();
    const web = webStorage({ [KEY]: "off", [OTHER]: "native" });
    await hydrateDurableKeys([KEY, OTHER], native.store, web);
    expect(Object.fromEntries(native.values)).toEqual({ [KEY]: "off", [OTHER]: "native" });
  });

  test("once reconciled, localStorage is the record: a removal there is not undone from native storage", async () => {
    const native = preferences({ [KEY]: "on", [OTHER]: "native" });
    const web = webStorage({ [DURABLE_KEYS_RECONCILED]: "1", [KEY]: "off" });
    await hydrateDurableKeys([KEY, OTHER], native.store, web);
    expect(web.values.has(OTHER)).toBe(false);
    expect(Object.fromEntries(native.values)).toEqual({ [KEY]: "off" });
  });

  test("a native storage failure leaves localStorage as it was and reconciles again next launch", async () => {
    const web = webStorage();
    await hydrateDurableKeys([KEY], preferences({ [KEY]: "on" }, true).store, web);
    expect(web.values.size).toBe(0);
    resetDurableKeysForTest();
    await hydrateDurableKeys([KEY], preferences({ [KEY]: "on" }).store, web);
    expect(web.values.get(KEY)).toBe("on");
  });
});

describe("writeDurableKey", () => {
  test("writes and removals of a durable key reach native storage; other keys stay in localStorage only", async () => {
    const native = preferences();
    const web = webStorage();
    await hydrateDurableKeys([KEY], native.store, web);
    writeDurableKey(KEY, "on", web);
    writeDurableKey("unrelated", "x", web);
    expect(native.values.get(KEY)).toBe("on");
    expect(native.values.has("unrelated")).toBe(false);
    writeDurableKey(KEY, null, web);
    expect(web.values.has(KEY)).toBe(false);
    expect(native.values.has(KEY)).toBe(false);
  });

  test("on the web there is no native copy", async () => {
    const web = webStorage();
    await hydrateDurableKeys([KEY], null, web);
    writeDurableKey(KEY, "on", web);
    expect(web.values.get(KEY)).toBe("on");
    expect(web.values.has(DURABLE_KEYS_RECONCILED)).toBe(false);
  });
});
