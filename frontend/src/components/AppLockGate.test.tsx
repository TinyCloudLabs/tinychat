import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { installDom } from "@/test/dom";
import { createAppLock, type AppLockNative, type UnlockResult } from "@/lib/appLock";
import { AppLockGate } from "./AppLockGate";

let root: Root | null = null;
let restoreDom: (() => void) | null = null;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  restoreDom?.();
  restoreDom = null;
});

function fakeNative(results: UnlockResult[]): AppLockNative & { calls: number } {
  return {
    calls: 0,
    async status() { return { biometry: "faceID", biometryEnrolled: true, deviceSecure: true }; },
    async authenticate() { this.calls++; return { result: results.shift() ?? "cancelled" }; },
    async setCover() {},
    async reveal() {},
    async addListener() { return { remove: async () => {} }; },
  };
}

async function mount(results: UnlockResult[]) {
  restoreDom = installDom();
  const native = fakeNative(results);
  const lock = createAppLock({ native, storage: null, signedIn: true, afterPaint: (callback) => callback() });
  const host = document.createElement("div");
  host.id = "root";
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(<AppLockGate lock={lock} />));
  return { host, native };
}

const dialog = () => document.querySelector('[data-testid="app-lock"]');
const click = (node: Element) => act(async () => { node.dispatchEvent(new window.MouseEvent("click", { bubbles: true })); });

test("a cancelled Face ID keeps the lock screen up, the app inert behind it; Retry unlocks", async () => {
  const { host, native } = await mount(["cancelled", "success"]);
  expect(native.calls).toBe(1);
  expect(dialog()?.textContent).toContain("TinyCloud Home is locked");
  expect(host.hasAttribute("inert")).toBe(true);
  const retry = dialog()!.querySelector("button")!;
  expect(retry.textContent).toBe("Unlock with Face ID");
  await click(retry);
  expect(native.calls).toBe(2);
  expect(dialog()).toBeNull();
  expect(host.hasAttribute("inert")).toBe(false);
});

test("a failed attempt says so", async () => {
  await mount(["failed"]);
  expect(dialog()?.querySelector('[role="alert"]')?.textContent).toContain("didn't unlock");
});
