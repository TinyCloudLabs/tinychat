import { afterEach, describe, expect, test } from "bun:test";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { installDom } from "@/test/dom";
import { reportStoragePlanTier, STORAGE_FULL_DETAIL, STORAGE_FULL_RECORDING_LINE } from "@/lib/storageStatus";
import { StorageFullActions, StorageFullMessage } from "./StorageFullDialog";

afterEach(() => reportStoragePlanTier(null));

type Rendered = {
  text: () => string;
  rerender: (node: ReactNode) => Promise<void>;
  close: () => Promise<void>;
  restore: () => void;
};

async function renderNode(node: ReactNode): Promise<Rendered> {
  const restoreDom = installDom();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const rerender = (next: ReactNode) => act(async () => root.render(next));
  await rerender(node);
  return {
    text: () => container.textContent ?? "",
    rerender,
    close: () => act(async () => root.unmount()),
    restore: restoreDom,
  };
}

async function renderActions(paywallEnabled: boolean): Promise<Rendered & { setPaywall: (on: boolean) => Promise<void> }> {
  const rendered = await renderNode(<StorageFullActions paywallEnabled={paywallEnabled} />);
  return { ...rendered, setPaywall: (on) => rendered.rerender(<StorageFullActions paywallEnabled={on} />) };
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

describe("StorageFullMessage", () => {
  test("the App banner shows the main line without any plan detail", async () => {
    reportStoragePlanTier("free");
    const message = await renderNode(<StorageFullMessage detail={false} />);
    try {
      expect(message.text()).toContain(STORAGE_FULL_RECORDING_LINE);
      expect(message.text()).not.toContain(STORAGE_FULL_DETAIL.free);
      expect(message.text()).not.toContain(STORAGE_FULL_DETAIL.paid);
    } finally {
      await message.close();
      message.restore();
    }
  });

  test("the Settings banner and dialog add the Free detail only for a positively Free plan", async () => {
    reportStoragePlanTier("free");
    const message = await renderNode(<StorageFullMessage detail />);
    try {
      expect(message.text()).toContain(STORAGE_FULL_RECORDING_LINE);
      expect(message.text()).toContain(STORAGE_FULL_DETAIL.free);
      expect(message.text()).not.toContain(STORAGE_FULL_DETAIL.paid);
    } finally {
      await message.close();
      message.restore();
    }
  });

  test("an unknown plan gets the paid detail", async () => {
    const message = await renderNode(<StorageFullMessage detail />);
    try {
      expect(message.text()).toContain(STORAGE_FULL_DETAIL.paid);
    } finally {
      await message.close();
      message.restore();
    }
  });
});
