import { expect, test } from "bun:test";
import { askDeclined, stepUpFailedLine } from "../apps/strings";
import { openKeyFailureOf } from "./authErrors";
import { FEATURE_ACCESS_FAILED, FEATURE_ACCESS_WRONG_ACCOUNT } from "./homeStrings";

test("a refusal reads the same from SDK 0.12 (UNKNOWN + message) and 0.13 (its own code)", () => {
  expect(openKeyFailureOf({ code: "UNKNOWN", message: "KEY_DELETE_NOT_GRANTABLE" })).toEqual({ kind: "refused", code: "KEY_DELETE_NOT_GRANTABLE" });
  expect(openKeyFailureOf({ code: "APP_KEY_GRANT_REFUSED", message: "anything" })).toEqual({ kind: "refused", code: "APP_KEY_GRANT_REFUSED" });
  // An UNKNOWN whose message is free text is a plain failure, and the text never becomes the code.
  expect(openKeyFailureOf({ code: "UNKNOWN", message: "Something <b>broke</b>" })).toEqual({ kind: "failed", code: "UNKNOWN" });
});

test("a cancel anywhere in the cause chain wins over an outer code", () => {
  const wrapped = Object.assign(new Error("signing failed", { cause: { code: "USER_CANCELLED", message: "User cancelled the request" } }), { code: "TIMEOUT" });
  expect(openKeyFailureOf(wrapped)).toEqual({ kind: "cancelled" });
});

test("popup blocked keeps the embedded-WebView reason; UNAUTHORIZED is an ended session", () => {
  expect(openKeyFailureOf({ code: "POPUP_BLOCKED", message: "x", reason: "embedded-webview" })).toEqual({ kind: "popup-blocked", embeddedWebview: true });
  expect(openKeyFailureOf({ code: "POPUP_BLOCKED", message: "x" })).toEqual({ kind: "popup-blocked", embeddedWebview: false });
  expect(openKeyFailureOf({ code: "UNAUTHORIZED", message: "x" })).toEqual({ kind: "session-ended" });
});

test("errors that are not OpenKey's carry no code", () => {
  expect(openKeyFailureOf(new Error("network down"))).toEqual({ kind: "failed", code: null });
  expect(openKeyFailureOf({ code: "not an sdk code", message: "x" })).toEqual({ kind: "failed", code: null });
  expect(openKeyFailureOf(undefined)).toEqual({ kind: "failed", code: null });
});

test("a step-up that fails says whether trying again can help", () => {
  expect(stepUpFailedLine("Secrets", { kind: "failed", code: "TIMEOUT" })).toBe(FEATURE_ACCESS_FAILED);
  expect(stepUpFailedLine("Secrets", { kind: "popup-blocked", embeddedWebview: false })).toBe(FEATURE_ACCESS_FAILED);
  expect(stepUpFailedLine("Secrets", { kind: "wrong-account" })).toBe(FEATURE_ACCESS_WRONG_ACCOUNT);
  for (const kind of ["declined", "cancelled", "session-ended"] as const) expect(stepUpFailedLine("Secrets", { kind })).toBe(askDeclined("Secrets"));
  expect(stepUpFailedLine("Secrets", { kind: "refused", code: "KEY_DELETE_NOT_GRANTABLE" })).toBe(askDeclined("Secrets"));
});
