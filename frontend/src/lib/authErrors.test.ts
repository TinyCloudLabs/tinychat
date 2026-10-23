import { expect, test } from "bun:test";
import {
  authErrorMessage, BROWSER_UPDATE_MESSAGE, errorLinkFor, isSignInCancelled, SIGN_IN_FAILED_MESSAGE,
  UserFacingError, WEBVIEW_UPDATE_LINK, WEBVIEW_UPDATE_MESSAGE,
} from "./authErrors";

test("the raw Node-crypto error from an old Android WebView becomes an update message and a link", () => {
  const raw = new TypeError("n.createPrivateKey is not a function");
  const message = authErrorMessage(raw, "android");
  expect(message).toBe(WEBVIEW_UPDATE_MESSAGE);
  expect(message).not.toContain("createPrivateKey");
  expect(errorLinkFor(message)).toEqual(WEBVIEW_UPDATE_LINK);
  expect(WEBVIEW_UPDATE_LINK.href).toStartWith("https://play.google.com/store/apps/details?id=com.google.android.webview");
});

test("a WebCrypto Ed25519 failure is recognised through its cause chain", () => {
  const wrapped = new Error("sign-in failed", { cause: new DOMException("Unrecognized name.", "NotSupportedError") });
  expect(authErrorMessage(wrapped, "android")).toBe(WEBVIEW_UPDATE_MESSAGE);
  const ed = new Error("sign-in failed", { cause: new Error("Algorithm: Ed25519 unsupported") });
  expect(authErrorMessage(ed, "android")).toBe(WEBVIEW_UPDATE_MESSAGE);
});

test("off Android the same failure never mentions the Android WebView", () => {
  const raw = new TypeError("n.createPrivateKey is not a function");
  expect(authErrorMessage(raw, "ios")).toBe(BROWSER_UPDATE_MESSAGE);
  expect(authErrorMessage(raw, "web")).toBe(BROWSER_UPDATE_MESSAGE);
  expect(errorLinkFor(BROWSER_UPDATE_MESSAGE)).toBeNull();
});

test("an unknown error is never shown raw", () => {
  expect(authErrorMessage(new Error("HTTP 500 at https://internal/x"), "android")).toBe(SIGN_IN_FAILED_MESSAGE);
  expect(authErrorMessage({ code: "TIMEOUT", message: "timeout" }, "web")).toBe(SIGN_IN_FAILED_MESSAGE);
  expect(authErrorMessage("boom", "web")).toBe(SIGN_IN_FAILED_MESSAGE);
});

test("a message written for the user passes through", () => {
  expect(authErrorMessage(new UserFacingError("Sign-in took too long. Please try again."), "web"))
    .toBe("Sign-in took too long. Please try again.");
});

test("OpenKey's closed sheet is a cancel, not an error", () => {
  expect(isSignInCancelled({ code: "USER_CANCELLED", message: "Request closed" })).toBe(true);
  expect(isSignInCancelled(new UserFacingError("Sign-in was cancelled.", { cause: { code: "USER_CANCELLED" } }))).toBe(true);
  expect(isSignInCancelled({ code: "TIMEOUT", message: "x" })).toBe(false);
  expect(isSignInCancelled(new Error("USER_CANCELLED"))).toBe(false);
  expect(isSignInCancelled(null)).toBe(false);
});

