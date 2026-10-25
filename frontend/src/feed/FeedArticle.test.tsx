import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { installDom } from "@/test/dom";
import { parseFeed } from "./feedData";
import { FeedCardView } from "./FeedView";

const card = parseFeed([{ key: "aster/2026-10/2026-10-25T120000Z-article", value: { v: 1, at: "2026-10-25T12:00:00Z", render: "article", lead: { text: "Plain summary" }, title: "Headline", body: "aster/articles/note.md" } }])[0]!;
let restore: (() => void) | undefined;
afterEach(() => { restore?.(); restore = undefined; });

async function mount(renderArticle: (markdown: string) => Promise<string>, readBody = async () => "[Example](https://example.org)") {
  restore = installDom();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(<FeedCardView card={card} renderArticle={renderArticle} readBody={readBody} />));
  return { host, unmount: () => act(async () => root.unmount()) };
}

test("rendered article opens only safe links in an isolated tab", async () => {
  const view = await mount(async () => '<p><a href="https://example.org" target="_blank" rel="noopener noreferrer">Example</a> and unsafe</p>');
  const links = view.host.querySelectorAll("article a");
  expect(links).toHaveLength(1);
  expect(links[0]?.getAttribute("target")).toBe("_blank");
  expect(links[0]?.getAttribute("rel")).toBe("noopener noreferrer");
  expect(view.host.textContent).toContain("unsafe");
  await view.unmount();
});

test("unreadable body leaves title and summary visible with a reachable retry", async () => {
  const view = await mount(async () => "unused", async () => { throw new Error("missing markdown"); });
  expect(view.host.textContent).toContain("Headline");
  expect(view.host.textContent).toContain("Plain summary");
  expect(view.host.textContent).not.toContain("missing markdown");
  const retry = [...view.host.querySelectorAll("button")].find((button) => button.textContent === "Try again");
  expect(retry?.classList.contains("min-h-6")).toBe(true);
  await view.unmount();
});

test("first retry after blocked WASM renders article without another click", async () => {
  let blocked = true;
  let attempts = 0;
  const view = await mount(async () => {
    attempts++;
    if (blocked) throw new Error("WASM request blocked");
    return "<p>Recovered article</p>";
  });
  expect(view.host.textContent).toContain("Couldn't show the article preview.");
  blocked = false;
  const retry = [...view.host.querySelectorAll("button")].find((button) => button.textContent === "Try again");
  await act(async () => retry!.click());
  expect(attempts).toBe(2);
  expect(view.host.textContent).toContain("Recovered article");
  expect(view.host.textContent).not.toContain("Couldn't show the article preview.");
  await view.unmount();
});
