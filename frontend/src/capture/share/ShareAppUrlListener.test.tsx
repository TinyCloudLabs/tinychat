// TC-3195: the phone app's launch URL stays the same for the whole process. A share link it was launched with opens
// once; navigating on (which changes `navigate`) or mounting again never goes back to it. A link opened while the app
// runs (`appUrlOpen`) opens each time.
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";

import { installDom } from "@/test/dom";

const LAUNCH = "https://tinycloud.one/s/launchid#v=4&k=key&c=bafyroot";
let launchReads = 0;
let urlOpen: ((event: { url: string }) => void) | null = null;
// The plugin stands in for the native shell. It is imported dynamically so the stand-in is registered first.
const realCapacitorApp = { ...(await import("@capacitor/app")) };
mock.module("@capacitor/app", () => ({
  ...realCapacitorApp,
  App: {
    getLaunchUrl: async () => {
      launchReads++;
      return { url: LAUNCH };
    },
    addListener: async (_event: string, listener: (event: { url: string }) => void) => {
      urlOpen = listener;
      return { remove: async () => { urlOpen = null; } };
    },
  },
}));
afterAll(() => mock.module("@capacitor/app", () => realCapacitorApp));
const { ShareAppUrlListener } = await import("./ShareAppUrlListener");

let restoreDom: (() => void) | undefined;
let root: Root | null = null;
beforeEach(() => {
  restoreDom = installDom();
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  restoreDom?.();
});

const visits: string[] = [];
let goTo: ((path: string) => void) | null = null;
function Recorder() {
  const location = useLocation();
  const navigate = useNavigate();
  goTo = navigate;
  visits.push(location.pathname);
  return null;
}

async function mount() {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<MemoryRouter initialEntries={["/chat"]}><ShareAppUrlListener /><Recorder /></MemoryRouter>);
  });
}

describe("ShareAppUrlListener", () => {
  test("opens the launch link once, however often the app navigates or mounts again", async () => {
    await mount();
    expect(visits.at(-1)).toBe("/s/launchid");
    for (const path of ["/chat", "/chat/capture", "/chat"]) await act(async () => goTo!(path));
    await act(async () => root!.unmount());
    root = null;
    await mount();
    await act(async () => goTo!("/chat/capture"));
    expect(launchReads).toBe(1);
    expect(visits.filter((path) => path === "/s/launchid")).toHaveLength(1);
    expect(visits.at(-1)).toBe("/chat/capture");
  });

  test("a link opened while the app runs opens each time", async () => {
    await mount();
    await act(async () => urlOpen!({ url: "https://tinycloud.one/s/second#v=4&k=key&c=bafyroot" }));
    expect(visits.at(-1)).toBe("/s/second");
    await act(async () => goTo!("/chat"));
    await act(async () => urlOpen!({ url: "https://tinycloud.one/s/second#v=4&k=key&c=bafyroot" }));
    expect(visits.at(-1)).toBe("/s/second");
    expect(launchReads).toBe(1);
  });
});
