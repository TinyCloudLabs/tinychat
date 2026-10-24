import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { createFakeDesktopCaptureExtras, type FakeDesktopCaptureExtrasOptions } from "@/lib/voiceNotes/fakeDesktopCaptureExtras";
import { installDom } from "@/test/dom";
import { CaptureSettings } from "./CaptureSettings";

const LARGE_TURBO = "Whisper Large Turbo";
const SMALL = "Whisper Small (multilingual)";

let root: Root | null = null;
let restoreDom: (() => void) | null = null;

async function openPicker(options: FakeDesktopCaptureExtrasOptions) {
  restoreDom = installDom();
  const fake = createFakeDesktopCaptureExtras(options);
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(
    <CaptureSettings variant="app" inputs={null} extras={fake.extras} defaultOpen />,
  ));
  return { text: () => host.textContent ?? "", calls: fake.calls };
}

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  restoreDom?.();
  restoreDom = null;
});

describe("the capture settings model picker", () => {
  test("does not offer Large Turbo to a user who has neither selected nor downloaded it", async () => {
    const picker = await openPicker({});
    expect(picker.text()).toContain(SMALL);
    expect(picker.text()).not.toContain(LARGE_TURBO);
  });

  test("offers Large Turbo while the user has it selected", async () => {
    const picker = await openPicker({ selected: "QuantizedLargeTurbo", downloaded: ["QuantizedLargeTurbo"] });
    expect(picker.text()).toContain(LARGE_TURBO);
  });

  test("offers Large Turbo while it is on disk", async () => {
    const picker = await openPicker({ downloaded: ["QuantizedLargeTurbo"], selected: "QuantizedSmall" });
    expect(picker.text()).toContain(LARGE_TURBO);
  });

  test("offers Large Turbo while its download is in flight", async () => {
    const picker = await openPicker({ downloading: { QuantizedLargeTurbo: 0.2 } });
    expect(picker.text()).toContain(LARGE_TURBO);
  });

  test("opening the picker does not change the stored model selection", async () => {
    const picker = await openPicker({ selected: "QuantizedLargeTurbo", downloaded: ["QuantizedLargeTurbo"] });
    expect(picker.calls.filter((c) => c.startsWith("models.select"))).toEqual([]);
  });
});
