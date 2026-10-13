import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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

const app = readFileSync(join(import.meta.dir, "..", "App.tsx"), "utf8");

test("sign-in returns quietly to signed-out on cancel and shows no raw message otherwise", () => {
  const signIn = app.slice(app.indexOf("const signIn = useCallback"), app.indexOf("const signOut = useCallback"));
  expect(signIn).toMatch(/if \(isSignInCancelled\(caught\)\) \{\s+setError\(null\);\s+setState\("unauthenticated"\);\s+return;\s+\}/);
  expect(signIn).toContain("setError(describeAuthFailure(caught))");
  expect(app).not.toMatch(/setError\(errorMessage\(caught\)\)/);
});

test("OpenKey sign-out waits for the user: no capture deadline around it", () => {
  const signOut = app.slice(app.indexOf("const signOut = useCallback"), app.indexOf("const isReady"));
  const openKey = signOut.slice(signOut.indexOf("const openKeyClient"), signOut.indexOf("openkeyRef.current = null"));
  expect(openKey).toContain("await signOutOpenKeySession(");
  expect(openKey).not.toContain("withCaptureDeadline");
  expect(openKey).not.toContain("timed out");
});

test("the app is called Exo everywhere sign-in and sign-out show a name", () => {
  expect(app).toContain('const APP_NAME = "Exo";');
  expect(app).not.toContain("TinyChat is signed out");
  expect(app.match(/Exo is signed out locally/g)?.length).toBe(1);
  expect(app).toContain("Signed out of Exo. To use a different account");
  expect(readFileSync(join(import.meta.dir, "..", "..", "index.html"), "utf8")).toContain("<title>Exo</title>");
});
