import { afterAll, beforeAll, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { SHARE_LINK_COPY } from "@/lib/shareLinkCopy";
import { installDom } from "@/test/dom";

let cleanDom: (() => void) | undefined;

beforeAll(() => {
  cleanDom = installDom();
});
afterAll(() => cleanDom?.());

test("a failed list load never shows the error text in the Settings card", async () => {
  // Dynamic: the share module's web-SDK dependency needs the DOM globals installed in beforeAll.
  const { OwnedShareLinksCard } = await import("./OwnedShareLinks");
  const tcw = {
    kv: {
      list: async () => {
        throw new Error("raw-sdk-failure host.internal:4242");
      },
    },
  } as unknown as TinyCloudWeb;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);

  await act(async () => {
    root.render(<OwnedShareLinksCard tcw={tcw} />);
  });
  // The load rejects immediately; give the effect and its state update a turn to settle.
  await act(async () => {});

  expect(host.textContent).toContain(SHARE_LINK_COPY.listTitle);
  expect(host.textContent).not.toContain("raw-sdk-failure");
  expect(host.textContent).not.toContain("host.internal");
  // A failed load is not "no links": the empty state must not claim it.
  expect(host.textContent).not.toContain(SHARE_LINK_COPY.listEmpty);
  await act(async () => root.unmount());
});
