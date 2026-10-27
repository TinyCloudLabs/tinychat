import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { installDom } from "@/test/dom";
import { readTinyCloudButtonShown, TINYCLOUD_BUTTON_KEY } from "@/lib/tinycloudButton";
import { TinyCloudButtonSync } from "./TinyCloudButtonSync";
import { TINYCLOUD_COPY, TinyCloudSettings } from "./TinyCloudSettings";

let cleanDom: (() => void) | undefined;
let root: Root | undefined;
let host: HTMLElement;
beforeAll(() => { cleanDom = installDom(); });
afterAll(() => cleanDom?.());
beforeEach(() => {
  window.localStorage.clear();
  host = document.createElement("div");
  document.body.appendChild(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
});

function fakeTcw() {
  const opened: Array<string | undefined> = [];
  const visible: boolean[] = [];
  const tcw = { ui: { open: (section?: string) => opened.push(section), setButtonVisible: (v: boolean) => visible.push(v) } } as unknown as TinyCloudWeb;
  return { tcw, opened, visible };
}

function mount(tcw: TinyCloudWeb) {
  root = createRoot(host);
  act(() => root!.render(<><TinyCloudButtonSync tcw={tcw} /><TinyCloudSettings tcw={tcw} /></>));
}

const toggle = () => host.querySelector<HTMLButtonElement>('[role="switch"]')!;

describe("Settings > TinyCloud", () => {
  test("shows the section with the approved copy", () => {
    mount(fakeTcw().tcw);
    expect(host.querySelector("h2")?.textContent).toBe("TinyCloud");
    for (const text of [TINYCLOUD_COPY.toggleLabel, TINYCLOUD_COPY.toggleHelp, TINYCLOUD_COPY.rowLabel, TINYCLOUD_COPY.openButton]) {
      expect(host.textContent).toContain(text);
    }
    expect(TINYCLOUD_COPY.toggleLabel).toBe("Show the TinyCloud button");
    expect(TINYCLOUD_COPY.toggleHelp).toBe("A small button in the corner that opens your TinyCloud panel.");
    expect(TINYCLOUD_COPY.rowLabel).toBe("TinyCloud panel");
    expect(TINYCLOUD_COPY.openButton).toBe("Open");
  });

  test("the toggle is OFF by default", () => {
    mount(fakeTcw().tcw);
    expect(toggle().getAttribute("aria-checked")).toBe("false");
  });

  test("turning the toggle on persists it and shows the button without a reload", () => {
    const { tcw, visible } = fakeTcw();
    mount(tcw);
    expect(visible).toEqual([false]);
    act(() => toggle().click());
    expect(window.localStorage.getItem(TINYCLOUD_BUTTON_KEY)).toBe("true");
    expect(readTinyCloudButtonShown()).toBe(true);
    expect(toggle().getAttribute("aria-checked")).toBe("true");
    expect(visible).toEqual([false, true]);
    act(() => toggle().click());
    expect(readTinyCloudButtonShown()).toBe(false);
    expect(visible).toEqual([false, true, false]);
  });

  test("Open opens the TinyCloud panel", () => {
    const { tcw, opened } = fakeTcw();
    mount(tcw);
    const open = [...host.querySelectorAll("button")].find((b) => b.textContent === "Open")!;
    act(() => open.click());
    expect(opened).toEqual([undefined]);
  });
});

describe("TinyCloudButtonSync", () => {
  test("on load the saved value reaches setButtonVisible", () => {
    window.localStorage.setItem(TINYCLOUD_BUTTON_KEY, "true");
    const { tcw, visible } = fakeTcw();
    root = createRoot(host);
    act(() => root!.render(<TinyCloudButtonSync tcw={tcw} />));
    expect(visible).toEqual([true]);
  });

  test("on load with nothing saved the button is hidden", () => {
    const { tcw, visible } = fakeTcw();
    root = createRoot(host);
    act(() => root!.render(<TinyCloudButtonSync tcw={tcw} />));
    expect(visible).toEqual([false]);
  });
});
