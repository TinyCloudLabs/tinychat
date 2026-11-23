// One's app screen frames only what the frame allowlist (registry.ts `framedApp`, with its ceilings) knows, even for an
// app the new navigation lists. Here the list gains a framed-looking app that `framedApp` doesn't know: its screen
// must not frame it. Run by src/apps/oneAppScreen.allowlist.test.ts in its own process, because it replaces the
// registry module (mock.module would leak into every other test file in one process).
import { afterAll, describe, expect, mock, test } from "bun:test";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import type { Window as HappyWindow } from "happy-dom";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";

import { installDom } from "@/test/dom";

afterAll(installDom());
// installDom's window is happy-dom's. One's own origin, where One frames the apps it frames.
const page = window as unknown as HappyWindow;
page.happyDOM.setURL("https://tinycloud.one/chat/apps");

// Dynamic imports: the registry must be read before it is replaced, and FramedAppScreen loaded after.
const registry = await import("@/apps/registry");
const { framedApp, framesAppHere, oneAppsFor } = registry;
const explorer = framedApp("xyz.tinycloud.explorer")!;
const GHOST = "xyz.tinycloud.ghost";
const ghost = { ...explorer, id: GHOST, name: "Ghost" };
mock.module("@/apps/registry", () => ({
  ...registry,
  oneAppsFor: (platform: string, oneNav?: boolean) => [...oneAppsFor(platform, oneNav), ghost],
}));
const { OneAppScreen } = await import("@/apps/FramedAppScreen");

const tcw = {
  session: () => ({ address: "0x00000000000000000000000000000000000000a1", chainId: 1, sessionKey: "session-key" }),
} as unknown as TinyCloudWeb;
const render = (appId: string) =>
  renderToStaticMarkup(
    <MemoryRouter>
      <OneAppScreen appId={appId} tcw={tcw} accountDid={null} fallback={<p>fallback</p>} />
    </MemoryRouter>,
  );

describe("the frame allowlist decides what One frames", () => {
  test("an app the allowlist frames is framed here (the check below can see a frame)", () => {
    expect(framesAppHere(explorer, window.location.origin)).toBe(true);
    expect(render(explorer.id)).toContain('data-testid="one-app-frame"');
  });

  test("an app only the new navigation lists, unknown to framedApp, is not framed: it opens on its own", () => {
    expect(framedApp(GHOST)).toBeUndefined();
    const markup = render(GHOST);
    expect(markup).toContain('data-testid="one-app-screen"');
    expect(markup).not.toContain('data-testid="one-app-frame"');
    expect(markup).not.toContain("<iframe");
  });
});
