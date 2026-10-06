// How it works (/chat/about): every section in lib/about.ts renders as an
// anchor a HowItWorksLink can land on, with a heading the page can focus.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";

import { HowItWorksLink } from "@/components/ui/how-it-works-link";
import { ABOUT_PATH, ABOUT_SECTIONS, aboutHref } from "@/lib/about";
import { ABOUT_BODY, AboutPage } from "./AboutPage";

const render = (path: string) =>
  renderToStaticMarkup(
    <MemoryRouter initialEntries={[path]}>
      <AboutPage onBack={() => {}} />
    </MemoryRouter>,
  );

describe("How it works", () => {
  const markup = render(ABOUT_PATH);

  test("every ABOUT_SECTIONS id renders as an anchor, in order, with its title as a focusable heading", () => {
    const anchors = [...markup.matchAll(/<section id="([^"]+)"/g)].map((match) => match[1]);
    expect(anchors).toEqual(ABOUT_SECTIONS.map((section) => section.id));
    for (const section of ABOUT_SECTIONS) {
      expect(markup).toContain(`aria-labelledby="about-${section.id}-heading"`);
      expect(markup).toMatch(new RegExp(`<h2 id="about-${section.id}-heading" tabindex="-1"[^>]*>${section.title}</h2>`));
      // Each section has words of its own.
      expect(ABOUT_BODY[section.id]).toBeTruthy();
    }
  });

  test("a large title and Back, like any pushed page", () => {
    expect(markup).toContain(">How it works<");
    expect(markup).toMatch(/<button type="button"[^>]*>.*Back<\/button>/);
  });

  test("a section's link lands on its anchor", () => {
    for (const section of ABOUT_SECTIONS) {
      const link = renderToStaticMarkup(
        <MemoryRouter>
          <HowItWorksLink section={section.id} />
        </MemoryRouter>,
      );
      expect(link).toContain(`href="${ABOUT_PATH}#${section.id}"`);
      expect(aboutHref(section.id)).toBe(`/chat/about#${section.id}`);
      expect(markup).toContain(`id="${section.id}"`);
    }
  });

  test("prose is set at a readable measure and 16 px", () => {
    expect(markup.match(/max-w-\[65ch\][^"]*text-body/g)).toHaveLength(ABOUT_SECTIONS.length);
  });

  test("every HowItWorksLink in the app points at a section that exists", () => {
    const ids = new Set<string>(ABOUT_SECTIONS.map((section) => section.id));
    const root = join(import.meta.dir, "..");
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.tsx$/.test(name) && !/\.test\.tsx$/.test(name)) files.push(path);
      }
    };
    walk(root);
    const used = files.flatMap((file) =>
      [...readFileSync(file, "utf8").matchAll(/<HowItWorksLink section="([^"]+)"/g)].map((match) => match[1]!),
    );
    expect(used.length).toBeGreaterThan(0);
    for (const id of used) expect(ids.has(id)).toBe(true);
  });
});
