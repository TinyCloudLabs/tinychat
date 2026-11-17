import { afterEach, expect, test } from "bun:test";
import { installDom } from "@/test/dom";
import { HIDDEN_FEATURES_KEY, readShowHiddenFeatures, resetHiddenFeaturesForTest, setShowHiddenFeatures } from "./hiddenFeatures";

let restore: (() => void) | undefined;
afterEach(() => { resetHiddenFeaturesForTest(); restore?.(); restore = undefined; });

test("hidden features are off unless the stored value is exactly 1", () => {
  expect(readShowHiddenFeatures(null)).toBe(false);
  expect(readShowHiddenFeatures({ getItem: () => null })).toBe(false);
  for (const value of ["", "0", "true", "11", "on"]) expect(readShowHiddenFeatures({ getItem: () => value })).toBe(false);
  expect(readShowHiddenFeatures({ getItem: () => "1" })).toBe(true);
  expect(readShowHiddenFeatures({ getItem: () => { throw new Error("blocked"); } })).toBe(false);
});

test("turning it on stores 1 under the durable key; turning it off removes the key", () => {
  restore = installDom({});
  expect(readShowHiddenFeatures()).toBe(false);
  setShowHiddenFeatures(true);
  expect(localStorage.getItem(HIDDEN_FEATURES_KEY)).toBe("1");
  expect(readShowHiddenFeatures()).toBe(true);
  setShowHiddenFeatures(false);
  expect(localStorage.getItem(HIDDEN_FEATURES_KEY)).toBeNull();
  expect(readShowHiddenFeatures()).toBe(false);
});
