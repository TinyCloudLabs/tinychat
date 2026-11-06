import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { installDom } from "@/test/dom";
import { MovedToChatPointer } from "./MovedToChatPointer";

let restoreDom: () => void;
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  restoreDom = installDom();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  restoreDom();
});

async function renderAt(path: string) {
  await act(async () => root.render(<MemoryRouter key={path} initialEntries={[path]}><MovedToChatPointer /></MemoryRouter>));
}
const openLink = () => [...host.querySelectorAll("a")].find((link) => link.textContent === "Open on tinycloud.chat");

test("says where the screen lives and links to the same path on tinycloud.chat", async () => {
  await renderAt("/chat/connectors");
  expect(host.querySelector("h1")?.textContent).toContain("This is on tinycloud.chat");
  expect(host.textContent).toContain("Recording and Connectors are part of TinyCloud Chat.");
  expect(openLink()?.getAttribute("href")).toBe("https://tinycloud.chat/chat/connectors");
});

test("keeps the whole path of a note and of the Library", async () => {
  await renderAt("/chat/capture/library/note%201");
  expect(openLink()?.getAttribute("href")).toBe("https://tinycloud.chat/chat/capture/library/note%201");
  await renderAt("/chat/capture");
  expect(openLink()?.getAttribute("href")).toBe("https://tinycloud.chat/chat/capture");
});

test("is plain content inside the shell's main: no main of its own, nothing that records or plays", async () => {
  await renderAt("/chat/capture");
  expect(host.querySelector("main")).toBeNull();
  expect(host.querySelectorAll("audio, video, input").length).toBe(0);
});
