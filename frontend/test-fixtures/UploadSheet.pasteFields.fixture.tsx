import { afterAll, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { SessionStore } from "@tinyboilerplate/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { installDom } from "@/test/dom";
import { initSizeClass } from "@/lib/sizeClass";

// Static import cannot work: Radix/vaul capture DOM availability at module
// evaluation. Import after installDom in this isolated process. No module
// mocking is used.
const restoreImportDom = installDom();
Object.defineProperty(window, "innerWidth", { configurable: true, value: 400 });
const stopSizeClass = initSizeClass(window);
const { UploadSheet } = await import("@/capture/upload/UploadSheet");

const tick = () => new Promise<void>((resolve) => { setTimeout(resolve, 0); });
async function settle() {
  await act(async () => { await tick(); await tick(); });
}

afterAll(() => {
  stopSizeClass();
  restoreImportDom();
});

// iOS zooms the whole page when an editable field under 16px takes focus and
// keeps the zoom after focus leaves. The paste-a-transcript fields render ≥16px
// on touch (text-body) and keep their compact size only with a mouse
// (fine:text-callout), the same rule the composer and the notetaker form follow.
test("the paste-a-transcript fields render 16px on touch", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(
    <UploadSheet
      open
      onOpenChange={() => {}}
      tcw={{} as TinyCloudWeb}
      backendUrl="https://synthetic.invalid"
      sessionStore={{ getToken: () => "synthetic-session", isExpired: () => false } as unknown as SessionStore}
    />,
  ));
  await settle();

  const choose = [...host.ownerDocument.querySelectorAll<HTMLButtonElement>("button")]
    .find((entry) => entry.textContent?.trim() === "Paste a transcript");
  expect(choose).toBeTruthy();
  await act(async () => { choose!.click(); await tick(); });
  await settle();

  const fields = [...host.ownerDocument.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
    '[data-testid="upload-sheet"] input, [data-testid="upload-sheet"] textarea',
  )];
  expect(fields.length).toBe(3);
  for (const field of fields) {
    expect(field.className).toContain("text-body");
    expect(field.className).toContain("fine:text-callout");
  }

  await act(async () => root.unmount());
  host.remove();
});
