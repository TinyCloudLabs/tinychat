import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { installDom } from "@/test/dom";
import { WebAccessToggle } from "./MainChat";

let restore: (() => void) | undefined;
let mounted: Root | undefined;
afterEach(() => {
  if (mounted) act(() => mounted!.unmount());
  mounted = undefined;
  restore?.();
  restore = undefined;
});

const OFF = { mode: "off", hosts: [], available: true, today: { searches: 0, pages: 0, blocked: 0 } } as const;

test("Main's chat reaches Web access through a button that loads the setting on demand", async () => {
  restore = installDom();
  let loads = 0;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mounted = root;
  await act(async () => root.render(<WebAccessToggle api={{ getMainWeb: async () => { loads++; return OFF; }, setMainWeb: async () => OFF }} />));
  const button = [...host.querySelectorAll("button")].find((node) => node.textContent === "Web access")!;
  expect(button.getAttribute("aria-expanded")).toBe("false");
  expect(loads).toBe(0);
  await act(async () => { button.click(); });
  await act(async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); });
  expect(loads).toBe(1);
  expect(button.getAttribute("aria-expanded")).toBe("true");
  expect(host.querySelector<HTMLInputElement>('input[type="radio"][value="off"]')?.checked).toBe(true);
  await act(async () => { button.click(); });
  expect(host.querySelector('input[type="radio"]')).toBeNull();
});
