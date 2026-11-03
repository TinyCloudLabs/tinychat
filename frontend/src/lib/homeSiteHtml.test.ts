import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homeSiteIndexHtml } from "./homeSiteHtml";

const source = readFileSync(join(import.meta.dir, "..", "..", "index.html"), "utf8");
const meta = (html: string, name: string) => new RegExp(`<meta name="${name}" content="([^"]*)"`).exec(html)?.[1];

test("the Home build names itself TinyCloud Home in every installed-app tag", () => {
  const html = homeSiteIndexHtml(source);
  expect(meta(html, "apple-mobile-web-app-title")).toBe("TinyCloud Home");
  expect(meta(html, "application-name")).toBe("TinyCloud Home");
  expect(meta(html, "description")).toBe("Updates and decisions from your agents, in your TinyCloud space.");
  expect(html).not.toMatch(/\bExo\b/);
});

test("only those three tags change", () => {
  const strip = (html: string) => html.replace(/<meta name="(?:apple-mobile-web-app-title|application-name|description)"[^>]*>\n?/g, "");
  expect(strip(homeSiteIndexHtml(source))).toBe(strip(source));
});
