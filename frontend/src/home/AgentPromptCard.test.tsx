import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { installDom } from "@/test/dom";
import { AgentPromptCard } from "./AgentPromptCard";
import { WELCOME_AGENT_PROMPT } from "@/lib/homeStrings";

let restore: (() => void) | undefined;
const roots = new Set<Root>();
afterEach(async () => {
  for (const root of roots) await act(async () => root.unmount());
  roots.clear();
  restore?.(); restore = undefined;
});

async function mount(writeText: (text: string) => Promise<void>) {
  restore ??= installDom();
  Object.defineProperty(window.navigator, "clipboard", { value: { writeText }, configurable: true });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.add(root);
  await act(async () => root.render(<AgentPromptCard />));
  return host;
}
const click = (node: Element) => act(async () => { node.dispatchEvent(new window.MouseEvent("click", { bubbles: true })); });

test("the prompt sends an agent to the feed guide", () => {
  expect(WELCOME_AGENT_PROMPT).toContain("https://agents.tinycloud.xyz/feed");
});

test("Copy prompt puts the exact prompt on the clipboard and says so", async () => {
  const copied: string[] = [];
  const host = await mount(async (text) => { copied.push(text); });
  expect(host.textContent).toContain(WELCOME_AGENT_PROMPT);
  const button = [...host.querySelectorAll("button")].find((node) => node.textContent === "Copy prompt")!;
  await click(button);
  expect(copied).toEqual([WELCOME_AGENT_PROMPT]);
  expect(host.querySelector('[role="status"]')?.textContent).toBe("Copied");
});

test("a refused clipboard selects the prompt so it can be copied by hand", async () => {
  const host = await mount(async () => { throw new Error("denied"); });
  const button = [...host.querySelectorAll("button")].find((node) => node.textContent === "Copy prompt")!;
  await click(button);
  expect(host.querySelector('[role="status"]')?.textContent).toBe("Select the prompt and copy it");
  expect(window.getSelection()?.toString()).toBe(WELCOME_AGENT_PROMPT);
});
