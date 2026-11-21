import { expect, test } from "bun:test";
import { htmlToText, MAX_TEXT_CHARS, pageText } from "../page-text";
import { plainWebText } from "../web";

// Each of these cost seconds of blocked event loop (B1) or hundreds of megabytes (N2) before the fix. The limits are
// far above the linear cost (a few milliseconds) and far below the old one, so they hold on a slow machine too.
const base = new URL("https://docs.example.com/long/path/index.html");

function elapsed(run: () => unknown): number {
  const start = performance.now();
  run();
  return performance.now() - start;
}

test("openers with no closer cost time linear in the page, not quadratic", () => {
  const markdownImages = "![".repeat(60_000);
  const markdownLinks = "![a](".repeat(30_000);
  const references = "![a][".repeat(30_000);
  const htmlImages = "<img alt=".repeat(30_000);
  const tags = "<a".repeat(60_000);
  for (const text of [markdownImages, markdownLinks, references, htmlImages, tags]) {
    expect(elapsed(() => plainWebText(text))).toBeLessThan(500);
  }
});

test("entity-encoded openers in a page cost the same once decoded", async () => {
  const start = performance.now();
  const decoded = await htmlToText("&lt;img".repeat(60_000), base);
  expect(decoded.startsWith("<img<img")).toBe(true);
  expect(elapsed(() => plainWebText(decoded))).toBeLessThan(500);
  expect(performance.now() - start).toBeLessThan(5_000);
});

test("ordinary markup is still turned into its alt text and plain text", () => {
  expect(plainWebText('See ![a chart](https://evil.example/x.png?q=1) and ![b][ref] and <img src="x" alt="a map"> <b>bold</b>')).toBe("See a chart and b and a map bold");
  expect(plainWebText("fine <p>text</p> a <<< b >>> c")).toBe("fine text a  b  c");
});

test("a page of tiny links cannot grow into more than the output cap while it is built", async () => {
  const page = `<p>${"<a href=?></a>".repeat(Math.floor((1000 * 1024) / 14))}</p>`;
  expect(page.length).toBeLessThanOrEqual(1024 * 1024);
  const before = process.memoryUsage().rss;
  const text = await htmlToText(page, base);
  expect(text.length).toBeLessThanOrEqual(2 * MAX_TEXT_CHARS);
  expect(text).toContain("(https://docs.example.com/long/path/index.html?)");
  // The old output was about 150 million characters and a 500 MB peak.
  expect(process.memoryUsage().rss - before).toBeLessThan(200 * 1024 * 1024);
});

test("a page of tiny links with long addresses stops at the cap too", async () => {
  const page = `<p>${`<a href="/${"a".repeat(1900)}">x</a>`.repeat(2000)}</p>`;
  const text = await pageText(new TextEncoder().encode(page), "text/html", base, "text/html");
  expect(text.length).toBeLessThanOrEqual(2 * MAX_TEXT_CHARS);
  expect(text.length).toBeGreaterThan(MAX_TEXT_CHARS);
});
