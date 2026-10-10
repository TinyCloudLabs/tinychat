// The shell's frame, rendered at each size class (AppShellView is a pure
// function of its props), plus the source guard for the fixed-tree rule. The
// runtime proof that nothing remounts is test/shell-invariants.e2e.test.ts.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";

import type { SizeClassState } from "../lib/sizeClass";
import { AppShell, AppShellView, shownSurface } from "./AppShell";
import { PATHS, screenFor } from "./routes";

const SLOTS = {
  chat: <p>chat-slot</p>,
  capture: <p>capture-slot</p>,
  connectors: <p>connectors-slot</p>,
  settings: <p>settings-slot</p>,
  about: <p>about-slot</p>,
};

const SIZES: Array<[string, SizeClassState]> = [
  ["compact", { size: "compact", land: false }],
  ["compact land", { size: "compact", land: true }],
  ["medium", { size: "medium", land: false }],
  ["expanded", { size: "expanded", land: false }],
];

const wrap = (node: ReactNode, path: string) =>
  renderToStaticMarkup(<MemoryRouter initialEntries={[path]}>{node}</MemoryRouter>);

function view(path: string, sizeClass: SizeClassState, captureMounted: boolean, slots: Partial<typeof SLOTS> = {}) {
  return wrap(
    <AppShellView
      screen={screenFor(path)}
      platform="ios"
      pendingMeetings={0}
      {...SLOTS}
      {...slots}
      sizeClass={sizeClass}
      captureMounted={captureMounted}
    />,
    path,
  );
}

/** The class list and contents of one surface wrapper. */
function surface(markup: string, name: string): { classes: string[]; body: string } {
  const at = markup.indexOf(`<div data-surface="${name}"`);
  expect(at).toBeGreaterThan(-1);
  const open = markup.slice(at, markup.indexOf(">", at));
  const body = markup.slice(markup.indexOf(">", at) + 1, markup.indexOf("</div>", at));
  return { classes: /class="([^"]*)"/.exec(open)?.[1].split(" ") ?? [], body };
}

describe("the fixed tree", () => {
  test("every size class renders the same surfaces, in the same order, inside one <main>", () => {
    for (const [, sizeClass] of SIZES) {
      const markup = view(PATHS.chat, sizeClass, true);
      expect(markup.match(/<main/g)).toHaveLength(1);
      const order = [...markup.matchAll(/data-surface="([a-z]+)"/g)].map((m) => m[1]);
      expect(order).toEqual(["chat", "capture", "connectors", "settings", "about"]);
    }
  });

  test("the navigation for each size class sits around <main>, never around a surface", () => {
    const at = (markup: string, marker: string) => markup.indexOf(marker);
    const upright = view(PATHS.chat, SIZES[0]![1], false);
    expect(at(upright, 'data-testid="tab-bar"')).toBeGreaterThan(at(upright, "</main>"));
    expect(upright).not.toContain('data-testid="nav-rail"');
    expect(upright).not.toContain('data-testid="sidebar"');
    for (const sizeClass of [SIZES[1]![1], SIZES[2]![1]]) {
      const markup = view(PATHS.chat, sizeClass, false);
      expect(at(markup, 'data-testid="nav-rail"')).toBeLessThan(at(markup, "<main"));
      expect(markup).not.toContain('data-testid="tab-bar"');
    }
    const wide = view(PATHS.chat, SIZES[3]![1], false);
    expect(at(wide, 'data-testid="sidebar"')).toBeLessThan(at(wide, "<main"));
    expect(wide).not.toContain('data-testid="tab-bar"');
  });

  test("source guard: every slot is one expression, present (or null) at every size class", () => {
    const source = readFileSync(join(import.meta.dir, "AppShell.tsx"), "utf8");
    const render = source.slice(source.indexOf("export function AppShellView("), source.indexOf("export function AppShell("));
    const slots = [
      '{nav === "sidebar" ? (',
      '{nav === "rail" ? (',
      "<main",
      '<div data-surface="chat"',
      '<div data-surface="capture"',
      '<div data-surface="connectors"',
      '<div data-surface="settings"',
      '<div data-surface="about"',
      "{island ? (",
      '{nav === "tabbar" && !globalScreen ? (',
    ];
    const positions = slots.map((slot) => render.indexOf(slot));
    for (const position of positions) expect(position).toBeGreaterThan(-1);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    // No surface is wrapped differently by size: the wrappers never mention the navigation kind.
    const main = render.slice(render.indexOf("<main"), render.indexOf("</main>"));
    expect(main).not.toContain("nav ===");
    expect(main).not.toContain("sizeClass");
  });
});

describe("mounting", () => {
  test("Chat is always mounted, and hidden while another surface shows", () => {
    for (const path of [PATHS.capture, PATHS.connectors, PATHS.settings, PATHS.library]) {
      const chat = surface(view(path, SIZES[0]![1], true), "chat");
      expect(chat.body).toContain("chat-slot");
      expect(chat.classes).toEqual(["hidden"]);
    }
    expect(surface(view(PATHS.chat, SIZES[0]![1], true), "chat").classes).toEqual(["h-full"]);
  });

  test("Capture is absent before its first visit, then kept and hidden", () => {
    expect(surface(view(PATHS.chat, SIZES[0]![1], false), "capture").body).toBe("");
    const kept = surface(view(PATHS.chat, SIZES[0]![1], true), "capture");
    expect(kept.body).toContain("capture-slot");
    expect(kept.classes).toEqual(["hidden"]);
    // The stateful shell mounts it when Capture is the screen…
    expect(wrap(<AppShell screen={screenFor(PATHS.capture)} platform="ios" pendingMeetings={0} {...SLOTS} />, PATHS.capture)).toContain(
      "capture-slot",
    );
    // …and not before.
    expect(wrap(<AppShell screen={screenFor(PATHS.chat)} platform="ios" pendingMeetings={0} {...SLOTS} />, PATHS.chat)).not.toContain(
      "capture-slot",
    );
  });

  test("Connectors, Settings and How it works are mounted only while shown", () => {
    const onChat = view(PATHS.chat, SIZES[3]![1], true);
    expect(onChat).not.toContain("connectors-slot");
    expect(onChat).not.toContain("settings-slot");
    expect(onChat).not.toContain("about-slot");
    expect(surface(view(PATHS.connectors, SIZES[3]![1], true), "connectors").body).toContain("connectors-slot");
    expect(surface(view(PATHS.settings, SIZES[3]![1], true), "settings").body).toContain("settings-slot");
    expect(surface(view(PATHS.about, SIZES[3]![1], true), "about").body).toContain("about-slot");
    expect(view(PATHS.settings, SIZES[3]![1], true)).not.toContain("about-slot");
  });

  test("How it works is pushed like Settings: no tab bar on a phone; wide, it sits under Settings", () => {
    expect(view(PATHS.about, SIZES[0]![1], true)).not.toContain('data-testid="tab-bar"');
    expect(view(PATHS.about, SIZES[0]![1], true)).toContain("about-slot");
    const wide = view(PATHS.about, SIZES[3]![1], true);
    expect(wide).toContain('data-testid="sidebar"');
    // No destination is current; the Settings row is, as on Settings itself.
    expect(wide.match(/aria-current="page"/g)).toHaveLength(1);
    expect(wide).toMatch(/aria-current="page"[^>]*href="\/chat\/settings"/);
    // Without its slot (none passed) the address falls back to Chat.
    expect(shownSurface(screenFor(PATHS.about), { capture: null, connectors: null, settings: null })).toBe("chat");
  });

  test("Settings on a phone held upright has no tab bar; on wide screens the navigation stays", () => {
    expect(view(PATHS.settings, SIZES[0]![1], true)).not.toContain('data-testid="tab-bar"');
    expect(view(PATHS.chat, SIZES[0]![1], true)).toContain('data-testid="tab-bar"');
    expect(view(PATHS.settings, SIZES[2]![1], true)).toContain('data-testid="nav-rail"');
    expect(view(PATHS.settings, SIZES[3]![1], true)).toContain('data-testid="sidebar"');
  });

  test("without Capture and Connectors (local validation) there is only Chat, and no navigation", () => {
    const markup = view(PATHS.capture, SIZES[0]![1], true, { capture: null, connectors: null, settings: null } as never);
    expect(markup).not.toContain('aria-label="Primary"');
    expect(surface(markup, "chat").classes).toEqual(["h-full"]);
    expect(shownSurface(screenFor(PATHS.settings), { capture: null, connectors: null, settings: null })).toBe("chat");
  });
});
