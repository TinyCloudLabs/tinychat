// TC-2199: the Settings word fixes list: add, edit and delete a pair inline; Enter saves, Escape cancels.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { combineSpace } from "@/harness/fixtures/combineSpace";
import { getSetting, useLocalThreadStorage } from "@/lib/threadStore";
import { parseWordFixes, WORD_FIXES_SETTING_KEY } from "@/lib/wordFixes/wordFixes";
import { resetWordFixesForTest } from "@/lib/wordFixes/wordFixesStore";
import { installDom } from "@/test/dom";
import { WordFixesSettings } from "./WordFixesSettings";

let cleanup: () => void = () => {};

let root: Root | null = null;
let space = combineSpace([], { did: "did:test:word-fixes-settings" });

beforeEach(async () => {
  cleanup = installDom();
  resetWordFixesForTest();
  space = combineSpace([], { did: "did:test:word-fixes-settings" });
  useLocalThreadStorage(space.tcw);
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(<WordFixesSettings tcw={space.tcw} />));
});
afterEach(async () => {
  await act(async () => root!.unmount());
  cleanup();
  resetWordFixesForTest();
});

const byLabel = (label: string) => document.querySelector(`[aria-label="${label}"]`) as HTMLElement | null;
const buttonText = (text: string) => [...document.querySelectorAll("button")].find((button) => button.textContent === text)!;
const type = async (label: string, value: string) => {
  const input = byLabel(label) as HTMLInputElement;
  input.focus();
  Object.getOwnPropertyDescriptor(input.constructor.prototype, "value")?.set?.call(input, value);
  await act(async () => input.dispatchEvent(new InputEvent("input", { bubbles: true, data: value, inputType: "insertText" })));
};
const key = (label: string, name: string) => act(async () => {
  byLabel(label)!.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }));
});
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
const stored = async () => parseWordFixes(await getSetting(space.tcw, WORD_FIXES_SETTING_KEY));
const shown = () => [...document.querySelectorAll('[data-testid="word-fix"]')].map((row) => row.textContent);

async function add(find: string, replace: string) {
  await act(async () => { buttonText("Add a word fix").click(); });
  await type("Replace this", find);
  await type("With this", replace);
  await key("With this", "Enter");
  await settle();
}

describe("word fixes in Settings", () => {
  test("starts empty and Enter saves a new pair to the space", async () => {
    expect(document.querySelector('[data-testid="word-fixes-empty"]')).not.toBeNull();
    await add("tiny cloud", "TinyCloud");
    expect(shown()).toEqual(["tiny cloudbecomesTinyCloud"]);
    expect(await stored()).toEqual([{ find: "tiny cloud", replace: "TinyCloud" }]);
  });

  test("Escape cancels, and an empty find is not saved", async () => {
    await act(async () => { buttonText("Add a word fix").click(); });
    await type("With this", "x");
    await key("With this", "Enter");
    await settle();
    expect(byLabel("Replace this")).not.toBeNull();
    await type("Replace this", "abc");
    await key("Replace this", "Escape");
    expect(byLabel("Replace this")).toBeNull();
    expect(await stored()).toEqual([]);
  });

  test("a duplicate find (ignoring case) replaces that entry; edit and delete write through", async () => {
    await add("eliza", "Eliza");
    await add("ELIZA", "ELIZA!");
    expect(await stored()).toEqual([{ find: "ELIZA", replace: "ELIZA!" }]);
    await act(async () => { byLabel("Edit word fix for ELIZA")!.click(); });
    await type("With this", "Eliza AI");
    await act(async () => { buttonText("Save").click(); });
    await settle();
    expect(await stored()).toEqual([{ find: "ELIZA", replace: "Eliza AI" }]);
    await act(async () => { byLabel("Delete word fix for ELIZA")!.click(); });
    await settle();
    expect(await stored()).toEqual([]);
    expect(shown()).toEqual([]);
  });
});
