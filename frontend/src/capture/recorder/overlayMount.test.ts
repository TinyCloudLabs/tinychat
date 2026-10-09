import { expect, test } from "bun:test";
import { overlayMount, type OverlayMountInput } from "./overlayMount";
import type { RecorderLayout, RecorderShell } from "./final/shellCapabilities";

const SHELLS: RecorderShell[] = ["phone", "desktop", "web"];
const LAYOUTS: RecorderLayout[] = ["phone", "rail", "desktop"];

const mount = (input: Partial<OverlayMountInput>) =>
  overlayMount({
    flag: true,
    shell: "web",
    layout: "desktop",
    available: true,
    receipt: false,
    ...input,
  });

test("flag off: every shell and layout keeps the classic view", () => {
  for (const shell of SHELLS)
    for (const layout of LAYOUTS)
      for (const available of [true, false])
        expect(mount({ flag: false, shell, layout, available })).toBe("legacy");
});

test("flag on, phone layout: the phone shell, and any shell with a recorder, gets the phone recorder", () => {
  expect(mount({ shell: "phone", layout: "phone" })).toBe("phone");
  expect(mount({ shell: "phone", layout: "phone", available: false })).toBe("phone");
  expect(mount({ shell: "desktop", layout: "phone" })).toBe("phone");
  expect(mount({ shell: "web", layout: "phone" })).toBe("phone");
  expect(mount({ shell: "desktop", layout: "phone", available: false })).toBe("legacy");
  expect(mount({ shell: "web", layout: "phone", available: false })).toBe("legacy");
});

test("flag on, rail and desktop layouts: any shell with a recorder gets the desktop view", () => {
  for (const shell of SHELLS)
    for (const layout of ["rail", "desktop"] as const) {
      expect(mount({ shell, layout })).toBe("desktop");
      expect(mount({ shell, layout, available: false })).toBe("legacy");
    }
});

test("a receipt keeps the classic view at every layout", () => {
  for (const shell of SHELLS)
    for (const layout of LAYOUTS)
      expect(mount({ shell, layout, receipt: true })).toBe("legacy");
});
