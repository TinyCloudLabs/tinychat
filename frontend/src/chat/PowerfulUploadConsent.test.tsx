// The upload sheet asks before sending a file to Powerful (hosted AssemblyAI), once per account, using the
// recorder's consent. Declining uploads nothing. Asserts the gate, not the wording.
import { afterEach, describe, expect, test } from "bun:test";
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";

import { POWERFUL_CONSENT_ACTION, POWERFUL_CONSENT_TITLE } from "@/capture/recorder/final/finalCopy";
import type { UploadEngine } from "@/lib/audioUpload";
import { installDom } from "@/test/dom";
import { usePowerfulUploadConsent } from "./PowerfulUploadConsent";

let root: Root | null = null;
let cleanupDom: (() => void) | undefined;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  cleanupDom?.();
  cleanupDom = undefined;
});

/** Stands in for the panel: the consent lives in a store the way the recorder's `powerfulConsented` does. */
async function mount(engine: UploadEngine, initiallyConsented: boolean, calls: string[]): Promise<HTMLElement> {
  cleanupDom = installDom();
  const host = document.createElement("div");
  document.body.appendChild(host);
  function Harness() {
    const [consented, setConsented] = useState(initiallyConsented);
    const gate = usePowerfulUploadConsent({
      consented,
      onConsent: () => { calls.push("consent"); setConsented(true); },
    });
    return createElement("div", null,
      createElement("button", { "data-testid": "go", onClick: () => gate.request(engine, () => calls.push("upload")) }, "Transcribe"),
      gate.dialog);
  }
  root = createRoot(host);
  await act(async () => root!.render(createElement(Harness)));
  return host;
}

const click = (element: Element) => act(async () => { element.dispatchEvent(new window.MouseEvent("click", { bubbles: true })); });
const go = (host: HTMLElement) => host.querySelector('[data-testid="go"]')!;
const dialog = (host: HTMLElement) => host.querySelector('[data-testid="upload-powerful-consent"]');
const buttonLabelled = (host: HTMLElement, label: string) =>
  [...host.querySelectorAll("button")].find((b) => b.textContent === label)!;

describe("Powerful upload consent", () => {
  test("Powerful without consent asks first and uploads nothing yet", async () => {
    const calls: string[] = [];
    const host = await mount("assemblyai", false, calls);
    await click(go(host));
    expect(dialog(host)).not.toBeNull();
    expect(dialog(host)!.textContent).toContain(POWERFUL_CONSENT_TITLE);
    expect(calls).toEqual([]);
  });

  test("confirming records the consent, then uploads", async () => {
    const calls: string[] = [];
    const host = await mount("assemblyai", false, calls);
    await click(go(host));
    await click(buttonLabelled(host, POWERFUL_CONSENT_ACTION));
    expect(calls).toEqual(["consent", "upload"]);
    expect(dialog(host)).toBeNull();
  });

  test("declining uploads nothing and records nothing; asking again still asks", async () => {
    const calls: string[] = [];
    const host = await mount("assemblyai", false, calls);
    await click(go(host));
    await click(buttonLabelled(host, "Not now"));
    expect(calls).toEqual([]);
    expect(dialog(host)).toBeNull();
    await click(go(host));
    expect(dialog(host)).not.toBeNull();
    expect(calls).toEqual([]);
  });

  test("Escape declines the same way", async () => {
    const calls: string[] = [];
    const host = await mount("assemblyai", false, calls);
    await click(go(host));
    await act(async () => {
      dialog(host)!.querySelector("[role=dialog]")!.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(calls).toEqual([]);
    expect(dialog(host)).toBeNull();
  });

  test("already consented uploads at once, with no dialog", async () => {
    const calls: string[] = [];
    const host = await mount("assemblyai", true, calls);
    await click(go(host));
    expect(dialog(host)).toBeNull();
    expect(calls).toEqual(["upload"]);
  });

  test("one confirmation covers every later Powerful upload", async () => {
    const calls: string[] = [];
    const host = await mount("assemblyai", false, calls);
    await click(go(host));
    await click(buttonLabelled(host, POWERFUL_CONSENT_ACTION));
    await click(go(host));
    expect(calls).toEqual(["consent", "upload", "upload"]);
    expect(dialog(host)).toBeNull();
  });

  test("Private is not gated by the Powerful consent", async () => {
    const calls: string[] = [];
    const host = await mount("private-cloud", false, calls);
    await click(go(host));
    expect(dialog(host)).toBeNull();
    expect(calls).toEqual(["upload"]);
  });
});
