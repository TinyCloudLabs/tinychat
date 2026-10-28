import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { useLocalThreadStorage } from "../lib/threadStore";
import { accountStorageKey } from "../lib/voiceNotes/sourcePins";
import { FIRST_SCREEN_CACHE_KEY, readCachedFirstScreen, readFirstScreen, writeFirstScreen } from "./firstScreenStore";
import { installFakeLocalStorage } from "./firstScreenTestStorage";

const testHome = mkdtempSync(join("/var/tmp", "TC-2079."));
for (const name of ["HOME", "BUN_INSTALL_CACHE_DIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "TC_PROFILE_DIR"]) process.env[name] = testHome;
afterAll(() => rmSync(testHome, { recursive: true, force: true }));

const KEY_A = accountStorageKey(FIRST_SCREEN_CACHE_KEY, "did:a");
let restore: (() => void) | null = null;
afterEach(() => { restore?.(); restore = null; });

describe("device-local first-screen copy", () => {
  test("a successful write updates the copy, per account", async () => {
    expect(process.env.HOME).toBe(testHome);
    const { values, uninstall } = installFakeLocalStorage();
    restore = uninstall;
    const account = useLocalThreadStorage({} as TinyCloudWeb);
    await writeFirstScreen(account, "apps", "did:a");
    expect(values.get(KEY_A)).toBe("apps");
    expect(readCachedFirstScreen("did:a")).toBe("apps");
    expect(readCachedFirstScreen("did:b")).toBeNull();
  });

  test("a failed write leaves the copy alone", async () => {
    const { values, uninstall } = installFakeLocalStorage();
    restore = uninstall;
    values.set(KEY_A, "feed");
    const failing = {} as TinyCloudWeb;
    await expect(writeFirstScreen(failing, "apps", "did:a")).rejects.toBeDefined();
    expect(values.get(KEY_A)).toBe("feed");
  });

  test("a successful read refreshes the copy, including back to Feed", async () => {
    const { values, uninstall } = installFakeLocalStorage();
    restore = uninstall;
    const account = useLocalThreadStorage({} as TinyCloudWeb);
    await writeFirstScreen(account, "apps");
    expect(values.has(KEY_A)).toBe(false);
    expect(await readFirstScreen(account, "did:a")).toBe("apps");
    expect(values.get(KEY_A)).toBe("apps");
    await writeFirstScreen(account, "feed");
    expect(await readFirstScreen(account, "did:a")).toBe("feed");
    expect(values.get(KEY_A)).toBe("feed");
  });

  test("a corrupt copy is ignored", () => {
    const { values, uninstall } = installFakeLocalStorage();
    restore = uninstall;
    for (const bad of ["", "APPS", "chat", "{\"a\":1}", "null"]) {
      values.set(KEY_A, bad);
      expect(readCachedFirstScreen("did:a")).toBeNull();
    }
  });

  test("storage that throws is no copy and never fails the read or write", async () => {
    const { uninstall } = installFakeLocalStorage({ throwing: true });
    restore = uninstall;
    const account = useLocalThreadStorage({} as TinyCloudWeb);
    expect(readCachedFirstScreen("did:a")).toBeNull();
    await writeFirstScreen(account, "apps", "did:a");
    expect(await readFirstScreen(account, "did:a")).toBe("apps");
  });

  test("no account, no copy", () => {
    const { values, uninstall } = installFakeLocalStorage();
    restore = uninstall;
    values.set(KEY_A, "apps");
    expect(readCachedFirstScreen(null)).toBeNull();
    expect(readCachedFirstScreen(undefined)).toBeNull();
  });
});
