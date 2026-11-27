import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { SessionStore } from "@tinyboilerplate/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { installDom } from "@/test/dom";
import { GranolaAllowBack } from "./GranolaAllowBack";

let root: Root;
let cleanup: () => void;
beforeEach(() => { cleanup = installDom(); });
afterEach(async () => { if (root) await act(async () => root.unmount()); cleanup(); });

const props = { tcw: {} as TinyCloudWeb, backendUrl: "https://backend.invalid", sessionStore: {} as SessionStore };

async function mount(extra: Record<string, unknown>) {
  const node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
  await act(async () => root.render(<GranolaAllowBack {...props} {...extra} />));
  return node;
}

test("the note sits under the action and is hidden while the confirmation is open", async () => {
  const node = await mount({ buttonClassName: "ms-btn2 ms-btn-wrap", note: "A note under the action.", noteClassName: "ms-opt-text" });
  const button = node.querySelector("button")!;
  expect(button.className).toBe("ms-btn2 ms-btn-wrap");
  expect(button.nextElementSibling?.textContent).toBe("A note under the action.");
  await act(async () => button.click());
  expect(node.querySelector('[role="group"]')).not.toBeNull();
  expect(node.textContent).not.toContain("A note under the action.");
});

test("without a button class the opening control is a shadcn button: a link by default, an outline on request", async () => {
  const link = await mount({});
  const linkClass = link.querySelector("button")!.className;
  await act(async () => root.unmount());
  const outline = await mount({ outline: true });
  expect(outline.querySelector("button")!.className).not.toBe(linkClass);
  expect(linkClass).toContain("underline");
});
