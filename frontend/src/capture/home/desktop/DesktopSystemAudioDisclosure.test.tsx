import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { StaticRecorderProvider } from "@/capture/recorder/RecorderProvider";
import { installDom } from "@/test/dom";
import { SystemAudioStart } from "./SystemAudioStart";

let cleanupDom: (() => void) | null = null;
let root: Root | null = null;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  cleanupDom?.();
  cleanupDom = null;
});

test("the Mac home Record control delegates to the provider's shared start entry point", async () => {
  cleanupDom = installDom();
  let started = 0;
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(
    <StaticRecorderProvider value={{ ready: true, record: () => { started += 1; } }}>
      <SystemAudioStart />
    </StaticRecorderProvider>,
  ));
  await act(async () => document.querySelector<HTMLElement>('[data-testid="voice-note-record"]')!.click());
  expect(started).toBe(1);
});
