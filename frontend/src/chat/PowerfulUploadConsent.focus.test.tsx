// The Powerful consent dialog inside the upload sheet (TC-2139): keyboard focus stays in the dialog, the sheet
// behind it is inert, Escape closes only the dialog, and focus returns to the control that opened it.
// The harness is a real Radix Dialog (the primitive under ResponsiveSheet, on both its vaul and Dialog shapes: focus
// scope, Escape layer, aria-hidden siblings) around the same shape as the upload panel: the consent dialog is
// rendered inside the sheet's content, next to Back and the file field. Radix portals do not attach in happy-dom,
// so the content is rendered in place.
import { afterEach, describe, expect, test } from "bun:test";
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";

import { POWERFUL_CONSENT_ACTION } from "@/capture/recorder/final/finalCopy";
import * as Dialog from "@radix-ui/react-dialog";

import { installDom } from "@/test/dom";
import { usePowerfulUploadConsent } from "./PowerfulUploadConsent";

let root: Root | null = null;
let cleanupDom: (() => void) | undefined;

/** Radix's focus scope fires its unmount event in a timeout: let it run while this DOM is still the global one. */
async function teardown() {
  if (root) await act(async () => root!.unmount());
  root = null;
  await new Promise((resolve) => setTimeout(resolve, 0));
  cleanupDom?.();
  cleanupDom = undefined;
}

afterEach(teardown);

interface Trace {
  calls: string[];
  sheetCloses: number;
}

/** The upload sheet: Close and Back above, a file field and a note about the chosen file in the body, Transcribe in the footer. */
async function mount(trace: Trace): Promise<void> {
  cleanupDom = installDom();
  const host = document.createElement("div");
  document.body.appendChild(host);
  function Sheet() {
    const [open, setOpen] = useState(true);
    const [file, setFile] = useState<string | null>("meeting.m4a");
    const [consented, setConsented] = useState(false);
    const gate = usePowerfulUploadConsent({ consented, onConsent: () => { trace.calls.push("consent"); setConsented(true); } });
    return createElement(Dialog.Root, {
      open,
      onOpenChange: (next: boolean) => { if (!next) { trace.sheetCloses += 1; setFile(null); } setOpen(next); },
      children: createElement(Dialog.Content, { "data-testid": "upload-sheet", "aria-describedby": undefined },
        createElement(Dialog.Title, null, "Upload audio"),
        createElement(Dialog.Close, { "aria-label": "Close" }, "x"),
        createElement("button", { type: "button", "data-testid": "back" }, "Back"),
        createElement("div", null,
          createElement("input", { type: "file", "data-testid": "file-input" }),
          createElement("a", { href: "/how-it-works", "data-testid": "how" }, "How it works"),
          createElement("p", { "data-testid": "file-name" }, file ?? "no file")),
        createElement("div", null,
          createElement("button", { type: "button", "data-testid": "transcribe", onClick: () => gate.request("assemblyai", () => trace.calls.push("upload")) }, "Transcribe")),
        gate.dialog),
    });
  }
  root = createRoot(host);
  await act(async () => root!.render(createElement(Sheet)));
}

const byId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;
const consent = () => document.querySelector<HTMLElement>('[data-testid="upload-powerful-consent"]');
const dialogButtons = () => [...consent()!.querySelectorAll<HTMLElement>("button, a[href]")];
const buttonLabelled = (label: string) => dialogButtons().find((b) => b.textContent === label)!;

/** Focuses Transcribe, as a click on it does in a browser, then clicks it. */
async function openConsent() {
  const transcribe = byId("transcribe");
  transcribe.focus();
  await act(async () => { transcribe.dispatchEvent(new window.MouseEvent("click", { bubbles: true })); });
}

/** A key pressed on the focused element. Returns whether the browser default (real Tab navigation) was left alone. */
async function press(key: string, shiftKey = false): Promise<boolean> {
  const event = new window.KeyboardEvent("keydown", { key, shiftKey, bubbles: true, cancelable: true });
  await act(async () => { (document.activeElement ?? document.body).dispatchEvent(event); });
  return !event.defaultPrevented;
}

/** Everything a Tab could reach that is not in the consent dialog and not behind an inert ancestor. Radix's focus guards
 *  (empty spans at the edges of the page) are left out: they only hand focus back to the sheet's last focused control. */
function tabbableBehind(): string[] {
  const dialog = consent();
  return [...document.querySelectorAll<HTMLElement>("button, a[href], input, select, textarea, [tabindex]")]
    .filter((el) => !dialog?.contains(el) && el.getAttribute("tabindex") !== "-1" && !el.hasAttribute("data-radix-focus-guard") && el.closest("[inert]") === null)
    .map((el) => el.getAttribute("data-testid") ?? el.getAttribute("aria-label") ?? el.tagName);
}

describe("Powerful consent in the upload sheet", () => {
    test("opens with focus on Not now", async () => {
      await mount({ calls: [], sheetCloses: 0 });
      await openConsent();
      expect(document.activeElement).toBe(buttonLabelled("Not now"));
    });

    test("Tab from the last dialog control wraps to the first and never reaches the sheet", async () => {
      await mount({ calls: [], sheetCloses: 0 });
      await openConsent();
      const controls = dialogButtons();
      controls[controls.length - 1]!.focus();
      expect(await press("Tab")).toBe(false);
      expect(document.activeElement).toBe(controls[0]!);
    });

    test("Tab walks only the dialog's own controls, in a loop", async () => {
      await mount({ calls: [], sheetCloses: 0 });
      await openConsent();
      const controls = dialogButtons();
      const seen: Element[] = [];
      for (let i = 0; i < controls.length * 2; i += 1) {
        await press("Tab");
        seen.push(document.activeElement!);
      }
      expect(seen.every((el) => controls.includes(el as HTMLElement))).toBe(true);
      expect(new Set(seen).size).toBe(controls.length);
      // The action is reachable going forward, not only with Shift+Tab.
      expect(seen).toContain(buttonLabelled(POWERFUL_CONSENT_ACTION));
    });

    test("Shift+Tab from Not now wraps to the last dialog control", async () => {
      await mount({ calls: [], sheetCloses: 0 });
      await openConsent();
      const controls = dialogButtons();
      expect(document.activeElement).toBe(buttonLabelled("Not now"));
      expect(await press("Tab", true)).toBe(false);
      expect(document.activeElement).toBe(controls[controls.length - 1]!);
    });

    test("nothing behind the dialog is tabbable while it is open, and the sheet is live again after", async () => {
      await mount({ calls: [], sheetCloses: 0 });
      expect(tabbableBehind().length).toBeGreaterThan(0);
      await openConsent();
      for (const id of ["back", "file-input", "how", "transcribe"]) expect(byId(id).closest("[inert]")).not.toBeNull();
      expect(document.querySelector('[aria-label="Close"]')!.closest("[inert]")).not.toBeNull();
      expect(tabbableBehind()).toEqual([]);
      expect(consent()!.closest("[inert]")).toBeNull();
      await act(async () => { buttonLabelled("Not now").dispatchEvent(new window.MouseEvent("click", { bubbles: true })); });
      expect(document.querySelector("[inert]")).toBeNull();
    });

    test("Escape declines: no upload, nothing recorded, and the sheet and its file stay", async () => {
      const trace: Trace = { calls: [], sheetCloses: 0 };
      await mount(trace);
      await openConsent();
      await press("Escape");
      expect(consent()).toBeNull();
      expect(trace.calls).toEqual([]);
      expect(trace.sheetCloses).toBe(0);
      expect(byId("upload-sheet")).not.toBeNull();
      expect(byId("file-name").textContent).toBe("meeting.m4a");
    });

    test("a second Escape, with the dialog gone, closes the sheet as before", async () => {
      const trace: Trace = { calls: [], sheetCloses: 0 };
      await mount(trace);
      await openConsent();
      await press("Escape");
      byId("transcribe").focus();
      await press("Escape");
      expect(trace.sheetCloses).toBe(1);
    });

    test("focus returns to Transcribe on Escape, on Not now and on confirm", async () => {
      for (const close of ["escape", "not-now", "confirm"] as const) {
        await mount({ calls: [], sheetCloses: 0 });
        await openConsent();
        if (close === "escape") await press("Escape");
        else await act(async () => { buttonLabelled(close === "not-now" ? "Not now" : POWERFUL_CONSENT_ACTION).dispatchEvent(new window.MouseEvent("click", { bubbles: true })); });
        expect(consent()).toBeNull();
        expect(document.activeElement).toBe(byId("transcribe"));
        await teardown();
      }
    });
});
