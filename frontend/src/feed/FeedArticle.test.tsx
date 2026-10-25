import { afterEach, expect, mock, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { installDom } from "@/test/dom";

let fail = false;
mock.module("@franken-suite/franken-markdown", () => ({ init: async () => {} }));
mock.module("@/capture/recorder/final/notes/renderMarkdown", () => ({
  renderNoteHtml: async () => {
    if (fail) throw new Error("WASM unavailable");
    return '<p><a href="https://example.org">Example</a> and <a href="data:text/html,bad">unsafe</a></p>';
  },
}));
const { FeedCardView } = await import("./FeedView");
const card = { v: 1 as const, id: "article", at: "2026-10-25T12:00:00Z", author: { name: "Aster" }, render: "article" as const, lead: "Plain lead", title: "Headline", summary: "Plain summary", markdown: "[Example](https://example.org)" };
let restore: (() => void) | undefined;
afterEach(() => { restore?.(); restore = undefined; fail = false; });

async function mount() {
  restore = installDom();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(<FeedCardView card={card} />));
  return { host, unmount: () => act(async () => root.unmount()) };
}

test("rendered article opens only safe links in an isolated tab", async () => {
  const view = await mount();
  const links = view.host.querySelectorAll("article a");
  expect(links).toHaveLength(1);
  expect(links[0]?.getAttribute("target")).toBe("_blank");
  expect(links[0]?.getAttribute("rel")).toBe("noopener noreferrer");
  expect(view.host.textContent).toContain("unsafe");
  await view.unmount();
});

test("renderer failure leaves the lead and summary readable and retry reachable", async () => {
  fail = true;
  const view = await mount();
  expect(view.host.textContent).toContain("Plain lead");
  expect(view.host.textContent).toContain("Plain summary");
  expect(view.host.textContent).not.toContain("WASM unavailable");
  const retry = [...view.host.querySelectorAll("button")].find((button) => button.textContent === "Try again");
  expect(retry?.classList.contains("min-h-6")).toBe(true);
  await view.unmount();
});
