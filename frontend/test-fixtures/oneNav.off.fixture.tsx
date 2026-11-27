// Production web as it ships today: One Apps on (VITE_ONE_APPS=true), One's new navigation off (VITE_ONE_NAV unset).
// The navigation and the Apps page are exactly One Apps' as before TC-3650. Run by src/shell/oneNav.flag.test.ts in its
// own process, with those flags in its environment.
import { afterAll, describe, expect, test } from "bun:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";

import { APP_DESCRIPTIONS, APP_NAMES, ADD_APP_TITLE, MAIN_TAB_LABEL, PILL_LABELS } from "@/apps/strings";
import { APPS_CONNECTORS_DESCRIPTION, APPS_PIN, NAV_LABEL_APPS, NAV_LABEL_CHAT, NAV_LABEL_HOME } from "@/lib/homeStrings";
import { AppsPage } from "@/home/AppsPage";
import { AppShell } from "@/shell/AppShell";
import { NAV_APP_IDS } from "@/shell/navApps";
import { ONE_ADD_APP_ENABLED, ONE_APPS_ENABLED, ONE_NAV_ENABLED } from "@/shell/navPins";
import { PATHS, screenFor } from "@/shell/routes";
import { installDom } from "@/test/dom";

// The launcher reads the page's origin.
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
      apps={<p>apps-slot</p>}
      about={<p>about-slot</p>}
    />,
    path,
  );

/** The text of each item, in order, in the element that starts at `marker`. */
function labels(markup: string, marker: string): string[] {
  const start = markup.indexOf(marker);
  expect(start).toBeGreaterThan(-1);
  const nav = markup.slice(start, markup.indexOf("</nav>", start));
  return [...nav.matchAll(/<a [^>]*>(.*?)<\/a>/g)].map((match) => match[1]!.replace(/<[^>]*>/g, ""));
}

describe("production today: One Apps on, One's new navigation off", () => {
  test("the build reads the flags as production sets them", () => {
    expect(ONE_APPS_ENABLED).toBe(true);
    expect(ONE_NAV_ENABLED).toBe(false);
    expect(ONE_ADD_APP_ENABLED).toBe(false);
  });

  test("a phone gets today's tab bar, with today's items in today's order, and no pill", () => {
    for (const path of [PATHS.chat, PATHS.apps, PATHS.settings, PATHS.addApp]) expect(shell(path)).not.toContain('data-testid="pill-bar"');
    const markup = shell(PATHS.chat);
    expect(labels(markup, 'data-testid="tab-bar"')).toEqual([NAV_LABEL_HOME, NAV_LABEL_CHAT, NAV_LABEL_APPS]);
    expect(markup).not.toContain(`aria-label="${PILL_LABELS.you}"`);
    if (MAIN_TAB_LABEL !== NAV_LABEL_HOME) expect(markup).not.toContain(`>${MAIN_TAB_LABEL}<`);
  });

  test("the Apps page is today's launcher: every tile with its line and a Pin row, and no Add an app", () => {
    const markup = render(<AppsPage accountDid={ACCOUNT} />, PATHS.apps);
    // Drive is listed only once the owner's Apps space holds its install record (listedApps.ts); with no session to
    // look, it stays hidden.
    const today = ["capture", "xyz.tinycloud.secrets", "xyz.tinycloud.opencredentials", "xyz.tinycloud.explorer", "xyz.tinycloud.account", "xyz.tinycloud.courier"] as const;
    expect(markup).not.toContain(`>${APP_NAMES["xyz.tinycloud.tinydrive"]}<`);
    const at = (text: string) => markup.indexOf(text);
    const positions = today.map((id) => at(`>${APP_NAMES[id]}<`));
    for (const position of positions) expect(position).toBeGreaterThan(-1);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    for (const id of today) expect(markup).toContain(APP_DESCRIPTIONS[id].replaceAll("'", "&#x27;"));
    expect(markup).toContain(APPS_CONNECTORS_DESCRIPTION);
    expect([...markup.matchAll(new RegExp(`>${APPS_PIN}<`, "g"))].length).toBe(today.length + 1);
    expect(markup).not.toContain(ADD_APP_TITLE);
    expect(markup).not.toContain(`href="${PATHS.addApp}"`);
    expect(markup).not.toContain(`>${APP_NAMES["xyz.tinycloud.share"]}<`);
  });

  test("Share is not an app the navigation can pin", () => {
    expect(NAV_APP_IDS).not.toContain("xyz.tinycloud.share");
  });
});
