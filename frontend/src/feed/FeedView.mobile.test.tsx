import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { installDom } from "@/test/dom";
import { PlatformContext, type AppPlatform } from "../lib/platform";
import { FeedView } from "./FeedView";
import { FEED_STRINGS } from "./strings";

let restore: (() => void) | undefined;
let root: Root | undefined;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  restore?.();
  restore = undefined;
});

/** A signed-in session whose every property read is recorded, so the test sees whether the feed touched it. */
function recordingTcw(reads: string[]): TinyCloudWeb {
  return new Proxy({}, {
    get(_target, property) {
      reads.push(String(property));
      if (property === "spaceId") return "tinycloud:pkh:eip155:1:0x1111111111111111111111111111111111111111:applications";
      return undefined;
    },
  }) as unknown as TinyCloudWeb;
}

async function mount(platform: AppPlatform, tcw: TinyCloudWeb): Promise<HTMLElement> {
  restore = installDom();
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(<PlatformContext.Provider value={platform}><FeedView tcw={tcw} /></PlatformContext.Provider>));
  return container;
}

for (const platform of ["ios", "android"] as const) {
  test(`on ${platform} the feed says it isn't available yet and never opens the feed databases (TC-2720)`, async () => {
    const reads: string[] = [];
    const container = await mount(platform, recordingTcw(reads));
    const status = container.querySelector('[role="status"]');
    expect(status?.textContent).toContain(FEED_STRINGS.mobileUnavailableHeading);
    expect(status?.textContent).toContain(FEED_STRINGS.mobileUnavailableBody);
    expect(reads).toEqual([]);
  });
}

test("on the web a signed-in feed still opens its source", async () => {
  const reads: string[] = [];
  await mount("web", recordingTcw(reads)).catch(() => undefined);
  expect(reads).toContain("spaceId");
});
