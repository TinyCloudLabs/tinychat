import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { AppWindowIcon, PlugIcon } from "lucide-react";

import { connectorsAriaLabel } from "@/chat/useBackgroundDrain";
import { APPS_LAUNCHER_TITLE, APPS_PIN_HINT, APPS_UNPIN } from "@/lib/homeStrings";
import type { PinId } from "@/shell/navPins";
import { AppsLauncher, type LauncherTile } from "./AppsLauncher";
import { launcherTiles } from "./AppsPage";

const TILES: LauncherTile[] = [
  { pin: "app:xyz.tinycloud.secrets", name: "Secrets", description: "Keys.", icon: AppWindowIcon, target: { kind: "newTab", url: "https://secrets.tinycloud.xyz/app" } },
  { pin: "connectors", name: "Connectors", icon: PlugIcon, target: { kind: "route", path: "/chat/connectors" }, pending: 3 },
];

const render = (pins: PinId[], canPin = true, tiles: readonly LauncherTile[] = TILES) =>
  renderToStaticMarkup(
    <MemoryRouter>
      <AppsLauncher tiles={tiles} pins={pins} canPin={canPin} onPin={() => {}} onUnpin={() => {}} />
    </MemoryRouter>,
  );

/** The opening tag of the link whose href is `href`. */
function anchor(markup: string, href: string): string {
  const tag = markup.split("<a ").find((chunk) => chunk.slice(0, chunk.indexOf(">")).includes(`href="${href}"`));
  if (!tag) throw new Error(`no link to ${href}`);
  return tag.slice(0, tag.indexOf(">"));
}

describe("TinyCloud apps launcher", () => {
  test("opens each tile at its target under the heading", () => {
    const markup = render([]);
    expect(markup).toContain(APPS_LAUNCHER_TITLE);
    expect(markup).toContain('href="https://secrets.tinycloud.xyz/app"');
    expect(markup).toContain('href="/chat/connectors"');
  });

  test("a new-tab target opens with noopener and noreferrer; a route stays in the app", () => {
    const markup = render([]);
    const external = anchor(markup, "https://secrets.tinycloud.xyz/app");
    expect(external).toContain('target="_blank"');
    expect(external).toContain('rel="noopener noreferrer"');
    expect(anchor(markup, "/chat/connectors")).not.toContain("target=");
  });

  test("the pin hint shows only while just the defaults are pinned", () => {
    expect(render([])).toContain(APPS_PIN_HINT);
    expect(render(["connectors"])).not.toContain(APPS_PIN_HINT);
  });

  test("a pinned tile offers Unpin, an unpinned one Pin", () => {
    const markup = render(["app:xyz.tinycloud.secrets"]);
    const buttons = [...markup.matchAll(/<button[^>]*>(.*?)<\/button>/g)].map((m) => m[0]);
    expect(buttons[0]).toContain(APPS_UNPIN);
    expect(buttons[0]).toContain('aria-pressed="true"');
    expect(buttons[1]).toContain(">Pin<");
  });

  test("the pending count shows on the Connectors tile only while it is not pinned", () => {
    expect(render([])).toContain(connectorsAriaLabel(3));
    expect(render(["connectors"])).not.toContain(connectorsAriaLabel(3));
  });

  test("with no account there is nothing to pin to: no buttons and no hint", () => {
    const markup = render([], false);
    expect(markup).not.toContain("<button");
    expect(markup).not.toContain(APPS_PIN_HINT);
  });
});

describe("the registry's tiles on One's own origin", () => {
  const tiles = launcherTiles(0, "https://tinycloud.one");
  const target = (pin: PinId) => tiles.find((tile) => tile.pin === pin)!.target;

  test("Secrets opens its own page in a new tab; Explorer opens in One; Recording and Connectors are One's routes", () => {
    expect(target("app:xyz.tinycloud.secrets")).toEqual({ kind: "newTab", url: "https://secrets.tinycloud.xyz/app" });
    expect(target("app:xyz.tinycloud.explorer")).toEqual({ kind: "route", path: "/chat/apps/xyz.tinycloud.explorer" });
    expect(target("capture")).toEqual({ kind: "route", path: "/chat/capture" });
    expect(target("connectors")).toEqual({ kind: "route", path: "/chat/connectors" });
  });

  test("off One's origins every TinyCloud app opens in a new tab", () => {
    const elsewhere = launcherTiles(0, "https://example.com");
    expect(elsewhere.find((tile) => tile.pin === "app:xyz.tinycloud.explorer")!.target.kind).toBe("newTab");
  });
});
