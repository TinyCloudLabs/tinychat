import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Browser } from "@capacitor/browser";
import { Capacitor } from "@capacitor/core";
import { installDom } from "@/test/dom";
import { billingLinksAllowed, openManageStorage } from "./openManageStorage";
import { MANAGE_STORAGE_URL } from "./storageStatus";

type TauriWindow = { __TAURI_INTERNALS__?: unknown };

const saved = { isNativePlatform: Capacitor.isNativePlatform, getPlatform: Capacitor.getPlatform };
let restoreDom: (() => void) | undefined;

beforeEach(() => { restoreDom = installDom(); });
afterEach(() => {
  delete (window as TauriWindow).__TAURI_INTERNALS__;
  Capacitor.isNativePlatform = saved.isNativePlatform;
  Capacitor.getPlatform = saved.getPlatform;
  mock.restore();
  restoreDom?.();
});

describe("billingLinksAllowed", () => {
  test("web and desktop may link to billing; the iOS and Android apps may not", () => {
    expect(billingLinksAllowed("web")).toBe(true);
    expect(billingLinksAllowed("tauri")).toBe(true);
    expect(billingLinksAllowed("ios")).toBe(false);
    expect(billingLinksAllowed("android")).toBe(false);
  });
});

describe("openManageStorage", () => {
  test("on web it opens the storage page in a new tab without giving that page access to the app", async () => {
    const open = spyOn(window, "open").mockImplementation(() => null);
    await openManageStorage();
    expect(open).toHaveBeenCalledWith(MANAGE_STORAGE_URL, "_blank", "noopener,noreferrer");
  });

  test("on desktop it asks the Tauri shell to open the page, not the app's own webview", async () => {
    const commands: string[] = [];
    (window as TauriWindow).__TAURI_INTERNALS__ = {
      invoke: async (command: string) => { commands.push(command); },
    };
    const open = spyOn(window, "open").mockImplementation(() => null);
    await openManageStorage();
    expect(commands).toEqual(["open_manage_storage"]);
    expect(open).not.toHaveBeenCalled();
  });

  for (const platform of ["ios", "android"] as const) {
    test(`on ${platform} it opens no browser and no tab`, async () => {
      Capacitor.isNativePlatform = () => true;
      Capacitor.getPlatform = () => platform;
      const open = spyOn(window, "open").mockImplementation(() => null);
      const browser = spyOn(Browser, "open").mockImplementation(async () => {});
      await openManageStorage();
      expect(open).not.toHaveBeenCalled();
      expect(browser).not.toHaveBeenCalled();
    });
  }
});
