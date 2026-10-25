import { afterEach, expect, test } from "bun:test";
import { installDom } from "@/test/dom";
import { renderArticleHtml, secureArticleHtml } from "./articleMarkdown";

let restore: (() => void) | undefined;
afterEach(() => { restore?.(); restore = undefined; });

function secure(html: string) {
  restore = installDom();
  const host = document.createElement("div");
  host.innerHTML = secureArticleHtml(html);
  return host;
}

test("article https links open in a separate, isolated tab", () => {
  const host = secure('<p><a href="https://example.org/story">Example</a></p>');
  const link = host.querySelector("a");
  expect(link?.getAttribute("href")).toBe("https://example.org/story");
  expect(link?.getAttribute("target")).toBe("_blank");
  expect(link?.getAttribute("rel")).toBe("noopener noreferrer");
});

test.each(["javascript:alert(1)", "data:text/html,hello", "//example.org/story"])("unsafe article URL %s is plain text", (url) => {
  const host = secure(`<p><a href="${url}"><strong>Readable</strong> text</a></p>`);
  expect(host.querySelector("a")).toBeNull();
  expect(host.textContent).toBe("Readable text");
});

test("escaped nested HTML stays text rather than becoming an element", () => {
  const host = secure('<p><strong>Nested &lt;img src=x onerror=alert(1)&gt;</strong></p>');
  expect(host.querySelector("img")).toBeNull();
  expect(host.querySelector("strong")?.textContent).toBe("Nested <img src=x onerror=alert(1)>");
});

test.each([
  ['remote HTTP', '<img src="http://example.org/tracker.png" alt="HTTP alt">', "HTTP alt"],
  ['remote HTTPS', '<img src="https://example.org/tracker.png" alt="HTTPS alt">', "HTTPS alt"],
  ['protocol-relative', '<img src="//example.org/tracker.png" alt="Relative alt">', "Relative alt"],
  ['data URI', '<img src="data:image/svg+xml,evil" alt="Data alt">', "Data alt"],
  ['reference-style image output', '<img src="https://example.org/reference.png" alt="Reference alt">', "Reference alt"],
  ['raw HTML image output', '<img src="https://example.org/raw.png" onerror="alert(1)" alt="Raw alt">', "Raw alt"],
])("%s article image cannot create a resource element", (_kind, image, alt) => {
  const host = secure(`<p>${image} <a href="https://example.org/story">Story</a></p>`);
  expect(host.querySelector("img, picture, source, video, audio, iframe, object, embed, svg, link, style, script")).toBeNull();
  expect(host.textContent).toContain(alt);
  expect(host.querySelectorAll("[src], [href]")).toHaveLength(1);
  expect(host.querySelector("a")?.getAttribute("href")).toBe("https://example.org/story");
});

test("non-image resource elements and embedded SVG are removed with their descendants", () => {
  const host = secure('<p>Before</p><picture><source srcset="https://example.org/a"><img src="/a" alt="Picture alt"></picture><video src="https://example.org/v"><source src="/v"></video><audio src="/a"></audio><iframe src="//example.org"></iframe><object data="https://example.org"></object><embed src="/e"><svg><use href="https://example.org/icon"></use></svg><link href="https://example.org/x"><style>@import url(https://example.org/x)</style><script src="/script">alert(1)</script><p>After</p>');
  expect(host.querySelector("img, picture, source, video, audio, iframe, object, embed, svg, link, style, script")).toBeNull();
  expect(host.querySelector("[src], [href], [srcset], [data]")).toBeNull();
  expect(host.textContent).toContain("Before");
  expect(host.textContent).toContain("After");
  expect(host.textContent).not.toContain("alert(1)");
});

test("failed WASM initialization is retried on the first recovered attempt", async () => {
  restore = installDom();
  let blocked = true;
  let attempts = 0;
  const dependencies = {
    init: async () => {
      attempts++;
      if (blocked) throw new Error("WASM request blocked");
    },
    render: async () => '<p><img src="https://example.org/tracker.png" alt="Safe alt"> <a href="https://example.org/story">Story</a></p>',
  };
  await expect(renderArticleHtml("![Safe alt](https://example.org/tracker.png)", dependencies)).rejects.toThrow("WASM request blocked");
  blocked = false;
  const html = await renderArticleHtml("![Safe alt](https://example.org/tracker.png)", dependencies);
  const host = document.createElement("div");
  host.innerHTML = html;
  expect(attempts).toBe(2);
  expect(host.querySelector("img")).toBeNull();
  expect(host.textContent).toContain("Safe alt");
  expect(host.querySelector("a")?.getAttribute("rel")).toBe("noopener noreferrer");
});
