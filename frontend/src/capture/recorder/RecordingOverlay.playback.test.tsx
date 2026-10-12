import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";

import { registerPlayback } from "@/lib/audio/playback";
import { installDom } from "@/test/dom";
import { StaticRecorderProvider } from "./RecorderProvider";
import { RecordingOverlay } from "./RecordingOverlay";

let cleanup: (() => void) | undefined;
let root: Root | null = null;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  cleanup?.();
  cleanup = undefined;
});

test("opening the recorder overlay stops audio in the pane underneath", async () => {
  cleanup = installDom();
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
  const host = document.createElement("div");
  const audio = document.createElement("audio");
  document.body.append(audio, host);
  let stops = 0;
  const unregister = registerPlayback(audio, () => { stops++; });
  root = createRoot(host);
  const render = (sheetOpen: boolean) => act(async () => root!.render(
    <MemoryRouter>
      <StaticRecorderProvider value={{ sheetOpen, available: false }}>
        <RecordingOverlay loadPhoneRecorder={async () => ({ PhoneRecorder: () => null })} />
      </StaticRecorderProvider>
    </MemoryRouter>,
  ));
  await render(false);
  const beforeOpen = stops;
  await render(true);
  expect(stops).toBeGreaterThan(beforeOpen);
  unregister();
});
