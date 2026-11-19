// TC-3195: the phone app's launch URL stays the same for the whole process. A share link the app was launched with is
// consumed once, by its id: navigating on (which changes `navigate`) or mounting again never goes back to it, so the
// share is claimed once. A link opened while the app runs (`appUrlOpen`) opens each time.
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { installDom } from "@/test/dom";
import { receivedShares } from "@/lib/nativeShares/receivedShares";
import type { OpenedShareLink } from "@/lib/nativeShares/sdk";

const OWNER = "0xd5590000000000000000000000000000000ff412";
const LINK: OpenedShareLink = {
  kind: "recording",
  display: { title: "Standup", recordedAt: "2026-11-16T15:00:00.000Z", durationSeconds: 60, includes: ["transcript"], source: "meeting" },
  token: "tc1:token",
  linkExpiresAt: "2026-12-16T15:00:00.000Z",
  owner: { address: OWNER, chainId: 1, spaceId: `tinycloud:pkh:eip155:1:${OWNER}:default` },
  accessExpiresAt: "2027-11-16T15:00:00.000Z",
  rootCid: "bafyroot",
};
const LAUNCH = "https://tinycloud.one/s/launchid#v=4&k=key&c=bafyroot";

// The native shell, the link reader and the claim stand in for the device and the network; every other export is
// real. The modules are imported dynamically so the stand-ins are registered before the components load them.
let urlOpen: ((event: { url: string }) => void) | null = null;
const realCapacitorApp = { ...(await import("@capacitor/app")) };
mock.module("@capacitor/app", () => ({
  ...realCapacitorApp,
  App: {
    getLaunchUrl: async () => ({ url: LAUNCH }),
    addListener: async (_event: string, listener: (event: { url: string }) => void) => {
      urlOpen = listener;
      return { remove: async () => { urlOpen = null; } };
    },
  },
}));
const realSdk = { ...(await import("@/lib/nativeShares/sdk")) };
const claims: string[] = [];
mock.module("@/lib/nativeShares/sdk", () => ({
  ...realSdk,
  openShareLink: async () => LINK,
  claimShare: async (_tcw: TinyCloudWeb, token: string) => {
    claims.push(token);
    return { ok: true, share: { delegation: "{}", rootCid: "bafyroot", paths: ["xyz.tinycloud.tinychat/t/1"], accessExpiresAt: LINK.accessExpiresAt } };
  },
}));
afterAll(() => {
  mock.module("@capacitor/app", () => realCapacitorApp);
  mock.module("@/lib/nativeShares/sdk", () => realSdk);
});
const { ShareAppUrlListener } = await import("./ShareAppUrlListener");
const { ShareLinkSurface } = await import("./ShareLinkSurface");

const space = new Map<string, string>();
const TCW = {
  did: "did:pkh:eip155:1:0x00000000000000000000000000000000000000b1",
  kv: {
    list: async ({ path }: { path: string }) => ({ ok: true, data: { keys: [...space.keys()].filter((key) => key.startsWith(path)) } }),
    get: async (key: string) => (space.has(key) ? { ok: true, data: { data: space.get(key) } } : { ok: false, error: { code: "KV_NOT_FOUND", message: "x" } }),
    put: async (key: string, value: string) => {
      space.set(key, value);
      return { ok: true, data: undefined };
    },
  },
} as unknown as TinyCloudWeb;

let restoreDom: (() => void) | undefined;
let root: Root | null = null;
let container: HTMLElement;
beforeEach(() => {
  restoreDom = installDom();
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  restoreDom?.();
});
afterAll(() => receivedShares.bind(null));

const visits: string[] = [];
let goTo: ((path: string) => void) | null = null;
function Recorder() {
  const location = useLocation();
  goTo = useNavigate();
  visits.push(location.pathname);
  return null;
}

async function mount() {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <MemoryRouter initialEntries={["/chat"]}>
        <Routes>
          <Route path="/s/:id" element={<ShareLinkSurface tcw={TCW} state="ready" error={null} onSignIn={() => {}} />} />
          <Route path="*" element={null} />
        </Routes>
        <ShareAppUrlListener />
        <Recorder />
      </MemoryRouter>,
    );
  });
}

const shareVisits = (id: string) => visits.filter((path) => path === `/s/${id}`).length;

describe("ShareAppUrlListener", () => {
  test("the launch link opens once and its share is claimed once, however often the app navigates or mounts again", async () => {
    await mount();
    expect(visits.at(-1)).toBe("/s/launchid");
    await act(async () => [...container.querySelectorAll("button")].find((button) => button.textContent === "Add to Library")!.click());
    expect(claims).toEqual(["tc1:token"]);
    for (const path of ["/chat", "/chat/capture", "/chat"]) await act(async () => goTo!(path));
    await act(async () => root!.unmount());
    root = null;
    await mount();
    await act(async () => goTo!("/chat/capture"));
    expect(shareVisits("launchid")).toBe(1);
    expect(claims).toEqual(["tc1:token"]);
    expect(visits.at(-1)).toBe("/chat/capture");
  });

  test("a link opened while the app runs opens each time", async () => {
    await mount();
    const before = shareVisits("second");
    await act(async () => urlOpen!({ url: "https://tinycloud.one/s/second#v=4&k=key&c=bafyroot" }));
    expect(visits.at(-1)).toBe("/s/second");
    await act(async () => goTo!("/chat"));
    await act(async () => urlOpen!({ url: "https://tinycloud.one/s/second#v=4&k=key&c=bafyroot" }));
    expect(visits.at(-1)).toBe("/s/second");
    expect(shareVisits("second") - before).toBe(2);
    expect(shareVisits("launchid")).toBe(1);
  });
});
