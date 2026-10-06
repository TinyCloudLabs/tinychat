import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { AppearanceControl } from "@/chat/AppearanceControl";
import { ThemeToggle } from "@/components/theme-toggle";
import { compute, initSizeClass } from "./sizeClass";
import {
  LEGACY_THEME_KEY,
  THEME_CHOICE_KEY,
  THEME_COLOR,
  applyTheme,
  initTheme,
  readThemeChoice,
  resolveTheme,
  setThemeChoice,
  type ThemeChoice,
} from "./theme";

/** localStorage with a record of every write. */
function fakeStorage(initial: Record<string, string> = {}, options: { throws?: boolean } = {}) {
  const values = new Map(Object.entries(initial));
  const writes: Array<[string, string]> = [];
  return {
    writes,
    getItem(key: string) {
      if (options.throws) throw new Error("storage disabled");
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      if (options.throws) throw new Error("storage disabled");
      writes.push([key, value]);
      values.set(key, value);
    },
  };
}

// index.html's two theme-color metas, as shipped.
const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
const shippedMetas = [...html.matchAll(/<meta name="theme-color" media="([^"]+)" content="([^"]+)" \/>/g)].map((m) => ({
  media: m[1]!,
  content: m[2]!,
}));

/** Just enough of window and document for the pre-paint script, applyTheme and initSizeClass. */
function fakeBrowser(options: { systemDark: boolean; width: number; height: number; coarse?: boolean }) {
  const classes = new Set<string>();
  const attributes = new Map<string, string>();
  const metas = shippedMetas.map((meta) => ({ ...meta }));
  const mediaListeners = new Set<(event: { matches: boolean }) => void>();
  const documentElement = {
    classList: {
      add: (name: string) => void classes.add(name),
      remove: (name: string) => void classes.delete(name),
      contains: (name: string) => classes.has(name),
      toggle: (name: string, force?: boolean) => {
        const on = force ?? !classes.has(name);
        if (on) classes.add(name);
        else classes.delete(name);
        return on;
      },
    },
    setAttribute: (name: string, value: string) => void attributes.set(name, value),
    removeAttribute: (name: string) => void attributes.delete(name),
    getAttribute: (name: string) => attributes.get(name) ?? null,
  };
  const document = Object.assign(new EventTarget(), {
    documentElement,
    activeElement: null as unknown,
    querySelectorAll: (selector: string) => {
      if (selector !== 'meta[name="theme-color"]') throw new Error(`unexpected selector ${selector}`);
      return metas.map((meta) => ({
        getAttribute: (name: string) => (name === "media" ? meta.media : name === "content" ? meta.content : null),
        setAttribute: (name: string, value: string) => {
          if (name === "content") meta.content = value;
        },
      }));
    },
  });
  const window = Object.assign(new EventTarget(), {
    document,
    innerWidth: options.width,
    innerHeight: options.height,
    matchMedia: (query: string) => ({
      // Live, like a real MediaQueryList.
      get matches() {
        return query === "(prefers-color-scheme: dark)" ? options.systemDark : query === "(pointer: coarse)" ? Boolean(options.coarse) : false;
      },
      addEventListener: (_type: string, listener: (event: { matches: boolean }) => void) => mediaListeners.add(listener),
      removeEventListener: (_type: string, listener: (event: { matches: boolean }) => void) => mediaListeners.delete(listener),
    }),
  });
  const state = () => ({
    dark: classes.has("dark"),
    metas: metas.map((meta) => `${meta.media} ${meta.content}`),
    size: attributes.get("data-size") ?? null,
    land: attributes.has("data-land"),
  });
  const setSystemDark = (dark: boolean) => {
    options.systemDark = dark;
    for (const listener of mediaListeners) listener({ matches: dark });
  };
  return { window, document, state, setSystemDark };
}

// The inline script in index.html's <head>.
const prePaint = /<script>\s*([\s\S]*?)<\/script>/.exec(html)![1]!;
function runPrePaint(browser: ReturnType<typeof fakeBrowser>, storage: ReturnType<typeof fakeStorage>) {
  new Function("window", "document", "localStorage", prePaint)(browser.window, browser.document, storage);
}

const restoreGlobals: Array<() => void> = [];
function setGlobal(name: string, value: unknown) {
  const had = Object.prototype.hasOwnProperty.call(globalThis, name);
  const previous = (globalThis as Record<string, unknown>)[name];
  (globalThis as Record<string, unknown>)[name] = value;
  restoreGlobals.push(() => {
    if (had) (globalThis as Record<string, unknown>)[name] = previous;
    else delete (globalThis as Record<string, unknown>)[name];
  });
}
afterEach(() => {
  while (restoreGlobals.length) restoreGlobals.pop()!();
});

describe("theme choice", () => {
  test("with nothing stored, the choice is System", () => {
    expect(readThemeChoice(fakeStorage())).toBe("system");
  });

  test("the legacy key alone is ignored: it was written on every launch", () => {
    expect(readThemeChoice(fakeStorage({ [LEGACY_THEME_KEY]: "dark" }))).toBe("system");
    expect(readThemeChoice(fakeStorage({ [LEGACY_THEME_KEY]: "light" }))).toBe("system");
  });

  test("a stored theme-choice wins, whatever the legacy key says", () => {
    expect(readThemeChoice(fakeStorage({ [THEME_CHOICE_KEY]: "light", [LEGACY_THEME_KEY]: "dark" }))).toBe("light");
    expect(readThemeChoice(fakeStorage({ [THEME_CHOICE_KEY]: "dark" }))).toBe("dark");
    expect(readThemeChoice(fakeStorage({ [THEME_CHOICE_KEY]: "system", [LEGACY_THEME_KEY]: "light" }))).toBe("system");
  });

  test("an unknown value or disabled storage reads as System", () => {
    expect(readThemeChoice(fakeStorage({ [THEME_CHOICE_KEY]: "sepia" }))).toBe("system");
    expect(readThemeChoice(fakeStorage({}, { throws: true }))).toBe("system");
    expect(readThemeChoice(null)).toBe("system");
  });

  test("System follows the device; Light and Dark do not", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });
});

describe("nothing is written on mount", () => {
  test("the Settings control and the header toggle render without writing", () => {
    const storage = fakeStorage({ [LEGACY_THEME_KEY]: "dark" });
    setGlobal("localStorage", storage);
    const markup = renderToStaticMarkup(createElement(Fragment, null, createElement(AppearanceControl), createElement(ThemeToggle)));
    expect(markup).toContain('role="radiogroup"');
    expect(markup).toContain('aria-label="Toggle theme"');
    expect(storage.writes).toEqual([]);
  });

  test("initTheme applies the stored choice and follows the device without writing", () => {
    const storage = fakeStorage();
    const browser = fakeBrowser({ systemDark: true, width: 390, height: 844 });
    setGlobal("localStorage", storage);
    const stop = initTheme(browser.window as unknown as Window);
    expect(browser.state().dark).toBe(true);
    browser.setSystemDark(false);
    expect(browser.state().dark).toBe(false);
    stop();
    expect(storage.writes).toEqual([]);
  });

  test("choosing writes the choice once, and a chosen theme stops following the device", () => {
    const storage = fakeStorage();
    const browser = fakeBrowser({ systemDark: false, width: 390, height: 844 });
    setGlobal("localStorage", storage);
    setGlobal("window", browser.window);
    setGlobal("document", browser.document);
    const stop = initTheme(browser.window as unknown as Window);
    setThemeChoice("dark");
    expect(storage.writes).toEqual([[THEME_CHOICE_KEY, "dark"]]);
    expect(browser.state().dark).toBe(true);
    expect(browser.state().metas).toEqual(shippedMetas.map((meta) => `${meta.media} ${THEME_COLOR.dark}`));
    browser.setSystemDark(false);
    expect(browser.state().dark).toBe(true);
    setThemeChoice("system");
    expect(browser.state().dark).toBe(false);
    expect(browser.state().metas).toEqual(shippedMetas.map((meta) => `${meta.media} ${meta.content}`));
    stop();
  });
});

describe("index.html's pre-paint script agrees with lib/theme.ts and lib/sizeClass.ts", () => {
  const stored: Array<[string, Record<string, string>, { throws?: boolean }?]> = [
    ["nothing", {}],
    ["the legacy key (dark)", { [LEGACY_THEME_KEY]: "dark" }],
    ["the legacy key (light)", { [LEGACY_THEME_KEY]: "light" }],
    ["System", { [THEME_CHOICE_KEY]: "system" }],
    ["Light", { [THEME_CHOICE_KEY]: "light", [LEGACY_THEME_KEY]: "dark" }],
    ["Dark", { [THEME_CHOICE_KEY]: "dark" }],
    ["an unknown value", { [THEME_CHOICE_KEY]: "sepia" }],
    ["disabled storage", {}, { throws: true }],
  ];
  const sizes: Array<[number, number]> = [
    [390, 844], [844, 390], [820, 1180], [1180, 820], [900, 600], [1280, 800], [640, 400],
    // Either side of every boundary: 768 and 1024 wide, 500 tall, square.
    [767, 1000], [768, 1000], [1023, 800], [1024, 800], [1024, 500], [1024, 501], [600, 500], [600, 501], [700, 700],
  ];

  for (const [label, values, options] of stored) {
    for (const systemDark of [false, true]) {
      test(`${label}, device ${systemDark ? "dark" : "light"}`, () => {
        for (const [width, height] of sizes) {
          const script = fakeBrowser({ systemDark, width, height });
          runPrePaint(script, fakeStorage(values, options));

          const lib = fakeBrowser({ systemDark, width, height });
          const choice: ThemeChoice = readThemeChoice(fakeStorage(values, options));
          applyTheme(choice, systemDark, lib.document as unknown as Document);
          const stop = initSizeClass(lib.window as unknown as Window);
          stop();

          expect(script.state()).toEqual(lib.state());
          expect(script.state().size).toBe(compute(width, height).size);
        }
      });
    }
  }
});
