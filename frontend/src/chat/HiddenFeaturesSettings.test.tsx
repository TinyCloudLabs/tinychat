import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { installDom } from "@/test/dom";
import { HIDDEN_FEATURES_KEY, resetHiddenFeaturesForTest } from "@/lib/hiddenFeatures";
import { HIDDEN_FEATURES_STRINGS, HiddenFeaturesSettings } from "./HiddenFeaturesSettings";

let restore: (() => void) | undefined;
let root: Root | undefined;
afterEach(() => {
  if (root) act(() => root!.unmount());
  root = undefined;
  resetHiddenFeaturesForTest();
  restore?.(); restore = undefined;
});

async function mount() {
  restore = installDom({});
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(<HiddenFeaturesSettings />));
  return host;
}

test("the switch starts off, turns the setting on and off, and keeps it on this device", async () => {
  const host = await mount();
  const toggle = () => host.querySelector<HTMLButtonElement>(`button[role="switch"][aria-label="${HIDDEN_FEATURES_STRINGS.label}"]`)!;
  expect(toggle().getAttribute("aria-checked")).toBe("false");
  await act(async () => toggle().click());
  expect(toggle().getAttribute("aria-checked")).toBe("true");
  expect(localStorage.getItem(HIDDEN_FEATURES_KEY)).toBe("1");
  await act(async () => toggle().click());
  expect(toggle().getAttribute("aria-checked")).toBe("false");
  expect(localStorage.getItem(HIDDEN_FEATURES_KEY)).toBeNull();
});
