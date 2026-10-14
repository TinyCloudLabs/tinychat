import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { installDom } from "@/test/dom";
import { reportStoragePlanTier } from "@/lib/storageStatus";
import { StorageFullActions } from "./StorageFullDialog";

afterEach(() => reportStoragePlanTier(null));

async function renderActions(paywallEnabled: boolean): Promise<{
  text: () => string;
  setPaywall: (on: boolean) => Promise<void>;
  close: () => Promise<void>;
  restore: () => void;
}> {
  const restoreDom = installDom();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = (on: boolean) => act(async () => root.render(<StorageFullActions paywallEnabled={on} />));
  await render(paywallEnabled);
  return {
    text: () => container.textContent ?? "",
    setPaywall: render,
    close: () => act(async () => root.unmount()),
    restore: restoreDom,
  };
}

describe("StorageFullActions", () => {
  test("a positively Free plan with the paywall on sees Upgrade beside Manage storage", async () => {
    reportStoragePlanTier("free");
    const actions = await renderActions(true);
    try {
      expect(actions.text()).toContain("Manage storage");
      expect(actions.text()).toContain("Upgrade");
    } finally {
      await actions.close();
      actions.restore();
    }
  });

  test("a Free plan with the paywall off sees no Upgrade", async () => {
    reportStoragePlanTier("free");
    const actions = await renderActions(false);
    try {
      expect(actions.text()).toContain("Manage storage");
      expect(actions.text()).not.toContain("Upgrade");
    } finally {
      await actions.close();
      actions.restore();
    }
  });

  test("a Free plan reported after mount offers Upgrade only while the paywall is on", async () => {
    const actions = await renderActions(false);
    try {
      await act(async () => reportStoragePlanTier("free"));
      expect(actions.text()).not.toContain("Upgrade");
      await actions.setPaywall(true);
      expect(actions.text()).toContain("Upgrade");
    } finally {
      await actions.close();
      actions.restore();
    }
  });

  test("a paid or unknown plan sees Manage storage but no Upgrade", async () => {
    reportStoragePlanTier("pro");
    const paid = await renderActions(true);
    try {
      expect(paid.text()).toContain("Manage storage");
      expect(paid.text()).not.toContain("Upgrade");
    } finally {
      await paid.close();
      paid.restore();
    }
    reportStoragePlanTier(null);
    const unknown = await renderActions(true);
    try {
      expect(unknown.text()).toContain("Manage storage");
      expect(unknown.text()).not.toContain("Upgrade");
    } finally {
      await unknown.close();
      unknown.restore();
    }
  });
});
