import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { installDom } from "@/test/dom";
import { reportStoragePlanTier } from "@/lib/storageStatus";
import { StorageFullActions } from "./StorageFullDialog";

afterEach(() => reportStoragePlanTier(null));

async function renderActions(): Promise<{ text: () => string; close: () => Promise<void>; restore: () => void }> {
  const restoreDom = installDom();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<StorageFullActions />));
  return {
    text: () => container.textContent ?? "",
    close: () => act(async () => root.unmount()),
    restore: restoreDom,
  };
}

describe("StorageFullActions", () => {
  test("a positively Free plan sees Upgrade beside Manage storage", async () => {
    reportStoragePlanTier("free");
    const actions = await renderActions();
    try {
      expect(actions.text()).toContain("Manage storage");
      expect(actions.text()).toContain("Upgrade");
    } finally {
      await actions.close();
      actions.restore();
    }
  });

  test("a paid or unknown plan sees Manage storage but no Upgrade", async () => {
    reportStoragePlanTier("pro");
    const paid = await renderActions();
    try {
      expect(paid.text()).toContain("Manage storage");
      expect(paid.text()).not.toContain("Upgrade");
    } finally {
      await paid.close();
      paid.restore();
    }
    reportStoragePlanTier(null);
    const unknown = await renderActions();
    try {
      expect(unknown.text()).toContain("Manage storage");
      expect(unknown.text()).not.toContain("Upgrade");
    } finally {
      await unknown.close();
      unknown.restore();
    }
  });
});
