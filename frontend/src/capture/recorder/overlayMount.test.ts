import { expect, test } from "bun:test";
import { overlayMount, type OverlayMountInput } from "./overlayMount";
import type { RecorderLayout } from "./final/shellCapabilities";

const LAYOUTS: RecorderLayout[] = ["phone", "rail", "desktop"];

const mount = (input: Partial<OverlayMountInput>) =>
  overlayMount({
    layout: "desktop",
    available: true,
    hosted: true,
    receipt: false,
    ...input,
  });

test("the phone layout gets the phone recorder", () => {
  expect(mount({ layout: "phone" })).toBe("phone");
  expect(mount({ layout: "phone", available: false })).toBe("phone");
});

test("rail and desktop layouts with a recorder get the desktop view", () => {
  for (const layout of ["rail", "desktop"] as const)
    expect(mount({ layout })).toBe("desktop");
});

test("above the gate there is no main region, so the rail and desktop layouts get the phone recorder in a dialog", () => {
  for (const layout of ["rail", "desktop"] as const)
    expect(mount({ layout, hosted: false })).toBe("phone");
});

test("a receipt gets its own view at every layout", () => {
  for (const layout of LAYOUTS)
    expect(mount({ layout, receipt: true })).toBe("receipt");
});
