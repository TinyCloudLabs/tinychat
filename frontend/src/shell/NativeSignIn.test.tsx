import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

import { WEBVIEW_UPDATE_LINK, WEBVIEW_UPDATE_MESSAGE } from "@/lib/authErrors";
import type { AppState } from "@/lib/appState";
import { showsNativeSignIn } from "@/lib/authRouting";
import { isNativeOpenKeySignIn, type NativeSignInHints } from "@/lib/openkeyNative";
import { installDom } from "@/test/dom";
import { NATIVE_SIGN_IN_FINE_PRINT, NATIVE_SIGN_IN_SUBCOPY, NativeSignIn } from "./NativeSignIn";

const app = readFileSync(join(import.meta.dir, "../App.tsx"), "utf8");

let cleanupDom: (() => void) | undefined;
afterEach(() => { cleanupDom?.(); cleanupDom = undefined; });

function markup(props: Partial<Parameters<typeof NativeSignIn>[0]> = {}) {
  return renderToStaticMarkup(<NativeSignIn state="unauthenticated" error={null} onSignIn={() => {}} {...props} />);
}

async function mount(props: Partial<Parameters<typeof NativeSignIn>[0]> = {}) {
  cleanupDom = installDom();
  const host = document.createElement("div");
  document.body.append(host);
  const calls: NativeSignInHints[] = [];
  const root: Root = createRoot(host);
  const element = (next: Partial<Parameters<typeof NativeSignIn>[0]>) =>
    createElement(NativeSignIn, { state: "unauthenticated", error: null, onSignIn: (hints: NativeSignInHints) => calls.push(hints), ...next });
  await act(async () => root.render(element(props)));
  const button = (label: string) => [...host.querySelectorAll("button")].find((b) => b.textContent === label) as HTMLButtonElement;
  const input = () => host.querySelector("input")!;
  const type = async (value: string) => {
    await act(async () => {
      input().value = value;
      input().dispatchEvent(new InputEvent("input", { bubbles: true, data: value, inputType: "insertText" }));
    });
  };
  const click = (target: HTMLButtonElement) => act(async () => { target.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true })); });
  const submit = () => act(async () => { host.querySelector("form")!.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })); });
  return { host, calls, button, input, type, click, submit, rerender: (next: Partial<Parameters<typeof NativeSignIn>[0]>) => act(async () => root.render(element(next))), unmount: () => act(async () => root.unmount()) };
}

describe("NativeSignIn content", () => {
  test("Exo's icon, the heading, the subcopy, an email field, Continue, Google, a passkey and the fine print", () => {
    const html = markup();
    expect(html).toContain('src="/icons/pwa-192.png"');
    expect(html).toMatch(/<h1[^>]*>Sign in to Exo<\/h1>/);
    expect(html).toContain(NATIVE_SIGN_IN_SUBCOPY);
    expect(html).toContain("Continue</button>");
    expect(html).toContain("Continue with Google");
    expect(html).toContain("Use a passkey");
    expect(NATIVE_SIGN_IN_FINE_PRINT).toBe("You'll finish on openkey.so. Exo never sees your code or passkey.");
    expect(html).toContain("You&#x27;ll finish on openkey.so. Exo never sees your code or passkey.");
  });

  test("the field is an email field for a phone keyboard", () => {
    const input = markup().match(/<input[^>]*>/)![0];
    expect(input).toContain('type="email"');
    expect(input).toContain('autoComplete="email"');
    expect(input).toContain('inputMode="email"');
    expect(input).toContain('autoCapitalize="off"');
    expect(input).not.toContain("autoFocus");
  });

  test("Continue starts disabled, with nothing typed", () => {
    expect(markup()).toMatch(/<button[^>]*disabled=""[^>]*>Continue<\/button>/);
  });

  test("no Not now unless there is a local home to go back to", () => {
    expect(markup()).not.toContain("Not now");
    expect(markup({ onClose: () => {} })).toContain("Not now");
  });
});

describe("NativeSignIn hints", () => {
  test("Continue is enabled only for a plausible email", async () => {
    const view = await mount();
    for (const bad of ["", "sam", "sam@", "@mailinator.com", "a@b@c", "sam smith@mailinator.com"]) {
      await view.type(bad);
      expect(view.button("Continue").disabled).toBe(true);
    }
    await view.type("sam@mailinator.com");
    expect(view.button("Continue").disabled).toBe(false);
    await view.unmount();
  });

  test("submitting a plausible email sends it, normalised, with the email method", async () => {
    const view = await mount();
    await view.type("  Sam@Mailinator.com ");
    await view.submit();
    expect(view.calls).toEqual([{ loginHint: "sam@mailinator.com", loginMethod: "email" }]);
    await view.unmount();
  });

  test("Enter on an implausible email sends nothing", async () => {
    const view = await mount();
    await view.type("sam");
    await view.submit();
    expect(view.calls).toEqual([]);
    await view.unmount();
  });

  test("Continue with Google sends only the method, even with an email typed", async () => {
    const view = await mount();
    await view.type("sam@mailinator.com");
    await view.click(view.button("Continue with Google"));
    expect(view.calls).toEqual([{ loginMethod: "google" }]);
    await view.unmount();
  });

  test("Use a passkey sends only the method", async () => {
    const view = await mount();
    await view.click(view.button("Use a passkey"));
    expect(view.calls).toEqual([{ loginMethod: "passkey" }]);
    await view.unmount();
  });

  test("Not now goes back", async () => {
    let closed = 0;
    const view = await mount({ onClose: () => { closed++; } });
    await view.click(view.button("Not now"));
    expect(closed).toBe(1);
    await view.unmount();
  });
});

describe("NativeSignIn busy and error states", () => {
  test("while the sheet is open, everything is disabled and the existing copy shows", async () => {
    const view = await mount({ state: "connecting" });
    expect(view.host.textContent).toContain("Finish the OpenKey prompt to continue.");
    expect(view.input().disabled).toBe(true);
    for (const label of ["Continue", "Continue with Google", "Use a passkey"]) expect(view.button(label).disabled).toBe(true);
    await view.type("sam@mailinator.com");
    await view.submit();
    expect(view.calls).toEqual([]);
    await view.unmount();
  });

  test("while the session is created it says so", () => {
    const html = markup({ state: "signing" });
    expect(html).toContain("Creating your TinyCloud session…");
    expect(html).toContain('role="status"');
  });

  test("a failed sign-in shows its message as an alert and offers the buttons again", async () => {
    const view = await mount({ state: "recoverableError", error: "Couldn't sign in. Please try again." });
    expect(view.host.querySelector('[role="alert"]')?.textContent).toBe("Couldn't sign in. Please try again.");
    expect(view.button("Continue with Google").disabled).toBe(false);
    await view.click(view.button("Use a passkey"));
    expect(view.calls).toEqual([{ loginMethod: "passkey" }]);
    await view.unmount();
  });

  test("the typed email survives a cancelled sheet", async () => {
    const view = await mount();
    await view.type("sam@mailinator.com");
    await view.rerender({ state: "connecting" });
    await view.rerender({ state: "unauthenticated" });
    expect(view.input().value).toBe("sam@mailinator.com");
    await view.unmount();
  });

  test("the old WebView message carries its update link", () => {
    const html = markup({ state: "recoverableError", error: WEBVIEW_UPDATE_MESSAGE });
    expect(html).toContain(WEBVIEW_UPDATE_MESSAGE);
    expect(html).toContain(`href="${WEBVIEW_UPDATE_LINK.href}"`);
  });

  test("an ordinary error shows no link", () => {
    expect(markup({ state: "recoverableError", error: "Couldn't sign in. Please try again." })).not.toContain("<a ");
  });
});

describe("the native gate", () => {
  test("only iOS and Android sign in through the native flow", () => {
    expect(isNativeOpenKeySignIn("ios")).toBe(true);
    expect(isNativeOpenKeySignIn("android")).toBe(true);
    expect(isNativeOpenKeySignIn("web")).toBe(false);
    expect(isNativeOpenKeySignIn("tauri")).toBe(false);
  });

  test("web and Tauri never show it, in any state", () => {
    const states: AppState[] = ["booting", "unauthenticated", "connecting", "signing", "ready", "recoverableError", "offline"];
    for (const state of states) {
      for (const localHome of [false, true]) for (const requested of [false, true]) {
        expect(showsNativeSignIn({ native: false, state, localHome, requested })).toBe(false);
      }
    }
  });

  test("native shows it for every state that offers or runs a sign-in, and keeps the boot surface for the rest", () => {
    const shown: AppState[] = ["unauthenticated", "recoverableError", "connecting", "signing"];
    const kept: AppState[] = ["booting", "ready", "offline"];
    for (const state of shown) expect(showsNativeSignIn({ native: true, state, localHome: false, requested: false })).toBe(true);
    for (const state of kept) expect(showsNativeSignIn({ native: true, state, localHome: false, requested: true })).toBe(false);
  });

  test("the signed-out local home stays in front until it asks to sign in", () => {
    expect(showsNativeSignIn({ native: true, state: "unauthenticated", localHome: true, requested: false })).toBe(false);
    expect(showsNativeSignIn({ native: true, state: "unauthenticated", localHome: true, requested: true })).toBe(true);
  });

  test("App shows it on native, for the local home's Sign in to sync and the recorder's sign-in", () => {
    expect(app).toContain("const nativeSignIn = isNativeOpenKeySignIn();");
    expect(app).toContain("showsNativeSignIn({ native: nativeSignIn, state, localHome: signedOutLocalHome, requested: nativeSignInRequested })");
    // "Sign in to sync" and the recorder's onSignIn both run authAction, which on native opens the screen.
    expect(app).toContain("signedOutLocalHome ? <LocalCaptureHome onSignIn={authAction}");
    expect(app).toContain("onSignIn={authAction}");
    expect(app).toContain('const authAction = state === "offline" ? restoreSession : nativeSignIn ? openNativeSignIn : signIn;');
    // The screen's own buttons are the only thing that runs the sign-in with hints.
    expect(app).toContain("onSignIn={(hints) => void signIn(hints)}");
    expect(app).toContain("await signInNative(nativeConfig, hints);");
  });
});
