import { describe, expect, test } from "bun:test";
import { installDom } from "@/test/dom";
import { anotherModalOpen, appDialogOpen } from "./modalOpen";

const none = { storageFull: false, pendingVoiceNoteSignOut: false, pricing: false, rates: false };

describe("appDialogOpen", () => {
  test("is false with no App dialog open", () => {
    expect(appDialogOpen(none)).toBe(false);
  });
  for (const name of ["storageFull", "pendingVoiceNoteSignOut", "pricing", "rates"] as const) {
    test(`is true while the ${name} dialog is open`, () => {
      expect(appDialogOpen({ ...none, [name]: true })).toBe(true);
    });
  }
});

describe("anotherModalOpen", () => {
  test("sees open dialogs and alert dialogs, however they are built, and ignores closing ones and the finish-setup notice", () => {
    const restore = installDom();
    try {
      const html = (markup: string) => { document.body.innerHTML = markup; };
      html("");
      expect(anotherModalOpen()).toBe(false);
      html('<div role="dialog" data-state="open"></div>');
      expect(anotherModalOpen()).toBe(true);
      html('<div role="alertdialog" aria-modal="true"></div>');
      expect(anotherModalOpen()).toBe(true);
      html('<div role="dialog" data-state="closed"></div>');
      expect(anotherModalOpen()).toBe(false);
      html('<div role="dialog" data-state="open" data-testid="finish-setup-notice"></div>');
      expect(anotherModalOpen()).toBe(false);
      html('<div role="dialog"><div data-testid="finish-setup-notice"></div></div>');
      expect(anotherModalOpen()).toBe(false);
      html('<div role="dialog"><div data-testid="finish-setup-notice"></div></div><div role="alertdialog"></div>');
      expect(anotherModalOpen()).toBe(true);
    } finally {
      restore();
    }
  });
});
