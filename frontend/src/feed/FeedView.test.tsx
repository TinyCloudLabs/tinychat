import { afterEach, describe, expect, jest, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { installDom } from "@/test/dom";
import { FeedCardView, FeedView } from "./FeedView";
import type { FeedCard } from "./feedData";

const base: FeedCard = { v: 1, id: "one", at: "2026-10-25T12:00:00Z", author: { name: "Aster" }, render: "post", lead: "A little note.", source: { label: "Notebook" } };
let restore: (() => void) | undefined;
const originalFetch = globalThis.fetch;
afterEach(() => {
  jest.useRealTimers();
  globalThis.fetch = originalFetch;
  restore?.();
  restore = undefined;
});

async function mount() {
  restore = installDom();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(<FeedView />));
  return { host, unmount: () => act(async () => root.unmount()) };
}

const flush = async () => { await act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); }); };

describe("built-in sample cards", () => {
  test("each renderer shows its data, author, source and provenance", () => {
    const variants: FeedCard[] = [
      base,
      { ...base, render: "image", image: { src: "/home-feed-shapes.svg", alt: "Abstract shapes" } },
      { ...base, render: "thread", replies: [{ author: "Birch", text: "Second thought", at: base.at }] },
      { ...base, render: "article", title: "Short article", summary: "Summary of it" },
      { ...base, render: "link", url: "https://example.org/story", tldr: "Quick read" },
    ];
    const html = variants.map((card) => renderToStaticMarkup(<FeedCardView card={card} />));
    for (const item of html) {
      expect(item).toContain("Aster");
      expect(item).toContain("Notebook");
      expect(item).toContain("Sample content");
      expect(item).toContain("A little note.");
    }
    expect(html[1]).toContain('alt="Abstract shapes"');
    expect(html[2]).toContain("Second thought");
    expect(html[3]).toContain("Short article");
    expect(html[3]).toContain("Summary of it");
    expect(html[4]).toContain("Quick read");
    expect(html[4]).toContain('rel="noopener noreferrer"');
    expect(html[4]).toContain('target="_blank"');
  });

  test("unsafe link and absent image leave readable text without a clickable unsafe URL or broken image", () => {
    const link = renderToStaticMarkup(<FeedCardView card={{ ...base, render: "link", url: "javascript:alert(1)", tldr: "Saved for later" }} />);
    const image = renderToStaticMarkup(<FeedCardView card={{ ...base, render: "image" }} />);
    expect(link).toContain("Saved for later");
    expect(link).toContain("javascript:alert(1)");
    expect(link).not.toContain("<a ");
    expect(image).toContain("A little note.");
    expect(image).not.toContain("<img");
  });
});

describe("visible sample polling", () => {
  test("loads immediately, pauses when hidden, resumes once visible, and aborts on unmount", async () => {
    jest.useFakeTimers();
    const signals: AbortSignal[] = [];
    const held = Promise.withResolvers<Response>();
    globalThis.fetch = (async (_url, init) => {
      signals.push(init?.signal as AbortSignal);
      return signals.length === 1 ? Response.json([base]) : held.promise;
    }) as typeof fetch;
    const view = await mount();
    await flush();
    expect(signals).toHaveLength(1);
    expect(view.host.textContent).toContain("A little note.");
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    jest.advanceTimersByTime(90_000);
    await flush();
    expect(signals).toHaveLength(1);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    expect(signals).toHaveLength(2);
    await view.unmount();
    expect(signals[1]?.aborted).toBe(true);
  });

  test("hiding aborts a pending fetch and ignores its late completion", async () => {
    jest.useFakeTimers();
    const held = Promise.withResolvers<Response>();
    let signal: AbortSignal | undefined;
    let calls = 0;
    globalThis.fetch = (async (_url, init) => {
      calls++;
      signal = init?.signal as AbortSignal;
      return held.promise;
    }) as typeof fetch;
    const view = await mount();
    expect(calls).toBe(1);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    expect(signal?.aborted).toBe(true);
    held.resolve(Response.json([base]));
    await flush();
    expect(view.host.textContent).not.toContain("A little note.");
    jest.advanceTimersByTime(90_000);
    expect(calls).toBe(1);
    await view.unmount();
  });

  test("no request overlaps a held fetch; last cards remain after a failed refresh", async () => {
    jest.useFakeTimers();
    let calls = 0;
    const held = Promise.withResolvers<Response>();
    globalThis.fetch = (async () => ++calls === 1 ? Response.json([base]) : held.promise) as typeof fetch;
    const view = await mount();
    await flush();
    jest.advanceTimersByTime(30_000);
    await flush();
    expect(calls).toBe(2);
    jest.advanceTimersByTime(90_000);
    await flush();
    expect(calls).toBe(2);
    held.reject(new Error("offline"));
    await flush();
    expect(view.host.textContent).toContain("A little note.");
    expect(view.host.textContent).toContain("Couldn't refresh");
    await view.unmount();
  });

  test("first-load failure offers one-click retry that shows recovered cards", async () => {
    let calls = 0;
    globalThis.fetch = (async () => ++calls === 1 ? new Response("offline", { status: 503 }) : Response.json([base])) as typeof fetch;
    const view = await mount();
    await flush();
    expect(view.host.textContent).toContain("Couldn't load the sample cards.");
    const retry = [...view.host.querySelectorAll("button")].find((button) => button.textContent === "Try again");
    expect(retry).toBeDefined();
    await act(async () => retry!.click());
    await flush();
    expect(calls).toBe(2);
    expect(view.host.textContent).toContain("A little note.");
    expect(view.host.textContent).not.toContain("Couldn't load");
    await view.unmount();
  });

  test("empty or missing sample file shows a distinct empty state", async () => {
    globalThis.fetch = (async () => new Response("missing", { status: 404 })) as typeof fetch;
    const view = await mount();
    await flush();
    expect(view.host.textContent).toContain("Nothing here yet");
    await view.unmount();
  });
});
