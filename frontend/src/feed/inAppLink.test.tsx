import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Capacitor } from "@capacitor/core";
import { installDom } from "@/test/dom";
import { inAppTarget, nativeBrowser, openLinkInApp, refusesFraming, useLinkSheet, useLinkSheetHost, type LinkClick } from "./inAppLink";

type TauriWindow = { __TAURI_INTERNALS__?: unknown };
const saved = Capacitor.isNativePlatform;
let restoreDom: (() => void) | undefined;
let root: Root | undefined;

beforeEach(() => { restoreDom = installDom(); });
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  delete (window as TauriWindow).__TAURI_INTERNALS__;
  Capacitor.isNativePlatform = saved;
  mock.restore();
  restoreDom?.();
});

function click(init: Partial<LinkClick> = {}) {
  const preventDefault = mock(() => {});
  return { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, defaultPrevented: false, preventDefault, ...init };
}

let shown: { url: string | null; open: boolean } = { url: null, open: false };
/** Mounts a screen with the web sheet, which records what the sheet would show. */
async function mountSheet() {
  function Host() {
    useLinkSheetHost();
    shown = useLinkSheet();
    return null;
  }
  root = createRoot(document.createElement("div"));
  await act(async () => root!.render(<Host />));
}

describe("inAppTarget", () => {
  test("only an absolute http(s) address on another origin opens inside the app", () => {
    const here = "https://app.example.test/chat/feed";
    expect(inAppTarget("https://example.com/a?b=1", here)).toBe("https://example.com/a?b=1");
    expect(inAppTarget("http://example.com/", here)).toBe("http://example.com/");
    for (const href of ["mailto:sam@example.com", "javascript:alert(1)", "data:text/html,hi", "tel:+15551234", "/chat/feed/abc", "https://app.example.test/s/x", "not a url"]) {
      expect(inAppTarget(href, here)).toBeUndefined();
    }
  });
});

describe("refusesFraming", () => {
  test("known refusers by host, with or without www, and nothing broader", () => {
    expect(refusesFraming("https://github.com/acme/site/pull/1")).toBe(true);
    expect(refusesFraming("https://www.youtube.com/watch?v=1")).toBe(true);
    expect(refusesFraming("https://linear.app/acme/issue/TC-1")).toBe(true);
    expect(refusesFraming("https://example.com/")).toBe(false);
    expect(refusesFraming("https://blog.cloudflare.com/post")).toBe(false);
    expect(refusesFraming("https://constructor/")).toBe(false);
  });
});

describe("openLinkInApp", () => {
  test("on the web a plain click opens the sheet and keeps the page from leaving", async () => {
    await mountSheet();
    const event = click();
    await act(async () => { expect(openLinkInApp("https://example.com/r", event)).toBe("sheet"); });
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(shown).toEqual({ url: "https://example.com/r", open: true });
  });

  test("modified, middle and already-handled clicks keep the browser's own behaviour", async () => {
    await mountSheet();
    const open = spyOn(nativeBrowser, "open").mockImplementation(async () => {});
    for (const init of [{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }, { defaultPrevented: true }]) {
      for (const native of [false, true]) {
        Capacitor.isNativePlatform = () => native;
        const event = click(init);
        expect(openLinkInApp("https://example.com/", event)).toBe("browser");
        expect(event.preventDefault).not.toHaveBeenCalled();
      }
    }
    expect(open).not.toHaveBeenCalled();
    expect(shown.open).toBe(false);
  });

  test("other schemes and this app's own pages stay plain links", async () => {
    await mountSheet();
    for (const href of ["mailto:sam@example.com", `${window.location.origin}/chat/feed`]) {
      const event = click();
      expect(openLinkInApp(href, event)).toBe("browser");
      expect(event.preventDefault).not.toHaveBeenCalled();
    }
  });

  test("with no sheet on the screen, or a link kept out of it, the web keeps the new tab", async () => {
    const event = click();
    expect(openLinkInApp("https://example.com/", event)).toBe("browser");
    await mountSheet();
    expect(openLinkInApp("https://example.com/", event, { sheet: false })).toBe("browser");
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  test("in the phone app it opens the system's in-app browser, approvals included, and never the sheet", async () => {
    await mountSheet();
    Capacitor.isNativePlatform = () => true;
    const open = spyOn(nativeBrowser, "open").mockImplementation(async () => {});
    const event = click();
    expect(openLinkInApp("https://example.com/r", event)).toBe("native");
    expect(openLinkInApp("https://openkey.so/review", click(), { sheet: false })).toBe("native");
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(open.mock.calls).toEqual([["https://example.com/r"], ["https://openkey.so/review"]]);
    expect(shown.open).toBe(false);
    // Anything but http(s) never reaches it.
    expect(openLinkInApp("mailto:sam@example.com", click())).toBe("browser");
    expect(open).toHaveBeenCalledTimes(2);
  });

  test("the desktop app keeps its own link handling", async () => {
    await mountSheet();
    (window as TauriWindow).__TAURI_INTERNALS__ = {};
    const event = click();
    expect(openLinkInApp("https://example.com/", event)).toBe("browser");
    expect(event.preventDefault).not.toHaveBeenCalled();
  });
});
