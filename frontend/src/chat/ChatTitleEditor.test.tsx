import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { installDom } from "@/test/dom";
import { ChatTitleEditor } from "./ChatTitleEditor";

let restore: (() => void) | null = null;
let root: Root | null = null;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  restore?.();
  restore = null;
});

async function mount(initial: string) {
  restore = installDom();
  const saved: string[] = [];
  let cancelled = 0;
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(<ChatTitleEditor initial={initial} onSave={(t) => saved.push(t)} onCancel={() => { cancelled++; }} />));
  const input = container.querySelector("input") as HTMLInputElement;
  const type = async (value: string) => {
    const setter = Object.getOwnPropertyDescriptor(input.constructor.prototype, "value")!.set!;
    setter.call(input, value);
    await act(async () => {
      // happy-dom has no native `input` support, so React reads the change on key events.
      input.dispatchEvent(new KeyboardEvent("keyup", { key: "a", bubbles: true }));
    });
  };
  const key = (k: string) => act(async () => { input.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true })); });
  return { input, container, saved, cancelled: () => cancelled, type, key };
}

describe("ChatTitleEditor", () => {
  test("opens focused on the current title with a label", async () => {
    const e = await mount("Weekly recap");
    expect(e.input.value).toBe("Weekly recap");
    expect(document.activeElement).toBe(e.input);
    expect(e.input.getAttribute("aria-label")).toBe("Chat title");
  });

  test("Enter saves the edited title once", async () => {
    const e = await mount("Weekly recap");
    await e.type("Offsite plan");
    await e.key("Enter");
    expect(e.saved).toEqual(["Offsite plan"]);
    expect(e.cancelled()).toBe(0);
  });

  test("Escape cancels without saving, even when the field then loses focus", async () => {
    const e = await mount("Weekly recap");
    await e.type("Changed");
    await e.key("Escape");
    await act(async () => { e.input.blur(); });
    expect(e.saved).toEqual([]);
    expect(e.cancelled()).toBe(1);
  });

  test("an empty or whitespace title is passed through to clear the rename", async () => {
    const e = await mount("Weekly recap");
    await e.type("   ");
    await e.key("Enter");
    expect(e.saved).toEqual(["   "]);
  });

  test("the Cancel button cancels without saving", async () => {
    const e = await mount("Weekly recap");
    await e.type("Changed");
    const cancel = e.container.querySelector('button[aria-label="Cancel"]') as HTMLButtonElement;
    await act(async () => { cancel.click(); });
    expect(e.saved).toEqual([]);
    expect(e.cancelled()).toBe(1);
  });
});

describe("ChatTitleEditor on open", () => {
  test("selects the whole title and shows its start", async () => {
    const e = await mount("A long chat title that does not fit in the field");
    expect(e.input.selectionStart).toBe(0);
    expect(e.input.selectionEnd).toBe(e.input.value.length);
    expect(e.input.scrollLeft).toBe(0);
  });
});
