import { afterAll, beforeAll, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { SHARE_LINK_COPY } from "@/lib/shareLinkCopy";
import { shareIndexKeyFor, snapshotKeyFor } from "@/lib/shareRecords";
import { installDom } from "@/test/dom";

let cleanDom: (() => void) | undefined;

beforeAll(() => {
  cleanDom = installDom();
});
afterAll(() => cleanDom?.());

const SHARE_ID = "11111111-1111-4111-8111-111111111111";

// KV whose list fails until `failList` is cleared; holds one share expiring at `expiresAt`.
function fakeTcw(expiresAt = "2999-01-01T00:00:00.000Z", failList = true) {
  const state = { failList, listCalls: 0 };
  const entry = JSON.stringify({
    shareId: SHARE_ID,
    threadId: "thread-1",
    title: "My chat",
    key: snapshotKeyFor(SHARE_ID),
    cid: "cid-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    expiresAt,
  });
  const tcw = {
    kv: {
      list: async () => {
        state.listCalls++;
        if (state.failList) throw new Error("raw-sdk-failure host.internal:4242");
        return { ok: true, data: { keys: [shareIndexKeyFor(SHARE_ID)] } };
      },
      get: async () => ({ ok: true, data: { data: entry } }),
      delete: async () => ({ ok: true, data: {} }),
    },
  } as unknown as TinyCloudWeb;
  return { tcw, state };
}

async function mountCard(tcw: TinyCloudWeb) {
  // Dynamic: the share module's web-SDK dependency needs the DOM globals installed in beforeAll.
  const { OwnedShareLinksCard } = await import("./OwnedShareLinks");
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<OwnedShareLinksCard tcw={tcw} />);
  });
  // The load settles immediately; give its state update a turn.
  await act(async () => {});
  return { host, root };
}

test("a failed list load shows the fixed line and Try again, never the error text or an empty state", async () => {
  const { tcw } = fakeTcw();
  const { host, root } = await mountCard(tcw);

  expect(host.textContent).toContain(SHARE_LINK_COPY.listTitle);
  expect(host.textContent).toContain(SHARE_LINK_COPY.loadFailed);
  expect([...host.querySelectorAll("button")].map((button) => button.textContent)).toEqual([SHARE_LINK_COPY.retry]);
  expect(host.textContent).not.toContain("raw-sdk-failure");
  expect(host.textContent).not.toContain("host.internal");
  expect(host.textContent).not.toContain(SHARE_LINK_COPY.listEmpty);
  await act(async () => root.unmount());
});

test("Try again reloads the list and shows the links once it succeeds", async () => {
  const { tcw, state } = fakeTcw();
  const { host, root } = await mountCard(tcw);
  const callsAfterFailure = state.listCalls;
  state.failList = false;

  const retry = [...host.querySelectorAll("button")].find((button) => button.textContent === SHARE_LINK_COPY.retry)!;
  await act(async () => {
    retry.click();
  });
  await act(async () => {});

  expect(state.listCalls).toBe(callsAfterFailure + 1);
  expect(host.textContent).toContain("My chat");
  expect(host.textContent).not.toContain(SHARE_LINK_COPY.loadFailed);
  expect(host.textContent).not.toContain(SHARE_LINK_COPY.listEmpty);
  await act(async () => root.unmount());
});

test("each link shows its title and expiry, with no Revoke or create control", async () => {
  const { tcw } = fakeTcw("2999-01-01T00:00:00.000Z", false);
  const { host, root } = await mountCard(tcw);

  expect(host.textContent).toContain("My chat");
  expect(host.textContent).toContain("Expires ");
  expect(host.textContent).toContain(SHARE_LINK_COPY.listDescription);
  expect(host.querySelectorAll("button").length).toBe(0);
  expect(host.textContent).not.toMatch(/revoke|create/i);
  await act(async () => root.unmount());
});

test("a link that has already expired is hidden and the empty state shows", async () => {
  const { tcw } = fakeTcw("2000-01-01T00:00:00.000Z", false);
  const { host, root } = await mountCard(tcw);

  expect(host.textContent).not.toContain("My chat");
  expect(host.textContent).toContain(SHARE_LINK_COPY.listEmpty);
  await act(async () => root.unmount());
});

test("a link that lapses while the card is open disappears on the next render", async () => {
  const realNow = Date.now;
  let offset = 0;
  Date.now = () => realNow() + offset;
  try {
    const { OwnedShareLinksCard } = await import("./OwnedShareLinks");
    const { tcw } = fakeTcw(new Date(realNow() + 60_000).toISOString(), false);
    const { host, root } = await mountCard(tcw);
    expect(host.textContent).toContain("My chat");

    offset = 120_000;
    await act(async () => {
      root.render(<OwnedShareLinksCard tcw={tcw} />);
    });

    expect(host.textContent).not.toContain("My chat");
    expect(host.textContent).toContain(SHARE_LINK_COPY.listEmpty);
    await act(async () => root.unmount());
  } finally {
    Date.now = realNow;
  }
});
