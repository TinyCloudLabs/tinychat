// One's new navigation (TC-3650) with the flag passed in, so it runs in any build: the Apps grid, the phone's pill, the
// open app's bar on every app screen, the screen for apps One can't frame here, and Add an app. The build flag's own
// wiring is test-fixtures/oneNav.*.fixture.tsx (src/shell/oneNav.flag.test.ts).
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";

import { installDom } from "@/test/dom";
import { appPinnedToast, appUnpinnedToast } from "@/lib/homeStrings";
import { PlatformContext, type AppPlatform } from "@/lib/platform";
import type { SizeClassState } from "@/lib/sizeClass";
import { AppShellView } from "@/shell/AppShell";
import { PATHS, screenFor } from "@/shell/routes";
import { AppsGrid } from "@/home/AppsGrid";
import { gridTiles } from "@/home/AppsPage";
import { AddAppPage } from "./AddAppPage";
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
  opensSeparatelyLine,
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
      screen={screenFor(path)}
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

  test("ends with Add an app, which no one can pin; tiles carry no Pin control and never leave One", () => {
    const tiles = gridTiles(0, oneAppsFor("web", true));
    const markup = ssr(<AppsGrid tiles={tiles} pins={["app:xyz.tinycloud.explorer"]} canPin />, PATHS.apps);
    const anchors = links(markup, "<ul", "</ul>");
    expect(anchors).toHaveLength(tiles.length + 1);
    expect(anchors.map((tag) => attr(tag, "href"))).toEqual([...tiles.map((tile) => tile.path), PATHS.addApp]);
    expect(markup).toContain(ADD_APP_TITLE);
    for (const tag of anchors) expect(tag).not.toContain("target=");
    expect(markup).not.toContain("<button");
  });
});

describe("the phone's pill", () => {
  const pill = (path: string) => links(shell(path), 'data-testid="pill-bar"', "</nav>");

  test("holds four icon items, main tab, Chat, Apps and You, in place of the tab bar", () => {
    const markup = shell(PATHS.chat);
    expect(markup).not.toContain('data-testid="tab-bar"');
    expect(pill(PATHS.chat).map((tag) => attr(tag, "aria-label")?.split(",")[0])).toEqual([MAIN_TAB_LABEL, PILL_LABELS.chat, PILL_LABELS.apps, PILL_LABELS.you]);
    expect(pill(PATHS.chat).map((tag) => attr(tag, "href"))).toEqual([PATHS.feed, PATHS.chat, PATHS.apps, PATHS.settings]);
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

  test("wider screens keep their navigation and never offer Add an app there", () => {
    const wide = shell(PATHS.chat, { size: "expanded", land: false });
    expect(wide).not.toContain('data-testid="pill-bar"');
    expect(wide).toContain('data-testid="sidebar"');
    expect(wide).not.toContain(ADD_APP_TITLE);
    expect(wide).toContain(`>${MAIN_TAB_LABEL}<`);
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

  test("an app One can't frame here opens on its own, from the bar or the screen, in a new tab", () => {
    for (const app of oneAppsFor("web", true)) {
      if (app.kind === "native") continue;
      const markup = ssr(<OneAppScreen appId={app.id} tcw={null} accountDid={ACCOUNT} fallback={<p>fallback</p>} />, appRoute(app));
      expect(markup).toContain(opensSeparatelyTitle(app.name, false).replaceAll("'", "&#x27;"));
      expect(markup).toContain(opensSeparatelyLine(app.name).replaceAll("'", "&#x27;"));
      const anchors = [...markup.matchAll(/<a [^>]*>/g)].map((match) => match[0]);
      expect(anchors).toHaveLength(2);
      for (const tag of anchors) {
        expect(attr(tag, "href")).toBe(appUrl(app));
        expect(tag).toContain('target="_blank"');
        expect(tag).toContain('rel="noopener noreferrer"');
      }
      expect(markup).toContain(openSeparately(app.name, false));
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

  test("Pin in the bar pins and unpins the app, says so, and survives a remount", async () => {
    const bar = <AppBar name={APP_NAMES["xyz.tinycloud.explorer"]} glyph="explorer" accountDid={ACCOUNT} pin="app:xyz.tinycloud.explorer" url="https://explorer.tinycloud.xyz/" />;
    mount(bar);
    const name = APP_NAMES["xyz.tinycloud.explorer"];
    const toggle = () => host.querySelector("button[aria-pressed]")!;
    expect(toggle().getAttribute("aria-pressed")).toBe("false");
    expect(toggle().getAttribute("aria-label")).toBe(pinApp(name));
    await click(toggle());
    expect(toggle().getAttribute("aria-pressed")).toBe("true");
    expect(toggle().getAttribute("aria-label")).toBe(unpinApp(name));
    expect(host.querySelector('[role="status"]')!.textContent).toBe(appPinnedToast(name));
    act(() => root.unmount());
    root = createRoot(host);
    mount(bar);
    expect(toggle().getAttribute("aria-pressed")).toBe("true");
    await click(toggle());
    expect(toggle().getAttribute("aria-pressed")).toBe("false");
    expect(host.querySelector('[role="status"]')!.textContent).toBe(appUnpinnedToast(name));
  });

  describe("Add an app", () => {
    const prompt = readFileSync(join(import.meta.dir, "addAppPrompt.txt"), "utf8");
    const setClipboard = (writeText: (text: string) => Promise<void>) =>
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const copyButton = () => [...host.querySelectorAll("button")].find((button) => button.textContent === COPY_PROMPT || button.textContent === COPIED)!;

    test("shows the prompt read-only and copies exactly addAppPrompt.txt", async () => {
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
