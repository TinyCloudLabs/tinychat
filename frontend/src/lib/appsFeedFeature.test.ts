import { expect, test } from "bun:test";
import { appsFeedStoredFlag } from "./appsFeedFeature";

test("an unset choice follows the build: on for the Home site, off elsewhere", () => {
  expect(appsFeedStoredFlag(null, true)).toBe(true);
  expect(appsFeedStoredFlag(null, false)).toBe(false);
});

test("an explicit choice wins on the Home site too", () => {
  expect(appsFeedStoredFlag("false", true)).toBe(false);
  expect(appsFeedStoredFlag("true", true)).toBe(true);
  expect(appsFeedStoredFlag("true", false)).toBe(true);
  expect(appsFeedStoredFlag("false", false)).toBe(false);
});

test("a stored value that is not \"true\" counts as off", () => {
  expect(appsFeedStoredFlag("", true)).toBe(false);
  expect(appsFeedStoredFlag("yes", true)).toBe(false);
});
