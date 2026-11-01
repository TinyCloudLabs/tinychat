// The default for new recordings is in ⚙︎ Capture settings, on the app variant (TC-2182).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { installDom } from "@/test/dom";
import { readAutoStopChoice, readStopAfterPreference, setAutoStopPreference, setStopAfterPreference } from "@/lib/voiceNotes/transcriberPreference";
import { SettingsPanel, type SettingsPanelProps } from "./CaptureSettings";

let restoreDom: () => void;
let root: Root;
let host: HTMLElement;

beforeEach(() => {
  restoreDom = installDom();
  setAutoStopPreference(true);
  setStopAfterPreference("60");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  setAutoStopPreference(null);
  restoreDom();
});

const panel = (variant: SettingsPanelProps["variant"]): SettingsPanelProps => ({
  variant, extrasAvailable: true, load: { status: "loading" }, downloads: {},
  microphone: { name: null, inputs: [], currentId: null, selectedMissing: null, select: () => {}, unavailable: true, error: null, retry: null },
  modelError: null, switches: { systemAudio: { pending: false, error: null }, uploadAudio: { pending: false, error: null } },
  onRetryLoad: () => {}, onSelectModel: () => {}, onGetModel: () => {}, onToggle: () => {},
});
const click = (testId: string) => act(async () => (host.querySelector(`[data-testid="${testId}"]`) as HTMLElement).click());

describe("Stop recording after, in Capture settings", () => {
  {
    test("choosing a duration is the stored default, and the hint follows it", async () => {
      await act(async () => root.render(<SettingsPanel {...panel("app")} />));
      expect(host.querySelector('[data-testid="stop-after-60"]')!.getAttribute("aria-checked")).toBe("true");
      await click("stop-after-15");
      expect(readStopAfterPreference()).toBe("15");
      expect(host.textContent).toContain("Recordings stop after 15 minutes.");
      expect(host.querySelector('[data-testid="stop-after-15"]')!.getAttribute("aria-checked")).toBe("true");
    });
  }

  test("turning automatic stopping off stores the choice and hides the durations", async () => {
    await act(async () => root.render(<SettingsPanel {...panel("app")} />));
    await click("switch-auto-stop");
    expect(readAutoStopChoice()).toBe(false);
    expect(host.querySelector('[data-testid="settings-stop-after-options"]')).toBeNull();
  });
});
