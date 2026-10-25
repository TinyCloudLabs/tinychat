import { afterEach, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { installDom } from "@/test/dom";
import { parseFeed } from "./feedData";
import { FeedCardView } from "./FeedView";

const article = (body?: string) => parseFeed([{ key: "dune/2026-10/2026-10-25T120000Z-article", value: {
  v: 1, at: "2026-10-25T12:00:00Z", render: "article", lead: { text: "Plain summary" }, title: "Headline", body,
} }])[0]!;
let restore: (() => void) | undefined;
afterEach(() => { restore?.(); restore = undefined; });

async function mount(body: string | undefined, readBody: (key: string, signal: AbortSignal) => Promise<string>) {
  restore = installDom();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(<FeedCardView card={article(body)} readBody={readBody} />));
  return { host, unmount: () => act(async () => root.unmount()) };
}

test("article body splits on blank lines into plain paragraphs", async () => {
  let requestedKey = "";
  const view = await mount("dune/articles/second-glance.md", async (key) => {
    requestedKey = key;
    return "First line\nstill first.\n\n  Second paragraph.\r\n\r\nThird.";
  });
  expect(requestedKey).toBe("dune/articles/second-glance.md");
  expect([...view.host.querySelectorAll("article .article-body p")].map((p) => p.textContent))
    .toEqual(["First line\nstill first.", "Second paragraph.", "Third."]);
  expect(view.host.textContent).toContain("Headline");
  expect(view.host.textContent).toContain("Plain summary");
  await view.unmount();
});

test("raw HTML, images and javascript links remain inert literal paragraph text", async () => {
  const raw = '<img src="https://example.org/tracker.png" onerror="alert(1)"> [Click](javascript:alert(1)) <script>alert(2)</script>';
  const view = await mount("dune/articles/second-glance.md", async () => raw);
  const body = view.host.querySelector(".article-body");
  expect(body?.querySelector("p")?.textContent).toBe(raw);
  expect(body?.querySelector("a, img, script")).toBeNull();
  expect(body?.innerHTML).toContain("&lt;img");
  expect(body?.innerHTML).not.toContain("<script>");
  await view.unmount();
});

test("missing body key skips loading and keeps title and summary", async () => {
  let loads = 0;
  const view = await mount(undefined, async () => { loads++; return "unused"; });
  expect(loads).toBe(0);
  expect(view.host.textContent).toContain("Headline");
  expect(view.host.textContent).toContain("Plain summary");
  expect(view.host.querySelector(".article-body, article button")).toBeNull();
  await view.unmount();
});

test("unreadable body keeps only title and summary without preview retry", async () => {
  const view = await mount("dune/articles/second-glance.md", async () => { throw new Error("missing body"); });
  expect(view.host.textContent).toContain("Headline");
  expect(view.host.textContent).toContain("Plain summary");
  expect(view.host.textContent).not.toContain("missing body");
  expect(view.host.querySelector(".article-body, article button")).toBeNull();
  await view.unmount();
});

test("oversized body is omitted rather than truncated into an article preview", async () => {
  const view = await mount("dune/articles/second-glance.md", async () => "A".repeat(20_001));
  expect(view.host.textContent).toContain("Headline");
  expect(view.host.textContent).toContain("Plain summary");
  expect(view.host.querySelector(".article-body")).toBeNull();
  await view.unmount();
});

test("feed production modules have no markdown renderer or HTML injection path", () => {
  const source = readdirSync(new URL(".", import.meta.url))
    .filter((name) => /\.(ts|tsx)$/.test(name) && !name.includes(".test."))
    .map((name) => readFileSync(new URL(name, import.meta.url), "utf8"))
    .join("\n");
  expect(source).not.toContain("renderMarkdown");
  expect(source).not.toContain("franken-markdown");
  expect(source).not.toContain("dangerouslySetInnerHTML");
});
