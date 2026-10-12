import { afterEach, describe, expect, test } from "bun:test";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";

import type { AppState } from "@/lib/appState";
import type { NativeSignInHints } from "@/lib/openkeyNative";
import { installDom } from "@/test/dom";
import { NativeSignIn } from "./NativeSignIn";
import { useNativeSignIn } from "./useNativeSignIn";

let cleanupDom: (() => void) | undefined;
afterEach(() => { cleanupDom?.(); cleanupDom = undefined; });

const NETWORK = "Can't reach OpenKey. Check your connection and try again.";

// App's own wiring in miniature: its state machine and sign-in, the hook, the real screen,
// and a stand-in for the local home with its "Sign in to sync".
async function mount(options: { native?: boolean; bypassed?: boolean; sdk: (hints?: NativeSignInHints) => Promise<void> }) {
  cleanupDom = installDom();
  const host = document.createElement("div");
  document.body.append(host);
  const calls: (NativeSignInHints | undefined)[] = [];
  let setStateOutside: (state: AppState) => void = () => {};

  function Harness() {
    const [state, setState] = useState<AppState>("unauthenticated");
    const [error, setError] = useState<string | null>(null);
    setStateOutside = setState;
    const localHome = (options.bypassed ?? true) && state === "unauthenticated" && error === null;
    const signIn = async (hints?: NativeSignInHints) => {
      calls.push(hints);
      setError(null);
      setState("connecting");
      try {
        await options.sdk(hints);
        setState("ready");
      } catch (caught) {
        if (caught instanceof Error && caught.message === "cancelled") {
          setState("unauthenticated");
        } else {
          setError(NETWORK);
          setState("recoverableError");
        }
      }
    };
    const flow = useNativeSignIn({
      native: options.native ?? true, state, localHome, signIn, restoreSession: async () => {},
      settleSignedOut: () => { setError(null); setState("unauthenticated"); },
    });
    return (
      <div>
        <button type="button" onClick={() => void flow.micRecoveryContinue()}>Mic continue</button>
        {state === "ready" ? <p>signed in</p>
          : flow.screenShown ? <NativeSignIn state={state} error={error} onSignIn={(hints) => void signIn(hints)} onClose={flow.onClose} />
          : localHome ? <button type="button" onClick={() => void flow.authAction()}>Sign in to sync</button>
            : <p>boot surface</p>}
      </div>
    );
  }

  const root = createRoot(host);
  await act(async () => root.render(<Harness />));
  const button = (label: string) => [...host.querySelectorAll("button")].find((b) => b.textContent === label) as HTMLButtonElement | undefined;
  const click = (label: string) => act(async () => { button(label)!.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true })); });
  const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  return { host, calls, button, click, settle, setState: (state: AppState) => act(async () => setStateOutside(state)) };
}

describe("useNativeSignIn", () => {
  test("Sign in to sync opens the screen without starting the sign-in; Google then starts it once", async () => {
    const app = await mount({ sdk: async () => {} });
    await app.click("Sign in to sync");
    expect(app.host.querySelector('[data-testid="native-sign-in"]')).not.toBeNull();
    expect(app.calls).toEqual([]);
    await app.click("Continue with Google");
    expect(app.calls).toEqual([{ loginMethod: "google" }]);
    expect(app.host.textContent).toContain("signed in");
  });

  test("a failed sign-in keeps Not now, and it returns to the local home with the error cleared", async () => {
    const app = await mount({ sdk: async () => { throw new Error("network"); } });
    await app.click("Sign in to sync");
    await app.click("Continue with Google");
    expect(app.calls).toEqual([{ loginMethod: "google" }]);
    expect(app.host.querySelector('[role="alert"]')?.textContent).toContain(NETWORK);
    expect(app.button("Not now")).toBeDefined();
    expect(app.button("Not now")!.disabled).toBe(false);
    await app.click("Not now");
    expect(app.host.querySelector('[data-testid="native-sign-in"]')).toBeNull();
    expect(app.host.querySelector('[role="alert"]')).toBeNull();
    expect(app.button("Sign in to sync")).toBeDefined();
  });

  test("a cancelled sign-in keeps Not now too", async () => {
    const app = await mount({ sdk: async () => { throw new Error("cancelled"); } });
    await app.click("Sign in to sync");
    await app.click("Use a passkey");
    expect(app.button("Not now")).toBeDefined();
    await app.click("Not now");
    expect(app.button("Sign in to sync")).toBeDefined();
  });

  test("Not now is disabled while the sign-in is in flight", async () => {
    let release: () => void = () => {};
    const app = await mount({ sdk: () => new Promise<void>((resolve) => { release = resolve; }) });
    await app.click("Sign in to sync");
    await app.click("Continue with Google");
    expect(app.button("Not now")!.disabled).toBe(true);
    await act(async () => release());
    await app.settle();
    expect(app.host.textContent).toContain("signed in");
  });

  test("a screen that did not come from the local home has no Not now, before or after a failure", async () => {
    const app = await mount({ bypassed: false, sdk: async () => { throw new Error("network"); } });
    expect(app.host.querySelector('[data-testid="native-sign-in"]')).not.toBeNull();
    expect(app.button("Not now")).toBeUndefined();
    await app.click("Continue with Google");
    expect(app.host.querySelector('[role="alert"]')).not.toBeNull();
    expect(app.button("Not now")).toBeUndefined();
  });

  test("the microphone recovery starts the sign-in at once, with no hints, and the app moves on to connecting", async () => {
    const app = await mount({ sdk: () => new Promise<void>(() => {}) });
    await app.click("Mic continue");
    expect(app.calls).toEqual([undefined]);
    expect(app.host.querySelector('[role="status"]')?.textContent).toContain("Finish the OpenKey prompt");
  });

  test("web and Tauri start the sign-in directly and never show the screen", async () => {
    const app = await mount({ native: false, sdk: async () => {} });
    await app.click("Sign in to sync");
    expect(app.calls).toEqual([undefined]);
    expect(app.host.querySelector('[data-testid="native-sign-in"]')).toBeNull();
  });

  test("a signed-in app forgets the request, so a later sign-out lands back on the local home", async () => {
    const app = await mount({ sdk: async () => {} });
    await app.click("Sign in to sync");
    await app.click("Continue with Google");
    expect(app.host.textContent).toContain("signed in");
    await app.setState("unauthenticated");
    expect(app.button("Sign in to sync")).toBeDefined();
    expect(app.host.querySelector('[data-testid="native-sign-in"]')).toBeNull();
  });
});
