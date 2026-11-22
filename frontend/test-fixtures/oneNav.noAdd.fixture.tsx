// A build with One's new navigation on and Add an app off (VITE_ONE_APPS and VITE_ONE_NAV "true", VITE_ONE_ADD_APP
// unset), as production will build once the navigation ships: no Add an app tile, nothing links to /chat/apps/add, and
// the address is no screen of its own. Run by src/shell/oneNav.flag.test.ts in its own process, with those flags in its
// environment.
import { afterAll, describe, expect, test } from "bun:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";

import { OneAppScreen } from "@/apps/FramedAppScreen";
import { ADD_APP_TITLE, APP_NAMES, CONNECTORS_NAME } from "@/apps/strings";
import { AppsPage } from "@/home/AppsPage";
import { AppShell } from "@/shell/AppShell";
import { ONE_ADD_APP_ENABLED, ONE_NAV_ENABLED } from "@/shell/navPins";
import { PATHS, screenFor } from "@/shell/routes";
import { installDom } from "@/test/dom";

// The Apps page reads the page's origin.
afterAll(installDom());

const ACCOUNT = "did:pkh:eip155:1:0x00000000000000000000000000000000000000a1";
const render = (node: ReactNode, path: string) => renderToStaticMarkup(<MemoryRouter initialEntries={[path]}>{node}</MemoryRouter>);
const shell = (path: string) =>
  render(
    <AppShell
      screen={screenFor(path)}
      accountDid={ACCOUNT}
      platform="web"
      pendingMeetings={0}
      chat={<p>chat-slot</p>}
      capture={<p>capture-slot</p>}
      connectors={<p>connectors-slot</p>}
      settings={<p>settings-slot</p>}
      feed={<p>feed-slot</p>}
      apps={<AppsPage accountDid={ACCOUNT} />}
    />,
    path,
  );

describe("One's new navigation on, Add an app off", () => {
  test("the build reads the flags", () => {
    expect(ONE_NAV_ENABLED).toBe(true);
    expect(ONE_ADD_APP_ENABLED).toBe(false);
  });

  test("the grid has no Add an app tile and ends with Connectors; nothing on the page links to /chat/apps/add", () => {
    const markup = shell(PATHS.apps);
    expect(markup).toContain('data-testid="pill-bar"');
    expect(markup).toContain(`>${APP_NAMES["xyz.tinycloud.share"]}<`);
    expect(markup).not.toContain(ADD_APP_TITLE);
    expect(markup).not.toContain(`href="${PATHS.addApp}"`);
    const grid = markup.slice(markup.indexOf("<ul", markup.indexOf('data-surface="apps"')));
    const names = [...grid.slice(0, grid.indexOf("</ul>")).matchAll(/<a [^>]*>[\s\S]*?<\/a>/g)].map((match) => match[0]);
    expect(names.at(-1)).toContain(`>${CONNECTORS_NAME}<`);
  });

  test("/chat/apps/add does not route: it is an unknown app id, which falls back like any other", () => {
    const screen = screenFor(PATHS.addApp);
    expect(screen.id).not.toBe("addApp");
    expect(screen.appId).toBe("add");
    const fallback = <p>fallback</p>;
    expect(render(<OneAppScreen appId={screen.appId!} tcw={null} accountDid={ACCOUNT} fallback={fallback} />, PATHS.addApp)).toBe(
      render(<OneAppScreen appId="no-such-app" tcw={null} accountDid={ACCOUNT} fallback={fallback} />, PATHS.addApp),
    );
  });
});
