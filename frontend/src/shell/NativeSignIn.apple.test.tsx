import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

import type { NativeSignInHints } from "@/lib/openkeyNative";
import { installDom } from "@/test/dom";
import { NativeSignIn } from "./NativeSignIn";

const app = readFileSync(join(import.meta.dir, "../App.tsx"), "utf8");

let cleanupDom: (() => void) | undefined;
afterEach(() => { cleanupDom?.(); cleanupDom = undefined; });

type Props = Partial<Parameters<typeof NativeSignIn>[0]>;

function markup(props: Props = {}) {
  return renderToStaticMarkup(<NativeSignIn state="unauthenticated" error={null} onSignIn={() => {}} {...props} />);
}

async function mount(props: Props) {
  cleanupDom = installDom();
  const host = document.createElement("div");
  document.body.append(host);
  const calls: NativeSignInHints[] = [];
  const root: Root = createRoot(host);
  await act(async () => root.render(createElement(NativeSignIn, {
    state: "unauthenticated", error: null, onSignIn: (hints: NativeSignInHints) => calls.push(hints), ...props,
  })));
  const buttons = () => [...host.querySelectorAll("button")];
  return { host, calls, buttons, unmount: () => act(async () => root.unmount()) };
}

describe("Continue with Apple (TC-1233)", () => {
  test("is not offered until OpenKey lists apple, so the app never shows a dead button", () => {
    expect(markup()).not.toContain("Continue with Apple");
    expect(markup({ socialProviders: [] })).not.toContain("Continue with Apple");
    expect(markup({ socialProviders: ["google"] })).not.toContain("Continue with Apple");
    expect(markup({ socialProviders: ["google", "apple"] })).toContain("Continue with Apple");
  });

  test("sends only the apple method, even with an email typed, and sits below Google (no shift under a tap) with the same button style", async () => {
    const view = await mount({ socialProviders: ["google", "apple"] });
    const input = view.host.querySelector("input")!;
    await act(async () => {
      input.value = "sam@mailinator.com";
      input.dispatchEvent(new InputEvent("input", { bubbles: true, data: input.value, inputType: "insertText" }));
    });
    const labels = view.buttons().map((button) => button.textContent);
    expect(labels.indexOf("Continue with Apple")).toBe(labels.indexOf("Continue with Google") + 1);
    const apple = view.buttons().find((button) => button.textContent === "Continue with Apple")!;
    const google = view.buttons().find((button) => button.textContent === "Continue with Google")!;
    expect(apple.className).toBe(google.className);
    expect(apple.querySelector("svg")?.getAttribute("fill")).toBe("currentColor");
    await act(async () => { apple.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true })); });
    expect(view.calls).toEqual([{ loginMethod: "apple" }]);
    await view.unmount();
  });

  test("is disabled while signing in", () => {
    expect(markup({ state: "connecting", socialProviders: ["apple"] })).toMatch(/<button[^>]*disabled[^>]*>(?:(?!<\/button>).)*Continue with Apple/);
  });

  test("App reads the provider list for the native screen and passes it through", () => {
    expect(app).toContain("loadOpenKeySocialProviders(OPENKEY_HOST)");
    expect(app).toContain("socialProviders={socialProviders}");
  });
});
