// TC-3195: making share links is behind Settings → "Show hidden features" until sharing is turned on. A recording
// the owner already shares keeps its Share button with the setting off, so Stop sharing stays reachable.
import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { installDom } from "@/test/dom";
import { resetHiddenFeaturesForTest, setShowHiddenFeatures } from "@/lib/hiddenFeatures";
import { sentShareRecord, sentShares } from "@/lib/nativeShares/sentShares";
import type { RecordSpace } from "@/lib/nativeShares/spaceRecords";
import type { LibraryItem } from "../library/LibraryRow";
import { ShareRecordingButton, type ShareableRecording } from "./ShareRecordingSheet";

const ITEM = { id: "row-1", source: "fireflies", sourceId: "ff-1", title: "Product sync", startedAt: "2026-11-16T14:00:00.000Z", durationSecs: 1924 } as LibraryItem;
const RECORDING: ShareableRecording = { item: ITEM, title: "Product sync", metadata: null, hasTranscript: true };

/** An empty account space: lists nothing, takes every write. */
const SPACE = {
  did: "did:pkh:eip155:1:0xd5590000000000000000000000000000000ff412",
  kv: {
    list: async () => ({ ok: true, data: { keys: [] } }),
    get: async () => ({ ok: false, error: { code: "KV_NOT_FOUND", message: "KV_NOT_FOUND" } }),
    put: async () => ({ ok: true, data: undefined }),
    delete: async () => ({ ok: true, data: undefined }),
  },
} as unknown as RecordSpace;

let restore: (() => void) | undefined;
let root: Root | undefined;
afterEach(async () => {
  if (root) act(() => root!.unmount());
  root = undefined;
  resetHiddenFeaturesForTest();
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

test("with hidden features off, an unshared recording has no Share button", async () => {
  const button = await mount();
  expect(button()).toBeNull();
});

test("turning hidden features on shows the Share button, and off hides it again", async () => {
  const button = await mount();
  await act(async () => setShowHiddenFeatures(true));
  expect(button()).not.toBeNull();
  await act(async () => setShowHiddenFeatures(false));
  expect(button()).toBeNull();
});

test("a recording already shared keeps its Share button with hidden features off, until its access ends", async () => {
  const button = await mount();
  await act(async () => sentShares.bind(SPACE));
  const now = new Date();
  const live = sentShareRecord({
    recordingId: ITEM.id, rootCid: "bafyroot", paths: ["xyz.tinycloud.tinychat/connectors/fireflies/transcript/ff-1"],
    linkExpiresAt: new Date(now.getTime() + 86_400_000).toISOString(), accessExpiresAt: new Date(now.getTime() + 30 * 86_400_000).toISOString(), now,
  });
  await act(async () => sentShares.put(SPACE, live));
  expect(button()).not.toBeNull();
  await act(async () => sentShares.remove(SPACE, live.id));
  expect(button()).toBeNull();
});
