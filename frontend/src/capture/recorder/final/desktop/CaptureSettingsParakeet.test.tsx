import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { createFakeDesktopCaptureExtras, type FakeDesktopCaptureExtrasOptions } from "@/lib/voiceNotes/fakeDesktopCaptureExtras";
import { installDom } from "@/test/dom";
import { CaptureSettings } from "./CaptureSettings";

// Parakeet in the ⚙︎ popover: a row in the same model list as Whisper, after it, with Get, progress and select like
// the others, and nothing but its name and size.

const PARAKEET = "soniqo-parakeet-batch";

let root: Root | null = null;
let restoreDom: (() => void) | null = null;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  restoreDom?.();
  restoreDom = null;
});

const settle = (ms = 20) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });

async function open(options: FakeDesktopCaptureExtrasOptions) {
  restoreDom = installDom();
  const fake = createFakeDesktopCaptureExtras({ parakeet: true, ...options });
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(<CaptureSettings variant="app" inputs={null} extras={fake.extras} defaultOpen />));
  await settle();
  const section = () => host.querySelector<HTMLElement>('section[aria-labelledby="cs-model-h"]')!;
  const row = () => section().querySelector<HTMLElement>(`[data-model="${PARAKEET}"]`);
  return { fake, section, row };
}

describe("CaptureSettings, Parakeet", () => {
  test("the model list ends with Parakeet: its name and size only, and Get", async () => {
    const { section, row } = await open({ downloaded: ["QuantizedTinyEn"], selected: "QuantizedTinyEn" });
    const rows = [...section().querySelectorAll<HTMLElement>("[data-model]")].map((el) => el.dataset.model);
    expect(rows.at(-1)).toBe(PARAKEET);
    expect(row()?.closest('[role="group"]')?.getAttribute("aria-label")).toBe("Available to download");
    expect(row()?.querySelector(".cs-name")?.textContent).toBe("Parakeet TDT 0.6B v3");
    expect(row()?.querySelector("small")?.textContent).toBe("674 MB");
    expect(row()?.textContent).toBe("Parakeet TDT 0.6B v3674 MBGet");
  });

  test("Get downloads it with progress; on disk it becomes a radio in the same group, and choosing it selects it", async () => {
    const { fake, row } = await open({ downloaded: ["QuantizedTinyEn"], selected: "QuantizedTinyEn" });
    await act(async () => row()!.querySelector<HTMLButtonElement>(`[data-testid="get-${PARAKEET}"]`)!.click());
    expect(fake.calls).toContain(`models.download:${PARAKEET}`);
    await act(async () => fake.emitProgress(PARAKEET, 0.63));
    expect(row()?.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("63");
    await act(async () => fake.finishDownload(PARAKEET));
    await settle();
    const radio = row()?.querySelector<HTMLElement>('[role="radio"]');
    expect(radio?.closest('[role="radiogroup"]')?.querySelector('[data-model="QuantizedTinyEn"]')).not.toBeNull();
    expect(radio?.getAttribute("aria-checked")).toBe("false");
    await act(async () => radio!.click());
    await settle();
    expect(fake.calls).toContain(`models.select:${PARAKEET}`);
    expect(row()?.querySelector('[role="radio"]')?.getAttribute("aria-checked")).toBe("true");
  });

  test("selected and on disk, it is the checked radio", async () => {
    const { row } = await open({ downloaded: ["QuantizedTinyEn", PARAKEET], selected: PARAKEET });
    expect(row()?.querySelector('[role="radio"]')?.getAttribute("aria-checked")).toBe("true");
    expect(row()?.textContent).toBe("Parakeet TDT 0.6B v3674 MB");
  });
});
