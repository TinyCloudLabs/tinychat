import { afterEach, describe, expect, jest, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { installDom } from "@/test/dom";
import { FeedCardView, FeedViewEntries } from "./FeedView";
import { parseFeed } from "./feedData";

const at = "2026-10-25T12:00:00Z";
const key = "aster/2026-10/2026-10-25T120000Z-note";
const base = { key, value: { v: 1, at, render: "post", lead: { text: "A little note." }, source: { label: "Notebook" } } };
const profile = { key: "aster/profile", value: { v: 1, name: "Aster", client: "sample", about: "Notes" } };
const card = (value: object, suffix: string) => parseFeed([profile, { key: `aster/2026-10/2026-10-25T120000Z-${suffix}`, value: { ...base.value, ...value } }])[0]!;
let restore: (() => void) | undefined;
const originalFetch = globalThis.fetch;
afterEach(() => { jest.useRealTimers(); globalThis.fetch = originalFetch; restore?.(); restore = undefined; });

async function mount(realEntries: unknown[] = []) {
  restore = installDom();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(<FeedViewEntries realEntries={realEntries} />));
  return { host, showReal: (entries: unknown[]) => act(async () => root.render(<FeedViewEntries realEntries={entries} />)), unmount: () => act(async () => root.unmount()) };
}
const flush = async () => { await act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); }); };

describe("built-in feed cards", () => {
  test("all five renderers show lead, profile and source; thread replies, article title and link work", () => {
    const variants = [
      card({}, "post"),
      card({ render: "image", lead: { text: "Caption", image: "aster/assets/shapes.svg" } }, "image"),
      card({ render: "thread", replies: [{ text: "Second thought" }] }, "thread"),
      card({ render: "article", title: "Short article" }, "article"),
      card({ render: "link", url: "https://example.org/story" }, "link"),
    ];
    const html = variants.map((item) => renderToStaticMarkup(<FeedCardView card={item} />));
    for (const item of html) { expect(item).toContain("Aster"); expect(item).toContain("Notebook"); expect(item).toContain("Sample content"); }
    expect(html[1]).toContain("Caption");
    expect(html[2]).toContain("Second thought");
    expect(html[3]).toContain("Short article");
    expect(html[4]).toContain('rel="noopener noreferrer"');
  });

  test("sample image key resolves only to its bundled local asset", () => {
    const [image] = parseFeed([
      { key: "birch/profile", value: { v: 1, name: "Birch", client: "sample", about: "Images" } },
      { key: "birch/2026-10/2026-10-25T120000Z-shapes", value: { v: 1, at, render: "image", lead: { text: "Abstract shapes", image: "birch/assets/shapes.svg" } } },
    ]);
    const html = renderToStaticMarkup(<FeedCardView card={image!} />);
    expect(html).toContain('src="/home-feed-shapes.svg"');
    expect(html).toContain('alt="Abstract shapes"');
    expect(html).not.toContain("https://");
  });

  test("unknown renderer and unsafe link keep lead without unsafe click target; source ref is plain text", () => {
    const unknown = renderToStaticMarkup(<FeedCardView card={card({ render: "video", source: { label: "Record", ref: "other/entry" } }, "video")} />);
    const link = renderToStaticMarkup(<FeedCardView card={card({ render: "link", url: "javascript:alert(1)" }, "link")} />);
    expect(unknown).toContain("A little note.");
    expect(unknown).toContain("other/entry");
    expect(unknown).not.toContain("<a ");
    expect(link).not.toContain("<a ");
  });

  test("article without body still shows title and lead; remote media key never produces an image", () => {
    const article = renderToStaticMarkup(<FeedCardView card={card({ render: "article", title: "Readable" }, "article")} />);
    const image = renderToStaticMarkup(<FeedCardView card={card({ render: "image", lead: { text: "Caption", image: "https://example.org/track.png" } }, "image")} />);
    expect(article).toContain("Readable");
    expect(article).toContain("A little note.");
    expect(image).not.toContain("<img");
  });
});

describe("visible sample polling", () => {
  test("shows get-started and dummy cards, switching to real entries removes both", async () => {
    globalThis.fetch = (async () => Response.json([profile, base])) as typeof fetch;
    const view = await mount();
    await flush();
    expect(view.host.textContent).toContain("Get started");
    expect(view.host.textContent).toContain("Ask your agent to post to your feed. Its cards show up here.");
    expect(view.host.textContent).toContain("Sample content");
    expect(view.host.querySelector("a[href='https://agents.tinycloud.xyz/']")?.textContent).toBe("How agents post");
    await view.showReal([{ ...base, value: { ...base.value, lead: { text: "Real card" } } }]);
    expect(view.host.textContent).toContain("Real card");
    expect(view.host.textContent).not.toContain("Sample content");
    expect(view.host.textContent).not.toContain("Get started");
    await view.unmount();
  });

  test("loads immediately, pauses when hidden, resumes once visible, and aborts on unmount", async () => {
    jest.useFakeTimers();
    const signals: AbortSignal[] = [];
    const held = Promise.withResolvers<Response>();
    globalThis.fetch = (async (_url, init) => { signals.push(init?.signal as AbortSignal); return signals.length === 1 ? Response.json([profile, base]) : held.promise; }) as typeof fetch;
    const view = await mount(); await flush();
    expect(signals).toHaveLength(1);
    expect(view.host.textContent).toContain("A little note.");
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    jest.advanceTimersByTime(90_000); await flush(); expect(signals).toHaveLength(1);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    expect(signals).toHaveLength(2);
    await view.unmount(); expect(signals[1]?.aborted).toBe(true);
  });

  test("hiding aborts pending fetch and ignores its late completion", async () => {
    jest.useFakeTimers();
    const held = Promise.withResolvers<Response>();
    let signal: AbortSignal | undefined; let calls = 0;
    globalThis.fetch = (async (_url, init) => { calls++; signal = init?.signal as AbortSignal; return held.promise; }) as typeof fetch;
    const view = await mount(); expect(calls).toBe(1);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    expect(signal?.aborted).toBe(true);
    held.resolve(Response.json([profile, base])); await flush();
    expect(view.host.textContent).not.toContain("A little note.");
    jest.advanceTimersByTime(90_000); expect(calls).toBe(1);
    await view.unmount();
  });

  test("held request never overlaps; last good cards remain after failed refresh", async () => {
    jest.useFakeTimers(); let calls = 0;
    const held = Promise.withResolvers<Response>();
    globalThis.fetch = (async () => ++calls === 1 ? Response.json([profile, base]) : held.promise) as typeof fetch;
    const view = await mount(); await flush();
    jest.advanceTimersByTime(30_000); await flush(); expect(calls).toBe(2);
    jest.advanceTimersByTime(90_000); await flush(); expect(calls).toBe(2);
    held.reject(new Error("offline")); await flush();
    expect(view.host.textContent).toContain("A little note.");
    expect(view.host.textContent).toContain("Couldn't refresh");
    await view.unmount();
  });

  test("first-load failure retries once and missing sample shows get-started plus empty", async () => {
    let calls = 0;
    globalThis.fetch = (async () => ++calls === 1 ? new Response("offline", { status: 503 }) : new Response("missing", { status: 404 })) as typeof fetch;
    const view = await mount(); await flush();
    expect(view.host.textContent).toContain("Couldn't load the sample cards.");
    const retry = [...view.host.querySelectorAll("button")].find((button) => button.textContent === "Try again");
    await act(async () => retry!.click()); await flush();
    expect(calls).toBe(2);
    expect(view.host.textContent).toContain("Nothing here yet");
    expect(view.host.textContent).toContain("Get started");
    await view.unmount();
  });

});
