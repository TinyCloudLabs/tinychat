import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

// The tile's page stays small: it loads its own script, which imports only Tauri's core and event modules, never the
// app's entry. It carries a copy of the app's dark tokens rather than the app's stylesheet (which brings Tailwind and
// the display font); the copy must stay equal to index.css.

const read = (file: string) => readFileSync(path.join(import.meta.dir, file), "utf8");

/** The custom properties declared directly in the blocks whose selector is exactly `selector`; the first one wins. */
function tokens(css: string, selector: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const block of css.matchAll(new RegExp(`(?:^|\\n)\\s*${selector.replace(".", "\\.")}\\s*\\{([^}]*)\\}`, "g")))
    for (const [, name, value] of block[1]!.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g))
      if (!found.has(name!)) found.set(name!, value!.trim());
  if (found.size === 0) throw new Error(`no ${selector} block`);
  return found;
}

describe("the call prompt tile's stylesheet", () => {
  test("every token it declares is index.css's dark value", () => {
    const app = read("../index.css");
    const dark = tokens(app, ".dark");
    const light = tokens(app, ":root");
    const tile = tokens(read("callPrompt.css"), ".cp-root");
    expect(tile.size).toBeGreaterThan(5);
    for (const [name, value] of tile) expect([name, value]).toEqual([name, dark.get(name) ?? light.get(name) ?? "(not in index.css)"]);
  });

  test("brings in nothing of the app's: no Tailwind layer, no import, no font file", () => {
    for (const file of ["callPrompt.css", "page.css"]) {
      const css = read(file);
      expect(css).not.toMatch(/@tailwind|@import|@apply|@font-face|url\(/);
    }
  });
});

describe("the call prompt tile's page", () => {
  test("call-prompt.html loads the tile's entry and nothing else", () => {
    const html = read("../../call-prompt.html");
    expect([...html.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)].map((match) => match[1])).toEqual(["/src/callPrompt/main.ts"]);
    expect(html).not.toMatch(/<link|<style|main\.tsx/);
  });

  test("its modules import only Tauri's core and event modules and each other", () => {
    const modules = readdirSync(import.meta.dir).filter((file) => /\.ts$/.test(file) && !/\.test\.ts$/.test(file));
    expect(modules).toContain("main.ts");
    for (const file of modules) {
      const imports = [...read(file).matchAll(/^\s*import\s+(?:[^"']*\sfrom\s+)?["']([^"']+)["']/gm)].map((match) => match[1]!);
      for (const specifier of imports)
        expect([file, specifier]).toEqual([file, /^\.\/[\w.]+$|^@tauri-apps\/api\/(core|event)$/.test(specifier) ? specifier : "(not allowed)"]);
    }
  });
});

describe("the recording dot", () => {
  const css = read("callPrompt.css");
  const rule = (selector: string, within = css) => {
    const at = within.indexOf(`${selector} {`);
    expect(at).toBeGreaterThanOrEqual(0);
    return within.slice(at, within.indexOf("}", at));
  };

  test("pulses slowly while recording (one cycle in 1.5 to 2 s), CSS only", () => {
    const duration = /animation:\s*cp-pulse\s+([\d.]+)s/.exec(rule(".cp-rec"))?.[1];
    expect(Number(duration)).toBeGreaterThanOrEqual(1.5);
    expect(Number(duration)).toBeLessThanOrEqual(2);
    expect(css).toContain("@keyframes cp-pulse");
  });

  test("is still and dimmed while paused", () => {
    const paused = rule('.cp-bar[data-paused="true"] .cp-rec');
    expect(paused).toContain("animation: none");
    expect(paused).toMatch(/opacity:\s*0\.\d/);
  });

  test("does not move with reduced motion", () => {
    const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(rule(".cp-rec", reduced)).toContain("animation: none");
  });
});
