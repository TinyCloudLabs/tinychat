import { describe, expect, test } from "bun:test";

import {
  androidDynamicTypeScale,
  iosDynamicTypeScale,
  IOS_DYNAMIC_TYPE_MAX_SCALE,
  setAndroidDynamicTypeScale,
  setIOSDynamicTypeScale,
} from "./dynamicType";

describe("iOS Dynamic Type rem scale", () => {
  test("normalizes the default 17px body to the existing 16px design", () => {
    expect(iosDynamicTypeScale(17)).toBe(1);
    expect(iosDynamicTypeScale(34)).toBe(2);
  });

  test("keeps the 16px design as the minimum and caps AX3/AX5 layouts at 2×", () => {
    expect(iosDynamicTypeScale(13)).toBe(1);
    expect(iosDynamicTypeScale(40)).toBe(IOS_DYNAMIC_TYPE_MAX_SCALE);
    expect(iosDynamicTypeScale(53)).toBe(IOS_DYNAMIC_TYPE_MAX_SCALE);
    expect(iosDynamicTypeScale(Number.NaN)).toBe(1);
  });

  test("writes the scale used by the iOS root stylesheet", () => {
    let assigned = "";
    const attributes = new Set<string>();
    const root = {
      style: { setProperty: (_name: string, value: string) => { assigned = value; } },
      toggleAttribute: (name: string, present: boolean) => present ? attributes.add(name) : attributes.delete(name),
    } as unknown as HTMLElement;
    expect(setIOSDynamicTypeScale(root, 40)).toBe(2);
    expect(assigned).toBe("2");
    expect(attributes.has("data-large-text")).toBe(true);
  });
});

describe("Android WebView text zoom scale", () => {
  test("preserves the default scale and caps accessibility sizes at 2×", () => {
    expect(androidDynamicTypeScale(1)).toBe(1);
    expect(androidDynamicTypeScale(1.5)).toBe(1.5);
    expect(androidDynamicTypeScale(2)).toBe(2);
    expect(androidDynamicTypeScale(2.5)).toBe(2);
    expect(androidDynamicTypeScale(Number.NaN)).toBe(1);
  });

  test("writes the scale used by Android's timer and column sizing", () => {
    let assigned = "";
    const attributes = new Set<string>();
    const root = {
      style: { setProperty: (_name: string, value: string) => { assigned = value; } },
      toggleAttribute: (name: string, present: boolean) => present ? attributes.add(name) : attributes.delete(name),
    } as unknown as HTMLElement;
    expect(setAndroidDynamicTypeScale(root, 2.5)).toBe(2);
    expect(assigned).toBe("2");
    expect(attributes.has("data-large-text")).toBe(true);
    expect(setAndroidDynamicTypeScale(root, 1)).toBe(1);
    expect(attributes.has("data-large-text")).toBe(false);
  });
});
