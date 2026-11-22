// One's new navigation (TC-3650) with the flags passed in, so it runs in any build: the Apps grid, the phone's pill,
// the open app's bar on every app screen, the screen for apps One can't frame here, and Add an app (its own flag). The
// build flags' own wiring is test-fixtures/oneNav.*.fixture.tsx (src/shell/oneNav.flag.test.ts).
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, useLocation } from "react-router-dom";

import { installDom } from "@/test/dom";
import { APPS_OPENS_NEW_TAB, APPS_PIN, APPS_UNPIN, appPinnedToast, appUnpinnedToast } from "@/lib/homeStrings";
import { PlatformContext, type AppPlatform } from "@/lib/platform";
import type { SizeClassState } from "@/lib/sizeClass";
import { AppShellView } from "@/shell/AppShell";
import { PATHS, screenFor } from "@/shell/routes";
import { AppsGrid, LONG_PRESS_MS } from "@/home/AppsGrid";
import type { PinId } from "@/shell/navPins";
import { gridTiles, pinnedFirst } from "@/home/AppsPage";
import { AddAppPage } from "./AddAppPage";
import { ADD_APP_PROMPT } from "./addAppPrompt";
import { AppBar } from "./AppBar";
import { OneAppScreen } from "./FramedAppScreen";
import { appRoute, appUrl, oneAppsFor } from "./registry";
import {
  ADD_APP_TITLE,
  APP_NAMES,
  CONNECTORS_NAME,
  COPIED,
  COPY_FAILED,
  COPY_PROMPT,
  MAIN_TAB_LABEL,
  PILL_LABELS,
  opensSeparatelyTitle,
  openSeparately,
  pinApp,
  unpinApp,
} from "./strings";

const restoreDom = installDom({ localStorage: memoryStorage() });
afterAll(restoreDom);

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key); },
    setItem: (key, value) => { values.set(key, String(value)); },
  };
}

const ACCOUNT = "did:pkh:eip155:1:0x00000000000000000000000000000000000000a1";
const UPRIGHT: SizeClassState = { size: "compact", land: false };
const WEB_ORDER = ["capture", "xyz.tinycloud.secrets", "xyz.tinycloud.opencredentials", "xyz.tinycloud.explorer", "xyz.tinycloud.account", "xyz.tinycloud.courier", "xyz.tinycloud.share"] as const;

const ssr = (node: ReactNode, path: string, platform: AppPlatform = "web") =>
  renderToStaticMarkup(
    <PlatformContext.Provider value={platform}>
      <MemoryRouter initialEntries={[path]}>{node}</MemoryRouter>
    </PlatformContext.Provider>,
  );

const shell = (path: string, sizeClass: SizeClassState = UPRIGHT) =>
  ssr(
    <AppShellView
      screen={screenFor(path, true)}
      platform="web"
      pendingMeetings={2}
      chat={<p>chat-slot</p>}
      capture={<p>capture-slot</p>}
      connectors={<p>connectors-slot</p>}
      settings={<p>settings-slot</p>}
      about={<p>about-slot</p>}
      feed={<p>feed-slot</p>}
      apps={<p>apps-slot</p>}
      accountDid={ACCOUNT}
      pinOptions={{ pins: [], apps: [], oneNav: true }}
      sizeClass={sizeClass}
      captureMounted
    />,
    path,
  );

/** Every `<a …>` opening tag inside the element that starts at `marker`. */
function links(markup: string, marker: string, close: string): string[] {
  const start = markup.indexOf(marker);
  expect(start).toBeGreaterThan(-1);
  return [...markup.slice(start, markup.indexOf(close, start)).matchAll(/<a [^>]*>/g)].map((match) => match[0]);
}
const attr = (tag: string, name: string) => new RegExp(`${name}="([^"]*)"`).exec(tag)?.[1];

describe("the Apps grid", () => {
  test("lists the apps in order, then Connectors, each at its screen in One; iOS leaves Account out", () => {
    const web = gridTiles(0, oneAppsFor("web", true));
    expect(web.map((tile) => tile.name)).toEqual([...WEB_ORDER.map((id) => APP_NAMES[id]), CONNECTORS_NAME]);
    expect(web.map((tile) => tile.path)).toEqual([...oneAppsFor("web", true).map(appRoute), PATHS.connectors]);
    expect(web[0]!.path).toBe(PATHS.capture);
    const ios = gridTiles(0, oneAppsFor("ios", true)).map((tile) => tile.name);
    expect(ios).toEqual(web.map((tile) => tile.name).filter((name) => name !== APP_NAMES["xyz.tinycloud.account"]));
  });

  const noop = () => {};

  test("with Add an app on, ends with it, which no one can pin; each app tile has its own Pin, and in the phone app no tile leaves One", () => {
    const tiles = gridTiles(0, oneAppsFor("web", true));
    const markup = ssr(<AppsGrid tiles={tiles} pins={["app:xyz.tinycloud.explorer"]} canPin onPin={noop} onUnpin={noop} addApp />, PATHS.apps);
    const anchors = links(markup, "<ul", "</ul>");
    expect(anchors).toHaveLength(tiles.length + 1);
    expect(anchors.map((tag) => attr(tag, "href"))).toEqual([...tiles.map((tile) => tile.path), PATHS.addApp]);
    expect(markup).toContain(ADD_APP_TITLE);
    for (const tag of anchors) expect(tag).not.toContain("target=");
    const pinButtons = [...markup.matchAll(/<button [^>]*aria-label="([^"]*)"/g)].map((match) => match[1]);
    expect(pinButtons).toEqual(tiles.map((tile) => (tile.pin === "app:xyz.tinycloud.explorer" ? unpinApp(tile.name) : pinApp(tile.name))));
    expect(ssr(<AppsGrid tiles={tiles} pins={[]} canPin={false} onPin={noop} onUnpin={noop} addApp />, PATHS.apps)).not.toContain("<button");
  });

  test("with Add an app off, the grid ends with Connectors and nothing leads to it", () => {
    const tiles = gridTiles(0, oneAppsFor("web", true));
    const markup = ssr(<AppsGrid tiles={tiles} pins={[]} canPin onPin={noop} onUnpin={noop} addApp={false} />, PATHS.apps);
    expect(links(markup, "<ul", "</ul>").map((tag) => attr(tag, "href"))).toEqual(tiles.map((tile) => tile.path));
    expect(markup).not.toContain(ADD_APP_TITLE);
  });

  test("on the web an app One can't frame here opens its own page in a new tab straight from its tile, marked, with no screen between", () => {
    const apps = oneAppsFor("web", true);
    const tiles = gridTiles(0, apps, "https://tinycloud.one");
    const anchors = links(ssr(<AppsGrid tiles={tiles} pins={[]} canPin onPin={noop} onUnpin={noop} addApp={false} />, PATHS.apps), "<ul", "</ul>");
    const framedHere: readonly string[] = ["xyz.tinycloud.explorer", "xyz.tinycloud.account", "xyz.tinycloud.courier"];
    apps.forEach((app, index) => {
      const tag = anchors[index]!;
      if (app.kind === "native" || framedHere.includes(app.id)) {
        expect(attr(tag, "href")).toBe(appRoute(app));
        expect(tag).not.toContain("target=");
      } else {
        expect(attr(tag, "href")).toBe(appUrl(app));
        expect(tag).toContain('target="_blank"');
        expect(tag).toContain('rel="noopener noreferrer"');
      }
    });
    expect(apps.filter((app) => app.kind !== "native" && !framedHere.includes(app.id)).map((app) => app.id)).toEqual([
      "xyz.tinycloud.secrets",
      "xyz.tinycloud.opencredentials",
      "xyz.tinycloud.share",
    ]);
    // Each opens-out tile says so to a screen reader and carries the ↗ mark; the others don't.
    const markup = ssr(<AppsGrid tiles={tiles} pins={[]} canPin={false} onPin={noop} onUnpin={noop} addApp={false} />, PATHS.apps);
    expect(markup.split(`(${APPS_OPENS_NEW_TAB})`)).toHaveLength(4);
    expect(markup.split("lucide-arrow-up-right")).toHaveLength(4);
    // The phone app has no tabs: every tile opens its screen in One.
    expect(gridTiles(0, oneAppsFor("ios", true), null).every((tile) => tile.newTab === undefined)).toBe(true);
  });

  test("on a phone, pinned apps come first in grid order, then the rest in theirs", () => {
    const tiles = gridTiles(0, oneAppsFor("web", true));
    const order = pinnedFirst(tiles, ["connectors", "app:xyz.tinycloud.explorer"]).map((tile) => tile.pin);
    expect(order.slice(0, 2)).toEqual(["app:xyz.tinycloud.explorer", "connectors"]);
    expect(order.slice(2)).toEqual(tiles.map((tile) => tile.pin).filter((pin) => pin !== "connectors" && pin !== "app:xyz.tinycloud.explorer"));
    expect(pinnedFirst(tiles, []).map((tile) => tile.pin)).toEqual(tiles.map((tile) => tile.pin));
  });

  test("with Add an app off, its address is no screen of its own: it is an unknown app, and shows what an unknown app shows", () => {
    const screen = screenFor(PATHS.addApp, false);
    expect(screen.id).not.toBe("addApp");
    expect(screen.appId).toBe("add");
    expect(ssr(<OneAppScreen appId={screen.appId!} tcw={null} accountDid={ACCOUNT} fallback={<p>fallback</p>} />, PATHS.addApp)).toBe("<p>fallback</p>");
    expect(screenFor(PATHS.addApp, true).id).toBe("addApp");
  });
});

describe("the phone's pill", () => {
  const pill = (path: string) => links(shell(path), 'data-testid="pill-bar"', "</nav>");

  test("holds four icon items, main tab, Chat, Apps and You, each with its spoken label, in place of the tab bar", () => {
    const markup = shell(PATHS.chat);
    expect(markup).not.toContain('data-testid="tab-bar"');
    expect(pill(PATHS.chat).map((tag) => attr(tag, "aria-label")?.split(",")[0])).toEqual([MAIN_TAB_LABEL, PILL_LABELS.chat, PILL_LABELS.apps, PILL_LABELS.you]);
    expect(pill(PATHS.chat).map((tag) => attr(tag, "href"))).toEqual([PATHS.feed, PATHS.chat, PATHS.apps, PATHS.settings]);
    // Apps is a 2×2 grid of squares.
    const bar = markup.slice(markup.indexOf('data-testid="pill-bar"'));
    expect(bar.slice(bar.indexOf(`href="${PATHS.apps}"`), bar.indexOf(`href="${PATHS.settings}"`))).toContain("lucide-layout-grid");
  });

  test("the current item sits in the filled pill", () => {
    const current = pill(PATHS.chat).filter((tag) => tag.includes('aria-current="page"'));
    expect(current).toHaveLength(1);
    expect(attr(current[0]!, "class")).toContain("tc-pill-current");
    expect(pill(PATHS.chat).filter((tag) => attr(tag, "class")?.includes("tc-pill-current"))).toHaveLength(1);
  });

  test("Apps carries Connectors' waiting meetings", () => {
    expect(attr(pill(PATHS.chat)[2]!, "aria-label")).not.toBe(PILL_LABELS.apps);
  });

  test("You is current on Settings, Apps on Add an app and on an app; How it works hides the pill", () => {
    const current = (path: string) => pill(path).flatMap((tag) => (tag.includes('aria-current="page"') ? [attr(tag, "aria-label")?.split(",")[0]] : []));
    expect(current(PATHS.settings)).toEqual([PILL_LABELS.you]);
    expect(current(PATHS.addApp)).toEqual([PILL_LABELS.apps]);
    expect(current(appRoute(oneAppsFor("web", true)[1]!))).toEqual([PILL_LABELS.apps]);
    expect(current(PATHS.capture)).toEqual([PILL_LABELS.apps]);
    expect(shell(PATHS.about)).not.toContain('data-testid="pill-bar"');
  });

  test("wider screens keep their navigation and never offer Add an app there; the sidebar's Apps is the grid and Settings is You", () => {
    const wide = shell(PATHS.chat, { size: "expanded", land: false });
    expect(wide).not.toContain('data-testid="pill-bar"');
    expect(wide).toContain('data-testid="sidebar"');
    expect(wide).not.toContain(ADD_APP_TITLE);
    expect(wide).toContain(`>${MAIN_TAB_LABEL}<`);
    const sidebarLinks = links(wide, 'data-testid="sidebar"', "</nav>");
    const rowOf = (href: string) => {
      const tag = sidebarLinks.find((link) => attr(link, "href") === href)!;
      return wide.slice(wide.indexOf(tag), wide.indexOf("</a>", wide.indexOf(tag)));
    };
    expect(rowOf(PATHS.apps)).toContain("lucide-layout-grid");
    const row = rowOf(PATHS.settings);
    expect(row).toContain(`>${PILL_LABELS.you}<`);
    expect(row).toContain("lucide-user-round");
    expect(row).not.toContain(">Settings<");
  });
});

describe("the open app's bar", () => {
  test("every grid tile reaches a screen with the bar and Pin", () => {
    for (const app of oneAppsFor("web", true)) {
      const markup = app.kind === "native"
        ? shell(appRoute(app))
        : ssr(<OneAppScreen appId={app.id} tcw={null} accountDid={ACCOUNT} fallback={<p>fallback</p>} />, appRoute(app));
      expect(markup).toContain('data-testid="app-bar"');
      expect(markup).toContain(`aria-label="${pinApp(app.name)}"`);
    }
    expect(shell(PATHS.connectors)).toContain(`aria-label="${pinApp(CONNECTORS_NAME)}"`);
  });

  test("Recording and Connectors are One's own: the bar has no new-tab link", () => {
    for (const path of [PATHS.capture, PATHS.connectors]) {
      const bar = shell(path);
      expect(links(bar, 'data-testid="app-bar"', "</header>")).toEqual([]);
    }
  });

  test("an app One can't frame here opens on its own, from the bar or the screen, in a new tab; the screen says only that", () => {
    for (const app of oneAppsFor("web", true)) {
      if (app.kind === "native") continue;
      const markup = ssr(<OneAppScreen appId={app.id} tcw={null} accountDid={ACCOUNT} fallback={<p>fallback</p>} />, appRoute(app));
      expect(markup).toContain(opensSeparatelyTitle(app.name, false).replaceAll("'", "&#x27;"));
      const screen = markup.slice(markup.indexOf("</header>"));
      expect(screen).not.toMatch(/<p[ >]/);
      expect(screen.replace(/<[^>]*>/g, "")).toBe(`${opensSeparatelyTitle(app.name, false)}${openSeparately(app.name, false)}`.replaceAll("'", "&#x27;"));
      const anchors = [...markup.matchAll(/<a [^>]*>/g)].map((match) => match[0]);
      expect(anchors).toHaveLength(2);
      for (const tag of anchors) {
        expect(attr(tag, "href")).toBe(appUrl(app));
        expect(tag).toContain('target="_blank"');
        expect(tag).toContain('rel="noopener noreferrer"');
      }
    }
  });

  test("on a phone it opens on its own, not in a new tab", () => {
    const share = oneAppsFor("ios", true).find((app) => app.id === "xyz.tinycloud.share")!;
    const markup = ssr(<OneAppScreen appId={share.id} tcw={null} accountDid={ACCOUNT} fallback={null} />, appRoute(share), "ios");
    expect(markup).toContain(opensSeparatelyTitle(share.name, true));
    expect(markup).toContain(openSeparately(share.name, true));
  });
});

describe("mounted", () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    localStorage.clear();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });
  const mount = (node: ReactNode) => act(() => root.render(<MemoryRouter>{node}</MemoryRouter>));
  const click = async (button: Element) => {
    await act(async () => {
      button.dispatchEvent(new window.MouseEvent("click", { bubbles: true }) as unknown as Event);
    });
  };

  test("Pin in the bar, labelled Pin or Unpin, pins and unpins the app, says so, and survives a remount", async () => {
    const bar = <AppBar name={APP_NAMES["xyz.tinycloud.explorer"]} glyph="explorer" accountDid={ACCOUNT} pin="app:xyz.tinycloud.explorer" url="https://explorer.tinycloud.xyz/" />;
    mount(bar);
    const name = APP_NAMES["xyz.tinycloud.explorer"];
    const toggle = () => host.querySelector("button[aria-pressed]")!;
    expect(toggle().getAttribute("aria-pressed")).toBe("false");
    expect(toggle().getAttribute("aria-label")).toBe(pinApp(name));
    expect(toggle().textContent).toBe(APPS_PIN);
    await click(toggle());
    expect(toggle().getAttribute("aria-pressed")).toBe("true");
    expect(toggle().getAttribute("aria-label")).toBe(unpinApp(name));
    expect(toggle().textContent).toBe(APPS_UNPIN);
    expect(host.querySelector('[role="status"]')!.textContent).toBe(appPinnedToast(name));
    act(() => root.unmount());
    root = createRoot(host);
    mount(bar);
    expect(toggle().getAttribute("aria-pressed")).toBe("true");
    await click(toggle());
    expect(toggle().getAttribute("aria-pressed")).toBe("false");
    expect(host.querySelector('[role="status"]')!.textContent).toBe(appUnpinnedToast(name));
  });

  describe("pinning from the grid", () => {
    const explorer = APP_NAMES["xyz.tinycloud.explorer"];
    const calls: string[] = [];
    function Grid() {
      const [pins, setPins] = useState<PinId[]>([]);
      return (
        <>
          <AppsGrid
            tiles={gridTiles(0, oneAppsFor("web", true))}
            pins={pins}
            canPin
            onPin={(pin) => { calls.push(`pin ${pin}`); setPins((current) => [...current, pin]); }}
            onUnpin={(pin) => { calls.push(`unpin ${pin}`); setPins((current) => current.filter((entry) => entry !== pin)); }}
            addApp={false}
          />
          <Where />
        </>
      );
    }
    function Where() {
      return <output data-testid="where">{useLocation().pathname}</output>;
    }
    const where = () => host.querySelector('[data-testid="where"]')!.textContent;
    const explorerRoute = appRoute(oneAppsFor("web", true).find((app) => app.id === "xyz.tinycloud.explorer")!);
    const tile = () => [...host.querySelectorAll("ul a")].find((anchor) => anchor.textContent?.startsWith(explorer))!;
    /** A press of `holdMs` then the tap that ends it; returns where One is afterwards. */
    const press = async (pointerType: string, holdMs: number) => {
      await act(async () => {
        tile().dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true, pointerType, clientX: 10, clientY: 10 }) as unknown as Event);
        await Bun.sleep(holdMs);
        tile().dispatchEvent(new window.PointerEvent("pointerup", { bubbles: true, pointerType, clientX: 10, clientY: 10 }) as unknown as Event);
      });
      await act(async () => {
        tile().dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }) as unknown as Event);
      });
      return where();
    };
    beforeEach(() => {
      calls.length = 0;
    });

    test("a long press on a phone pins the app, says so, and the press opens nothing; again unpins it", async () => {
      mount(<Grid />);
      expect(await press("touch", LONG_PRESS_MS + 80)).toBe("/");
      expect(calls).toEqual(["pin app:xyz.tinycloud.explorer"]);
      expect(host.querySelector('[role="status"]')!.textContent).toBe(appPinnedToast(explorer));
      expect(tile().hasAttribute("data-pinned")).toBe(true);
      expect(await press("touch", LONG_PRESS_MS + 80)).toBe("/");
      expect(calls).toEqual(["pin app:xyz.tinycloud.explorer", "unpin app:xyz.tinycloud.explorer"]);
      expect(host.querySelector('[role="status"]')!.textContent).toBe(appUnpinnedToast(explorer));
    });

    test("a short tap opens the app and pins nothing", async () => {
      mount(<Grid />);
      expect(await press("touch", 60)).toBe(explorerRoute);
      expect(calls).toEqual([]);
    });

    test("a mouse held down never pins; its click opens the app", async () => {
      mount(<Grid />);
      expect(await press("mouse", LONG_PRESS_MS + 80)).toBe(explorerRoute);
      expect(calls).toEqual([]);
    });

    test("the tile's Pin button (under a pointer) pins and unpins, and says so", async () => {
      mount(<Grid />);
      const button = () => host.querySelector(`button[aria-label="${pinApp(explorer)}"], button[aria-label="${unpinApp(explorer)}"]`)!;
      await click(button());
      expect(button().getAttribute("aria-pressed")).toBe("true");
      expect(host.querySelector('[role="status"]')!.textContent).toBe(appPinnedToast(explorer));
      await click(button());
      expect(calls).toEqual(["pin app:xyz.tinycloud.explorer", "unpin app:xyz.tinycloud.explorer"]);
    });
  });

  describe("Add an app", () => {
    const prompt = ADD_APP_PROMPT;
    const setClipboard = (writeText: (text: string) => Promise<void>) =>
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const copyButton = () => [...host.querySelectorAll("button")].find((button) => button.textContent === COPY_PROMPT || button.textContent === COPIED)!;

    test("shows the prompt read-only and copies it exactly", async () => {
      const copied: string[] = [];
      setClipboard(async (text) => { copied.push(text); });
      mount(<AddAppPage />);
      const field = host.querySelector("textarea")!;
      expect(field.hasAttribute("readonly")).toBe(true);
      expect(field.value).toBe(prompt);
      expect(host.querySelector("h1")!.textContent).toContain(ADD_APP_TITLE);
      expect([...host.querySelectorAll("button")].map((button) => button.textContent)).toEqual([COPY_PROMPT]);
      await click(copyButton());
      expect(copied).toEqual([prompt]);
      expect(copyButton().textContent).toBe(COPIED);
    });

    test("says how to copy by hand when the clipboard refuses", async () => {
      setClipboard(() => Promise.reject(new Error("denied")));
      mount(<AddAppPage />);
      await click(copyButton());
      expect(host.querySelector('[role="status"]')!.textContent).toBe(COPY_FAILED);
      expect(copyButton().textContent).toBe(COPY_PROMPT);
    });
  });
});
