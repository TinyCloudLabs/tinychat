import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { clearSameTabReturn, pendingSameTabReturn, sameTabState, saveSameTabVerifier } from "./googleOAuthSameTab";
import { oauthReturnTag, popupOAuthState } from "./googleOAuthState";

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

const NONCE = "abcdefghijklmnopqrstuvwx";
const b64url = (text: string) => btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");

test("return tags by origin: home on home.tinycloud.xyz, one on tinycloud.one, none elsewhere", () => {
  expect(oauthReturnTag("https://home.tinycloud.xyz")).toBe("home");
  expect(oauthReturnTag("https://tinycloud.one")).toBe("one");
  for (const origin of ["https://tinycloud.chat", "https://www.tinycloud.one", "http://tinycloud.one", "https://tinycloud.one:8443", "https://evil-tinycloud.one", undefined]) {
    expect(oauthReturnTag(origin)).toBeNull();
  }
});

test("popup states: <tag>.<nonce> on a tagged origin, untagged elsewhere", () => {
  expect(popupOAuthState(NONCE, null)).toBe(NONCE);
  expect(popupOAuthState(NONCE, "home")).toBe(`home.${NONCE}`);
  expect(popupOAuthState(NONCE, "one")).toBe(`one.${NONCE}`);
});

test("same-tab states: <tag>tab.<path>.<nonce> on a tagged origin, tab.<path>.<nonce> elsewhere", () => {
  expect(sameTabState("/chat/connectors", NONCE, null)).toBe(`tab.${b64url("/chat/connectors")}.${NONCE}`);
  expect(sameTabState("/chat/connectors", NONCE, "home")).toBe(`hometab.${b64url("/chat/connectors")}.${NONCE}`);
  expect(sameTabState("/chat/connectors", NONCE, "one")).toBe(`onetab.${b64url("/chat/connectors")}.${NONCE}`);
});

test.each(["home", "one"] as const)("a same-tab return restores the verifier saved under a %stab state", (tag) => {
  const dom = new Window({ url: "https://home.example.test/chat/connectors" });
  const globals = globalThis as typeof globalThis & { window?: Window; sessionStorage?: Storage };
  const oldWindow = globals.window;
  const oldStorage = globals.sessionStorage;
  globals.window = dom;
  globals.sessionStorage = dom.sessionStorage;
  try {
    const state = sameTabState("/chat/connectors", NONCE, tag);
    saveSameTabVerifier(state, "verifier", "autojoin");
    dom.history.replaceState(null, "", `/chat/connectors?state=${state}&google_oauth_code=code`);
    expect(pendingSameTabReturn()).toEqual({ state, code: "code", error: false, verifier: "verifier", purpose: "autojoin" });
    clearSameTabReturn(state);
    dom.history.replaceState(null, "", `/chat/connectors?state=${state}&google_oauth_error=not_completed`);
    expect(pendingSameTabReturn()).toBeNull();
  } finally {
    globals.window = oldWindow;
    globals.sessionStorage = oldStorage;
    void dom.happyDOM.abort();
  }
});

test("a return whose state has no stored verifier, or an unrelated tag, is ignored", () => {
  const dom = new Window({ url: "https://home.example.test/chat/connectors" });
  const globals = globalThis as typeof globalThis & { window?: Window; sessionStorage?: Storage };
  const oldWindow = globals.window;
  const oldStorage = globals.sessionStorage;
  globals.window = dom;
  globals.sessionStorage = dom.sessionStorage;
  try {
    for (const state of [sameTabState("/chat/connectors", NONCE, "home"), sameTabState("/chat/connectors", NONCE, "one"), `home.${NONCE}`, `one.${NONCE}`, `native.${NONCE}`]) {
      dom.history.replaceState(null, "", `/chat/connectors?state=${state}&google_oauth_code=code`);
      expect(pendingSameTabReturn()).toBeNull();
    }
    saveSameTabVerifier(`home.${NONCE}`, "verifier", "connect");
    dom.history.replaceState(null, "", `/chat/connectors?state=home.${NONCE}&google_oauth_code=code`);
    expect(pendingSameTabReturn()).toBeNull();
  } finally {
    globals.window = oldWindow;
    globals.sessionStorage = oldStorage;
    void dom.happyDOM.abort();
  }
});
