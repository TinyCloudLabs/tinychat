import { describe, expect, test } from "bun:test";

import { iosDynamicTypeScale, IOS_DYNAMIC_TYPE_MAX_SCALE, setIOSDynamicTypeScale } from "./dynamicType";

describe("iOS Dynamic Type rem scale", () => {
  test("normalizes the default 17px body to the existing 16px design", () => {
    expect(iosDynamicTypeScale(17)).toBe(1);
    expect(iosDynamicTypeScale(34)).toBe(2);
  });

  test("keeps smaller body settings bounded and caps AX3/AX5 layouts at 2×", () => {
    expect(iosDynamicTypeScale(13)).toBeCloseTo(0.8);
    expect(iosDynamicTypeScale(40)).toBe(IOS_DYNAMIC_TYPE_MAX_SCALE);
    expect(iosDynamicTypeScale(53)).toBe(IOS_DYNAMIC_TYPE_MAX_SCALE);
    expect(iosDynamicTypeScale(Number.NaN)).toBe(1);
  });

  test("writes the scale used by the iOS root stylesheet", () => {
    let assigned = "";
    const root = { style: { setProperty: (_name: string, value: string) => { assigned = value; } } } as unknown as HTMLElement;
    expect(setIOSDynamicTypeScale(root, 40)).toBe(2);
    expect(assigned).toBe("2");
  });
});
