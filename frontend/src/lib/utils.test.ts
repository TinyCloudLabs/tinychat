import { describe, expect, test } from "bun:test";

import { cn } from "./utils";

describe("cn() knows the design system's names", () => {
  test("a type role and a text colour are different groups", () => {
    expect(cn("text-body text-muted-foreground")).toBe("text-body text-muted-foreground");
    expect(cn("font-display text-title-2 text-foreground")).toBe("font-display text-title-2 text-foreground");
  });

  test("a later font size replaces a type role", () => {
    expect(cn("text-body text-sm")).toBe("text-sm");
    expect(cn("text-sm text-meta")).toBe("text-meta");
  });

  test("the float shadow, the easings and the sheet radius merge with their groups", () => {
    expect(cn("shadow-sm shadow-float")).toBe("shadow-float");
    expect(cn("ease-smooth ease-in")).toBe("ease-in");
    expect(cn("rounded-lg rounded-t-sheet")).toBe("rounded-lg rounded-t-sheet");
    expect(cn("rounded-md rounded-sheet")).toBe("rounded-sheet");
  });

  test("a caller's height replaces the control height", () => {
    expect(cn("h-[var(--tc-control-height)] px-4", "h-8")).toBe("px-4 h-8");
    expect(cn("size-[var(--tc-control-height)]", "size-8")).toBe("size-8");
  });
});
