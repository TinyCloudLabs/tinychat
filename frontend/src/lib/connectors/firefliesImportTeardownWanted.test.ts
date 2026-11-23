import { afterEach, beforeEach, expect, test } from "bun:test";
import type { SessionStore } from "@tinyboilerplate/client";
import { readFirefliesImportWanted, writeFirefliesImportWanted } from "./firefliesImport";
import { createFirefliesImportGrantsTeardown } from "./firefliesImportGrantsApi";

// Every teardown (disconnect, instant updates off, account deletion) lists the permissions first. That is the
// owner saying they no longer want the import, so this browser stops replacing a lapsed pair on its own.

const OWNER = "0xAbC0000000000000000000000000000000000002";
const sessionStore = { getToken: () => "t0ken", isExpired: () => false, getAddress: () => OWNER } as unknown as SessionStore;

const rows = new Map<string, string>();
const memoryStorage = {
  getItem: (key: string) => rows.get(key) ?? null,
  setItem: (key: string, value: string) => void rows.set(key, value),
  removeItem: (key: string) => void rows.delete(key),
} as unknown as Storage;

const realFetch = globalThis.fetch;
const realStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");

beforeEach(() => {
  rows.clear();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: memoryStorage });
  globalThis.fetch = (async () => Response.json({ grantCids: ["a", "b"] })) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  if (realStorage) Object.defineProperty(globalThis, "localStorage", realStorage);
  else Reflect.deleteProperty(globalThis, "localStorage");
});

test("listing the permissions for a teardown clears this browser's wish to keep the import on", async () => {
  writeFirefliesImportWanted(OWNER, true);
  expect(readFirefliesImportWanted(OWNER)).toBe(true);

  const teardown = createFirefliesImportGrantsTeardown({ revokeDelegation: async () => ({ ok: true }) } as never, "https://api.example", sessionStore);
  expect(await teardown.listGrantCids()).toEqual({ status: "ok", value: ["a", "b"] });

  expect(readFirefliesImportWanted(OWNER)).toBe(false);
});
