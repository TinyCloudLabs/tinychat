import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  clearWebSignOutPending,
  hasWebSignOutPending,
  setWebSignOutPending,
  webSignOutPendingKeepsUnsentWork,
} from "./sessionSignOutFence";

// An expired session's sign-out (credentials only) racing the owner's own sign-out (everything): whichever comes
// second, a restart that finds the fence finishes the owner's sign-out and clears everything.

const ADDRESS = "0xAbC0000000000000000000000000000000000001";
const store = new Map<string, string>();
const storage = {
  get length() { return store.size; },
  key: (index: number) => [...store.keys()][index] ?? null,
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => { store.set(key, value); },
  removeItem: (key: string) => { store.delete(key); },
  clear: () => store.clear(),
} as Storage;
const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
beforeEach(() => {
  store.clear();
  Object.defineProperty(globalThis, "window", { configurable: true, writable: true, value: { localStorage: storage } });
});
afterEach(() => {
  if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow); else delete (globalThis as Record<string, unknown>).window;
});

describe("the owner's sign-out fence wins over an expired session's", () => {
  test("an expired session's fence never replaces the owner's", () => {
    const owners = setWebSignOutPending(ADDRESS);
    expect(owners).toBeString();
    expect(setWebSignOutPending(ADDRESS, true)).toBeNull();
    expect(webSignOutPendingKeepsUnsentWork()).toBe(false);
    // Only the owner's sign-out clears its fence.
    expect(clearWebSignOutPending(ADDRESS, owners!)).toBe(true);
    expect(hasWebSignOutPending()).toBe(false);
  });

  test("the owner's fence replaces an expired session's", () => {
    const expired = setWebSignOutPending(ADDRESS, true);
    expect(webSignOutPendingKeepsUnsentWork()).toBe(true);
    const owners = setWebSignOutPending(ADDRESS);
    expect(owners).not.toBe(expired);
    expect(webSignOutPendingKeepsUnsentWork()).toBe(false);
    // The expired session's late cleanup leaves the owner's fence.
    expect(clearWebSignOutPending(ADDRESS, expired!)).toBe(true);
    expect(hasWebSignOutPending()).toBe(true);
    expect(webSignOutPendingKeepsUnsentWork()).toBe(false);
  });

  test("a second expired session's fence replaces the first and keeps the work", () => {
    const first = setWebSignOutPending(ADDRESS, true);
    const second = setWebSignOutPending(ADDRESS, true);
    expect(second).toBeString();
    expect(second).not.toBe(first);
    expect(webSignOutPendingKeepsUnsentWork()).toBe(true);
  });
});
