// A failed save while TinyCloud storage is full: Manage storage on web and desktop; Save now and the plan note, as plain
// text, in the iOS and Android apps (App Store 3.1.1, Play Payments).
import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { installDom } from "@/test/dom";
import { type AppPlatform, PlatformContext } from "@/lib/platform";
import { __resetStorageStatusForTests, NATIVE_PLAN_NOTE, reportStorageError } from "@/lib/storageStatus";
import { voiceNoteRoute } from "./RouteLine";
import { SavedReceipt } from "./SavedReceipt";

afterEach(async () => {
  await __resetStorageStatusForTests();
});

async function failedReceipt(platform: AppPlatform) {
  const restoreDom = installDom();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  reportStorageError({ code: "STORAGE_QUOTA_EXCEEDED", message: "storage is full" });
  const saveNow: string[] = [];
  await act(async () => root.render(
    <PlatformContext.Provider value={platform}>
      <SavedReceipt outcome="failed" route={voiceNoteRoute("off")} onDone={() => {}} onSaveNow={() => saveNow.push("save")} />
    </PlatformContext.Provider>,
  ));
  return {
    container,
    saveNow,
    close: async () => {
      await act(async () => root.unmount());
      restoreDom();
    },
  };
}

describe("SavedReceipt, failed while storage is full", () => {
  for (const platform of ["ios", "android"] as const) {
    test(`${platform}: Save now and the plan note as text; no Manage storage`, async () => {
      const receipt = await failedReceipt(platform);
      try {
        const retry = receipt.container.querySelector<HTMLButtonElement>('[data-testid="voice-note-retry"]')!;
        expect(retry.textContent).toContain("Save now");
        expect(receipt.container.textContent).not.toContain("Manage storage");
        expect(receipt.container.querySelector('[data-testid="voice-note-plan-note"]')?.textContent).toBe(NATIVE_PLAN_NOTE);
        expect(receipt.container.querySelector("a")).toBeNull();
        await act(async () => retry.click());
        expect(receipt.saveNow).toEqual(["save"]);
      } finally {
        await receipt.close();
      }
    });
  }

  for (const platform of ["web", "tauri"] as const) {
    test(`${platform}: Manage storage, without the plan note`, async () => {
      const receipt = await failedReceipt(platform);
      try {
        expect(receipt.container.querySelector('[data-testid="voice-note-retry"]')?.textContent).toContain("Manage storage");
        expect(receipt.container.querySelector('[data-testid="voice-note-plan-note"]')).toBeNull();
      } finally {
        await receipt.close();
      }
    });
  }
});
