import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { clearSameTabReturn, pendingSameTabReturn, sameTabState, saveSameTabVerifier } from "./googleOAuthSameTab";

test("same-tab return restores only its stored PKCE verifier and consumes the code", () => {
  const dom = new Window({ url: "https://app.example.test/connectors" });
  const globals = globalThis as typeof globalThis & { window?: Window; sessionStorage?: Storage };
  const oldWindow = globals.window;
  const oldStorage = globals.sessionStorage;
  globals.window = dom;
  globals.sessionStorage = dom.sessionStorage;
  try {
    const state = sameTabState("/connectors", "abcdefghijklmnopqrstuvwx");
    saveSameTabVerifier(state, "verifier", "connect");
    dom.history.replaceState(null, "", `/connectors?state=${state}&google_oauth_code=code`);
    expect(pendingSameTabReturn()).toEqual({ state, code: "code", error: false, verifier: "verifier", purpose: "connect" });
    clearSameTabReturn(state);
    expect(pendingSameTabReturn()).toBeNull();
    expect(dom.location.search).toBe("");
  } finally {
    globals.window = oldWindow;
    globals.sessionStorage = oldStorage;
    void dom.happyDOM.abort();
  }
});
