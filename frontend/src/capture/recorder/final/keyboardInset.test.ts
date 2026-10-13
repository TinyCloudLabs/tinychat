import { describe, expect, test } from "bun:test";
import { keyboardInset } from "./keyboardInset";

describe("keyboardInset", () => {
  test("is the part of the layout viewport the visual viewport leaves uncovered", () => {
    expect(keyboardInset({ height: 500, offsetTop: 0 }, 844)).toBe(344);
  });
  test("subtracts a panned viewport", () => {
    expect(keyboardInset({ height: 500, offsetTop: 40 }, 844)).toBe(304);
  });
  test("is 0 with no keyboard, and never negative", () => {
    expect(keyboardInset({ height: 844, offsetTop: 0 }, 844)).toBe(0);
    expect(keyboardInset({ height: 900, offsetTop: 0 }, 844)).toBe(0);
  });
});
