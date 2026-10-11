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

  test("an output without main.fmd is an error, not an empty note", () => {
    expect(() => extractMain("<html></html>")).toThrow("main");
  });
});
