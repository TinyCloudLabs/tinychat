import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { installDom } from "@/test/dom";
import { CourierThreads } from "./CourierThreads";
import type { CourierThreadsApi } from "./courierThreadsApi";

let root: Root | undefined;
let restore: (() => void) | undefined;
afterEach(() => { if (root) act(() => root!.unmount()); root = undefined; restore?.(); restore = undefined; });
const id = "a".repeat(64);
const thread = { id, peer: "cli", title: "cli (Courier)", messages: [{ role: "peer" as const, text: "What is on Home?", at: 1_800_000_000_000 }, { role: "bot" as const, text: "A release review needs your attention.", at: 1_800_000_000_001 }] };
async function render(api: CourierThreadsApi) {
  restore = installDom(); const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(<CourierThreads api={api} />));
  return host;
}
const button = (host: HTMLElement, text: string) => Array.from(host.querySelectorAll("button")).find(b => b.textContent === text)!;

test("owner opens an isolated peer conversation, sees reply and can delete it", async () => {
  let deleted = false;
  const api: CourierThreadsApi = { list: async () => deleted ? [] : [{ id, title: thread.title, peer: "cli", updatedAt: 1_800_000_000_001 }], read: async () => thread, remove: async value => { expect(value).toBe(id); deleted = true; }, unpair: async () => {} };
  const host = await render(api);
  await act(async () => button(host, "cli (Courier)").click());
  expect(host.textContent).toContain("What is on Home?"); expect(host.textContent).toContain("A release review needs your attention.");
  expect(host.querySelector("textarea,input")).toBeNull();
  await act(async () => button(host, "Delete conversation").click());
  expect(host.querySelector('[role="alertdialog"]')?.textContent).toContain("The agent stays paired.");
  await act(async () => button(host, "Delete").click());
  expect(deleted).toBe(true); expect(host.textContent).not.toContain("What is on Home?");
});

test("disabled Courier exposes no thread controls", async () => {
  const host = await render({ list: async () => null, read: async () => thread, remove: async () => {}, unpair: async () => {} });
  expect(host.textContent).toBe("");
});
