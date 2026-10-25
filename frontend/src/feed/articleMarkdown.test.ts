import { afterEach, expect, test } from "bun:test";
import { installDom } from "@/test/dom";
import { secureArticleHtml } from "./articleMarkdown";

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
