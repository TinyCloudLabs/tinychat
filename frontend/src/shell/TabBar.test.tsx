// The navigation chrome, rendered: the tab bar, and the rail and sidebar that
// share its model (navItems.ts) and its rules for the current item.
import { describe, expect, test } from "bun:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";

import { NavRail } from "./NavRail";
import { navItems, navKindFor } from "./navItems";
import { PATHS, type Destination } from "./routes";
import { Sidebar } from "./Sidebar";
import { TabBar } from "./TabBar";

const render = (node: ReactNode, path: string = PATHS.chat) =>
  renderToStaticMarkup(<MemoryRouter initialEntries={[path]}>{node}</MemoryRouter>);

const props = (current: Destination | null, pending = 0) => ({
  items: navItems(pending),
  current,
  replace: false,
  onReselect: () => {},
});

/** The opening tag of the link whose href is `href`. */
function anchor(markup: string, href: string): string {
  const tag = markup.split("<a ").find((chunk) => chunk.slice(0, chunk.indexOf(">")).includes(`href="${href}"`));
  if (!tag) throw new Error(`no link to ${href}`);
  return tag.slice(0, tag.indexOf(">"));
}

/** Everything inside the link whose href is `href`. */
function linkBody(markup: string, href: string): string {
  const at = markup.indexOf(`href="${href}"`);
  return markup.slice(markup.indexOf(">", at) + 1, markup.indexOf("</a>", at));
}

/** The opening tag of the element that directly contains the first match of `marker`. */
function parentTagOf(markup: string, marker: string): string {
  const at = markup.indexOf(marker);
  const stack: string[] = [];
  for (const match of markup.slice(0, at).matchAll(/<(\/?)([a-z]+)([^>]*?)(\/?)>/g)) {
    if (match[1]) stack.pop();
    else if (!match[4]) stack.push(match[0]);
  }
  return stack.at(-1) ?? "";
}

const classOf = (tag: string) => /class="([^"]*)"/.exec(tag)?.[1].split(" ") ?? [];

describe("TabBar", () => {
  test("a labelled Primary landmark with the three destinations, in order, as links", () => {
    const markup = render(<TabBar {...props("chat")} />);
    expect(markup).toContain('<nav aria-label="Primary"');
    expect(markup.match(/<a /g)).toHaveLength(3);
    expect(markup.indexOf(`href="${PATHS.capture}"`)).toBeLessThan(markup.indexOf(`href="${PATHS.chat}"`));
    expect(markup.indexOf(`href="${PATHS.chat}"`)).toBeLessThan(markup.indexOf(`href="${PATHS.connectors}"`));
    for (const label of ["Capture", "Chat", "Connectors"]) expect(markup).toContain(`>${label}</span>`);
  });

  test("exactly the current item is marked: aria-current, the tinted pill, label weight 600 and a heavier icon", () => {
    const markup = render(<TabBar {...props("capture")} />, PATHS.capture);
    expect(markup.match(/aria-current="page"/g)).toHaveLength(1);
    expect(anchor(markup, PATHS.capture)).toContain('aria-current="page"');

    const current = linkBody(markup, PATHS.capture);
    expect(current).toContain("bg-selected");
    expect(current).toContain("[stroke-width:2.25]");
    expect(current).toMatch(/class="text-label font-semibold text-foreground">Capture</);

    const other = linkBody(markup, PATHS.chat);
    expect(other).not.toContain("bg-selected");
    expect(other).not.toContain("[stroke-width:2.25]");
    expect(other).toMatch(/class="text-label font-medium text-muted-foreground">Chat</);
  });

  test("the Connectors item's name carries the count; its pill is aria-hidden inside a relative box", () => {
    const markup = render(<TabBar {...props("chat", 3)} />);
    expect(anchor(markup, PATHS.connectors)).toContain('aria-label="Connectors — 3 meetings waiting"');
    const pill = '<span aria-hidden="true"';
    expect(linkBody(markup, PATHS.connectors)).toContain(pill);
    expect(classOf(markup.slice(markup.indexOf(pill)))).toContain("absolute");
    expect(classOf(parentTagOf(markup, pill))).toContain("relative");
    // Clamped in the pill only; the name keeps the number.
    expect(render(<TabBar {...props("chat", 120)} />)).toContain(">99+</span>");
  });

  test("with nothing waiting there is no pill, and the name is just the label", () => {
    const markup = render(<TabBar {...props("chat", 0)} />);
    expect(markup).not.toContain('<span aria-hidden="true"');
    expect(anchor(markup, PATHS.connectors)).toContain('aria-label="Connectors"');
  });

  test("Settings is current: no destination is", () => {
    expect(render(<TabBar {...props(null)} />, PATHS.settings)).not.toContain("aria-current");
  });
});

describe("NavRail and Sidebar share the model and its rules", () => {
  for (const [name, Nav] of [["NavRail", NavRail], ["Sidebar", Sidebar]] as const) {
    test(`${name}: the landmark, the current item and the badge`, () => {
      const markup = render(<Nav {...props("connectors", 2)} settings />, PATHS.connectors);
      expect(markup).toContain('<nav aria-label="Primary"');
      expect(anchor(markup, PATHS.connectors)).toContain('aria-current="page"');
      expect(anchor(markup, PATHS.connectors)).toContain('aria-label="Connectors — 2 meetings waiting"');
      expect(anchor(markup, PATHS.connectors) + linkBody(markup, PATHS.connectors)).toContain("bg-selected");
      expect(classOf(parentTagOf(markup, '<span aria-hidden="true"'))).toContain("relative");
      // Settings at the foot, current only on Settings.
      expect(markup).toContain(`href="${PATHS.settings}"`);
      expect(anchor(markup, PATHS.settings)).not.toContain("aria-current");
      const onSettings = render(<Nav {...props(null)} settings />, PATHS.settings);
      expect(anchor(onSettings, PATHS.settings)).toContain('aria-current="page"');
    });

    test(`${name}: no Settings where it does not exist`, () => {
      expect(render(<Nav {...props("chat")} settings={false} />)).not.toContain(`href="${PATHS.settings}"`);
    });
  }
});

describe("which navigation a size class gets", () => {
  test("tab bar upright, rail on its side and on tablets, sidebar from 1024", () => {
    expect(navKindFor({ size: "compact", land: false })).toBe("tabbar");
    expect(navKindFor({ size: "compact", land: true })).toBe("rail");
    expect(navKindFor({ size: "medium", land: false })).toBe("rail");
    expect(navKindFor({ size: "expanded", land: false })).toBe("sidebar");
  });
});
