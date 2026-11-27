import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import type { SessionStore } from "@tinyboilerplate/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { installDom } from "@/test/dom";
import { GranolaAllowBack } from "./GranolaAllowBack";

let root: Root | null = null;
let cleanup: (() => void) | null = null;
beforeEach(() => { cleanup = installDom(); });
afterEach(async () => { if (root) await act(async () => root?.unmount()); root = null; cleanup?.(); });

test("Fireflies allow-back action and confirmation identify Fireflies", async () => {
  const node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
  await act(async () => root?.render(<GranolaAllowBack source="fireflies" tcw={{} as TinyCloudWeb}
    backendUrl="https://backend.invalid" sessionStore={{} as SessionStore}
    note="After this, Fireflies syncs can bring back meetings you deleted." />));
  const action = node.querySelector("button")!;
  expect(action.textContent).toBe("Allow deleted Fireflies meetings back");
  await act(async () => action.click());
  const confirm = node.querySelector('[role="group"]')!;
  expect(confirm.getAttribute("aria-label")).toBe("Allow deleted Fireflies meetings back?");
  expect(confirm.textContent).toContain("Fireflies");
});

test("Fireflies allow-back note sits below the action and hides while confirmation is open", async () => {
  const note = "After this, Fireflies syncs can bring back meetings you deleted.";
  const html = renderToStaticMarkup(<GranolaAllowBack source="fireflies" tcw={{} as TinyCloudWeb}
    backendUrl="https://backend.invalid" sessionStore={{} as SessionStore} note={note} />);
  expect(html.indexOf("Allow deleted Fireflies meetings back")).toBeGreaterThan(-1);
  expect(html.indexOf(note)).toBeGreaterThan(html.indexOf("Allow deleted Fireflies meetings back"));
  const node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
  await act(async () => root?.render(<GranolaAllowBack source="fireflies" tcw={{} as TinyCloudWeb}
    backendUrl="https://backend.invalid" sessionStore={{} as SessionStore} note={note} />));
  await act(async () => node.querySelector("button")!.click());
  expect(node.textContent).not.toContain(note);
});

test("Google Meet allow-back action, confirmation and note identify Google Meet", async () => {
  const node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
  await act(async () => root?.render(<GranolaAllowBack source="google-meet" tcw={{} as TinyCloudWeb}
    backendUrl="https://backend.invalid" sessionStore={{} as SessionStore} note="Google Meet meetings can return after this." />));
  const action = node.querySelector("button")!;
  expect(action.textContent).toBe("Allow deleted Google Meet meetings back");
  expect(node.textContent).toContain("Google Meet meetings can return after this.");
  await act(async () => action.click());
  const confirm = node.querySelector('[role="group"]')!;
  expect(confirm.getAttribute("aria-label")).toBe("Allow deleted Google Meet meetings back?");
  expect(confirm.textContent).toContain("Google Meet");
  expect(node.textContent).not.toContain("Google Meet meetings can return after this.");
});
