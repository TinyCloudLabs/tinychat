// TC-3195: opening a share link adds nothing by itself. A signed-in account sees who shared what and adds it with
// "Add to Library"; signed out, "Sign in to open" is the request, and the share is added once sign-in finishes.
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { installDom } from "@/test/dom";
import type { OpenedShareLink } from "@/lib/nativeShares/sdk";

const OWNER = "0xd5590000000000000000000000000000000ff412";
const LINK: OpenedShareLink = {
  kind: "recording",
  display: { title: "Customer call: Northwind", recordedAt: "2026-11-16T15:00:00.000Z", durationSeconds: 900, includes: ["transcript"], source: "meeting" },
  token: "tc1:token",
  linkExpiresAt: "2026-12-16T15:00:00.000Z",
  owner: { address: OWNER, chainId: 1, spaceId: `tinycloud:pkh:eip155:1:${OWNER}:default` },
  accessExpiresAt: "2027-11-16T15:00:00.000Z",
};

// The link reader and the claim stand in for the network; every other export is real. The modules are imported
// dynamically so the stand-ins are registered before the surface loads them.
const realSdk = { ...(await import("@/lib/nativeShares/sdk")) };
const realLink = { ...(await import("@/lib/nativeShares/link")) };
const claims: string[] = [];
mock.module("@/lib/nativeShares/sdk", () => ({
  ...realSdk,
  openShareLink: async () => LINK,
  claimShare: async (_tcw: TinyCloudWeb, token: string) => {
    claims.push(token);
    return { ok: false, reason: "failed" };
  },
}));
mock.module("@/lib/nativeShares/link", () => ({ ...realLink, heldShareLink: () => "https://tinycloud.one/s/abc#k=1" }));
afterAll(() => {
  mock.module("@/lib/nativeShares/sdk", () => realSdk);
  mock.module("@/lib/nativeShares/link", () => realLink);
});
const { ShareLinkSurface } = await import("./ShareLinkSurface");

const TCW = { did: "did:pkh:eip155:1:0x1111111111111111111111111111111111111111" } as unknown as TinyCloudWeb;
let restoreDom: (() => void) | undefined;
let root: Root | null = null;
beforeEach(() => {
  restoreDom = installDom();
  claims.length = 0;
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  restoreDom?.();
});

async function mount(tcw: TinyCloudWeb | null, onSignIn: () => void = () => {}) {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const render = async (next: TinyCloudWeb | null) => act(async () => {
    root!.render(<MemoryRouter initialEntries={["/s/abc"]}><ShareLinkSurface tcw={next} state={next ? "ready" : "unauthenticated"} error={null} onSignIn={onSignIn} /></MemoryRouter>);
  });
  await render(tcw);
  return { container, render };
}

function button(container: HTMLElement, label: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll("button")].find((element) => element.textContent === label);
}

describe("ShareLinkSurface", () => {
  test("a signed-in account adds the share only when it taps Add to Library", async () => {
    const { container } = await mount(TCW);
    expect(container.textContent).toContain("0xd559…f412 shared a recording with you");
    expect(claims).toEqual([]);
    await act(async () => button(container, "Add to Library")!.click());
    expect(claims).toEqual(["tc1:token"]);
  });

  test("signed out, Sign in to open is the request: the share is added once sign-in finishes", async () => {
    let signIns = 0;
    const { container, render } = await mount(null, () => signIns++);
    expect(button(container, "Add to Library")).toBeUndefined();
    await act(async () => button(container, "Sign in to open")!.click());
    expect(signIns).toBe(1);
    expect(claims).toEqual([]);
    await render(TCW);
    expect(claims).toEqual(["tc1:token"]);
  });

  test("signing in some other way does not add it", async () => {
    const { container, render } = await mount(null);
    await render(TCW);
    expect(claims).toEqual([]);
    expect(button(container, "Add to Library")).toBeDefined();
  });
});
