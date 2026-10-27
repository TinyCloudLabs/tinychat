import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { installDom } from "@/test/dom";
import { applyTinyCloudButton, readTinyCloudButtonShown, setTinyCloudButtonShown, TINYCLOUD_BUTTON_KEY } from "./tinycloudButton";

let cleanDom: (() => void) | undefined;
beforeAll(() => { cleanDom = installDom(); });
afterAll(() => cleanDom?.());
beforeEach(() => window.localStorage.clear());

const tcwWith = (ui: unknown) => ({ ui }) as unknown as TinyCloudWeb;

describe("TinyCloud button setting", () => {
  test("is OFF until the user turns it on", () => {
    expect(readTinyCloudButtonShown()).toBe(false);
  });

  test("persists across reads in this browser", () => {
    setTinyCloudButtonShown(true);
    expect(window.localStorage.getItem(TINYCLOUD_BUTTON_KEY)).toBe("true");
    expect(readTinyCloudButtonShown()).toBe(true);
    setTinyCloudButtonShown(false);
    expect(readTinyCloudButtonShown()).toBe(false);
  });

  test("any stored value other than true reads as OFF", () => {
    window.localStorage.setItem(TINYCLOUD_BUTTON_KEY, "1");
    expect(readTinyCloudButtonShown()).toBe(false);
  });

  test("apply forwards the value to the SDK", () => {
    const calls: boolean[] = [];
    const tcw = tcwWith({ setButtonVisible: (visible: boolean) => calls.push(visible) });
    applyTinyCloudButton(tcw, true);
    applyTinyCloudButton(tcw, false);
    expect(calls).toEqual([true, false]);
  });
});
