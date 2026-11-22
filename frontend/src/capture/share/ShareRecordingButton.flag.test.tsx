// TC-3195: the Share button shows on every shareable recording.
import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { installDom } from "@/test/dom";
import { sentShares } from "@/lib/nativeShares/sentShares";
import type { LibraryItem } from "../library/LibraryRow";
import { ShareRecordingButton, type ShareableRecording } from "./ShareRecordingSheet";

const ITEM = { id: "row-1", source: "fireflies", sourceId: "ff-1", title: "Product sync", startedAt: "2026-11-16T14:00:00.000Z", durationSecs: 1924 } as LibraryItem;
const RECORDING: ShareableRecording = { item: ITEM, title: "Product sync", metadata: null, hasTranscript: true };

let restore: (() => void) | undefined;
let root: Root | undefined;
afterEach(async () => {
  if (root) act(() => root!.unmount());
  root = undefined;
  await sentShares.bind(null);
  restore?.(); restore = undefined;
});

async function mount() {
  restore = installDom({});
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(<ShareRecordingButton tcw={{} as TinyCloudWeb} recording={RECORDING} />));
  return () => host.querySelector('[data-testid="share-recording"]');
}

test("an unshared recording has a Share button", async () => {
  const button = await mount();
  expect(button()).not.toBeNull();
});
