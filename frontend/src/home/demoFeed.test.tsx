import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { installDom } from "@/test/dom";
import { HomeDemoFeed } from "./demoFeed";

let restore: (() => void) | undefined;
const roots = new Set<Root>();
const originalFetch = globalThis.fetch;
afterEach(async () => {
  for (const root of roots) await act(async () => root.unmount());
  roots.clear();
  globalThis.fetch = originalFetch;
  restore?.(); restore = undefined;
});

async function mount() {
  restore ??= installDom();
  const calls: unknown[] = [];
  globalThis.fetch = (async (...args: unknown[]) => { calls.push(args); return new Response(null, { status: 500 }); }) as typeof fetch;
  window.navigator.sendBeacon = (...args: unknown[]) => { calls.push(args); return true; };
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.add(root);
  await act(async () => root.render(<HomeDemoFeed />));
  return { host, calls };
}
const click = (node: Element) => act(async () => { node.dispatchEvent(new window.MouseEvent("click", { bubbles: true })); });

test("answering the question shows the answered state, and Change answer brings the options back", async () => {
  const { host } = await mount();
  const card = host.querySelector('article[aria-label="Which flight should I hold for Thursday?"]')!;
  expect(card.textContent).toContain("Needs you");
  const options = [...card.querySelectorAll('[role="group"][aria-label="Answers"] button')];
  expect(options).toHaveLength(2);
  await click(options[0]!);
  const status = card.querySelector('[role="status"]');
  expect(status?.textContent).toContain("You chose 07:10 direct");
  expect(card.textContent).toContain("Answered");
  expect(card.querySelector('[role="group"][aria-label="Answers"]')).toBeNull();
  const change = [...card.querySelectorAll("button")].find((node) => node.textContent === "Change answer")!;
  await click(change);
  expect(card.querySelectorAll('[role="group"][aria-label="Answers"] button')).toHaveLength(2);
  expect(card.textContent).toContain("Needs you");
});

test("ticking a step strikes it, and unticking restores it", async () => {
  const { host } = await mount();
  const card = host.querySelector('article[aria-label="This week\'s reading list"]')!;
  const [first, second] = [...card.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
  const label = (box: HTMLInputElement) => box.closest("label")!.querySelector("span")!;
  expect(label(first!).className).not.toContain("line-through");
  await click(first!);
  expect(first!.checked).toBe(true);
  expect(label(first!).className).toContain("line-through");
  expect(label(second!).className).not.toContain("line-through");
  await click(first!);
  expect(label(first!).className).not.toContain("line-through");
});

test("answering and ticking send nothing over the network and store nothing in the browser", async () => {
  const { host, calls } = await mount();
  const snapshot = () => JSON.stringify([{ ...window.localStorage }, { ...window.sessionStorage }]);
  const before = snapshot();
  await click(host.querySelector("article button")!);
  await click(host.querySelector('input[type="checkbox"]')!);
  expect(calls).toEqual([]);
  expect(snapshot()).toBe(before);
  expect(window.localStorage.length + window.sessionStorage.length).toBe(0);
});

test("after answering, focus moves to the answered status so a screen reader hears it", async () => {
  const { host } = await mount();
  await click(host.querySelector("article button")!);
  const status = host.querySelector('[role="status"]');
  expect(status).not.toBeNull();
  expect(document.activeElement).toBe(status);
});
