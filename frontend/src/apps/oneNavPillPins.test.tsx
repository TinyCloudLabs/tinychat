// One's new navigation (TC-3650): what the account pinned shows in the phone's pill, after Apps and before You.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";

import { PlatformContext } from "@/lib/platform";
import type { SizeClassState } from "@/lib/sizeClass";
import { AppShellView } from "@/shell/AppShell";
import type { NavApp } from "@/shell/navItems";
import type { PinId } from "@/shell/navPins";
import { PATHS, screenFor } from "@/shell/routes";
import { MAIN_TAB_LABEL, PILL_LABELS } from "./strings";

const UPRIGHT: SizeClassState = { size: "compact", land: false };
const APPS: readonly NavApp[] = [
  { id: "xyz.tinycloud.explorer", name: "Explorer", target: { kind: "route", path: "/chat/apps/xyz.tinycloud.explorer" } },
  { id: "xyz.tinycloud.share", name: "Share", target: { kind: "route", path: "/chat/apps/xyz.tinycloud.share" } },
  { id: "xyz.tinycloud.secrets", name: "Secrets", target: { kind: "route", path: "/chat/apps/xyz.tinycloud.secrets" } },
];

function pill(path: string, pins: readonly PinId[], pendingMeetings = 0): string[] {
  const markup = renderToStaticMarkup(
    <PlatformContext.Provider value="web">
      <MemoryRouter initialEntries={[path]}>
        <AppShellView
          screen={screenFor(path, true)}
          platform="web"
          pendingMeetings={pendingMeetings}
          chat={<p>chat</p>}
          capture={<p>capture</p>}
          connectors={<p>connectors</p>}
          settings={<p>settings</p>}
          feed={<p>feed</p>}
          apps={<p>apps</p>}
          accountDid="did:pkh:eip155:1:0x00000000000000000000000000000000000000a1"
          pinOptions={{ pins, apps: APPS, oneNav: true }}
          sizeClass={UPRIGHT}
          captureMounted
        />
      </MemoryRouter>
    </PlatformContext.Provider>,
  );
  const start = markup.indexOf('data-testid="pill-bar"');
  expect(start).toBeGreaterThan(-1);
  return [...markup.slice(start, markup.indexOf("</nav>", start)).matchAll(/<a [^>]*>/g)].map((match) => match[0]);
}
const attr = (tag: string, name: string) => new RegExp(`${name}="([^"]*)"`).exec(tag)?.[1];
const labels = (tags: string[]) => tags.map((tag) => attr(tag, "aria-label")?.split(/,| —/)[0]);

describe("the phone's pill with pins", () => {
  test("shows the first two pins, in pin order, between Apps and You", () => {
    const tags = pill(PATHS.chat, ["app:xyz.tinycloud.share", "connectors", "app:xyz.tinycloud.explorer"]);
    expect(labels(tags)).toEqual([MAIN_TAB_LABEL, PILL_LABELS.chat, PILL_LABELS.apps, "Share", "Connectors", PILL_LABELS.you]);
    expect(tags.map((tag) => attr(tag, "href"))).toEqual([PATHS.feed, PATHS.chat, PATHS.apps, "/chat/apps/xyz.tinycloud.share", PATHS.connectors, PATHS.settings]);
  });

  test("a pinned app is current on its own screen; an unpinned one marks Apps", () => {
    const current = (path: string) => labels(pill(path, ["app:xyz.tinycloud.share"]).filter((tag) => tag.includes('aria-current="page"')));
    expect(current("/chat/apps/xyz.tinycloud.share")).toEqual(["Share"]);
    expect(current("/chat/apps/xyz.tinycloud.explorer")).toEqual([PILL_LABELS.apps]);
  });

  test("waiting meetings sit on Connectors when it is in the pill, else on Apps", () => {
    const badged = (pins: readonly PinId[]) => labels(pill(PATHS.chat, pins, 2).filter((tag) => (attr(tag, "aria-label") ?? "").includes("waiting")));
    expect(badged(["connectors"])).toEqual(["Connectors"]);
    expect(badged([])).toEqual([PILL_LABELS.apps]);
  });
});
