// A build with One's new navigation on (VITE_ONE_APPS=true, VITE_ONE_NAV=true): the shell and the Apps page take it from
// the flag alone. Run by src/shell/oneNav.flag.test.ts in its own process, with those flags in its environment.
import { afterAll, describe, expect, test } from "bun:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";

import { ADD_APP_TITLE, APP_NAMES, MAIN_TAB_LABEL, PILL_LABELS } from "@/apps/strings";
import { APPS_PIN } from "@/lib/homeStrings";
import { AppsPage } from "@/home/AppsPage";
import { AppShell } from "@/shell/AppShell";
import { NAV_APP_IDS } from "@/shell/navApps";
import { ONE_NAV_ENABLED } from "@/shell/navPins";
import { PATHS, screenFor } from "@/shell/routes";
import { installDom } from "@/test/dom";

// The Apps page reads the page's origin.
afterAll(installDom());

const ACCOUNT = "did:pkh:eip155:1:0x00000000000000000000000000000000000000a1";
const render = (node: ReactNode, path: string) => renderToStaticMarkup(<MemoryRouter initialEntries={[path]}>{node}</MemoryRouter>);

describe("One's new navigation on", () => {
  test("the build reads the flag", () => {
    expect(ONE_NAV_ENABLED).toBe(true);
  });

  test("a phone gets the pill with the main tab, Chat, Apps and You", () => {
    const markup = render(
      <AppShell
        screen={screenFor(PATHS.chat)}
        accountDid={ACCOUNT}
        platform="web"
        pendingMeetings={0}
        chat={<p>chat-slot</p>}
        capture={<p>capture-slot</p>}
        connectors={<p>connectors-slot</p>}
        settings={<p>settings-slot</p>}
        feed={<p>feed-slot</p>}
        apps={<p>apps-slot</p>}
      />,
      PATHS.chat,
    );
    expect(markup).not.toContain('data-testid="tab-bar"');
    const pill = markup.slice(markup.indexOf('data-testid="pill-bar"'), markup.indexOf("</nav>", markup.indexOf('data-testid="pill-bar"')));
    expect([...pill.matchAll(/aria-label="([^"]*)"/g)].map((match) => match[1])).toEqual([MAIN_TAB_LABEL, PILL_LABELS.chat, PILL_LABELS.apps, PILL_LABELS.you]);
  });

  test("the Apps page is the grid, ending with Add an app, with no Pin row", () => {
    const markup = render(<AppsPage accountDid={ACCOUNT} />, PATHS.apps);
    expect(markup).toContain(`href="${PATHS.addApp}"`);
    expect(markup).toContain(ADD_APP_TITLE);
    expect(markup).toContain(`>${APP_NAMES["xyz.tinycloud.share"]}<`);
    expect(markup).not.toContain(`>${APPS_PIN}<`);
  });

  test("Share can be pinned", () => {
    expect(NAV_APP_IDS).toContain("xyz.tinycloud.share");
  });
});
