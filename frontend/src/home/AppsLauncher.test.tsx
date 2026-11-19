import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { AppWindowIcon, PlugIcon } from "lucide-react";

import { connectorsAriaLabel } from "@/chat/useBackgroundDrain";

import { APPS_LAUNCHER_TITLE, APPS_PIN_HINT, APPS_UNPIN } from "@/lib/homeStrings";
import { AppsLauncher, type LauncherTile } from "./AppsLauncher";
import type { PinId } from "@/shell/navPins";

const TILES: LauncherTile[] = [
  { pin: "app:xyz.tinycloud.secrets", name: "Secrets", description: "Keys.", icon: AppWindowIcon, href: "/chat/apps/xyz.tinycloud.secrets" },
  { pin: "connectors", name: "Connectors", icon: PlugIcon, href: "/chat/connectors", pending: 3 },
];

const render = (pins: PinId[], canPin = true) =>
  renderToStaticMarkup(
    <MemoryRouter>
      <AppsLauncher tiles={TILES} pins={pins} canPin={canPin} onPin={() => {}} onUnpin={() => {}} />
    </MemoryRouter>,
  );

describe("TinyCloud apps launcher", () => {
  test("opens each tile at its address under the heading", () => {
    const markup = render([]);
    expect(markup).toContain(APPS_LAUNCHER_TITLE);
    expect(markup).toContain('href="/chat/apps/xyz.tinycloud.secrets"');
    expect(markup).toContain('href="/chat/connectors"');
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
