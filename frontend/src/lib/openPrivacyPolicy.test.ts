import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { installDom } from "@/test/dom";
import { openPrivacyPolicy, PRIVACY_POLICY_URL } from "./openPrivacyPolicy";

type TauriWindow = { __TAURI_INTERNALS__?: unknown };

let restoreDom: (() => void) | undefined;

beforeEach(() => { restoreDom = installDom(); });
afterEach(() => {
  delete (window as TauriWindow).__TAURI_INTERNALS__;
  mock.restore();
  restoreDom?.();
});

describe("openPrivacyPolicy", () => {
  test("names TinyCloud's published privacy policy", () => {
    expect(PRIVACY_POLICY_URL).toBe("https://tinycloud.xyz/privacy");
  });

  test("on web it opens the policy in a new tab without giving that page access to the app", async () => {
    const open = spyOn(window, "open").mockImplementation(() => null);
    await openPrivacyPolicy();
    expect(open).toHaveBeenCalledWith(PRIVACY_POLICY_URL, "_blank", "noopener,noreferrer");
  });

  test("on desktop it asks the Tauri shell to open the policy, not the app's own webview", async () => {
    const commands: string[] = [];
    (window as TauriWindow).__TAURI_INTERNALS__ = {
      invoke: async (command: string) => { commands.push(command); },
    };
    const open = spyOn(window, "open").mockImplementation(() => null);
    await openPrivacyPolicy();
    expect(commands).toEqual(["open_privacy_policy"]);
    expect(open).not.toHaveBeenCalled();
  });
});
