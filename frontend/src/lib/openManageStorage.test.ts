import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { installDom } from "@/test/dom";
import { openManageStorage } from "./openManageStorage";
import { MANAGE_STORAGE_URL } from "./storageStatus";

type TauriWindow = { __TAURI_INTERNALS__?: unknown };

let restoreDom: (() => void) | undefined;

beforeEach(() => { restoreDom = installDom(); });
afterEach(() => {
  delete (window as TauriWindow).__TAURI_INTERNALS__;
  mock.restore();
  restoreDom?.();
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
});
