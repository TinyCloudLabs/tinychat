import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import postcss from "postcss";

const css = readFileSync(new URL("./soft.css", import.meta.url), "utf8");
const stylesheet = postcss.parse(css);

interface FixtureElement {
  classes: Set<string>;
  attributes: Map<string, string>;
  parent?: FixtureElement;
}

type Specificity = readonly [
  ids: number,
  classesAndAttributes: number,
  elements: number,
];

function fixtureElement(
  classes: string[],
  attributes: Record<string, string> = {},
  parent?: FixtureElement,
): FixtureElement {
  return {
    classes: new Set(classes),
    attributes: new Map(Object.entries(attributes)),
    parent,
  };
}

function identifierEnd(selector: string, start: number): number {
  let end = start;
  while (end < selector.length && /[\w-]/.test(selector[end]!)) end += 1;
  return end;
}

function matchesCompound(selector: string, element: FixtureElement): boolean {
  let index = 0;
  while (index < selector.length) {
    const marker = selector[index];
    if (marker === ".") {
      const end = identifierEnd(selector, index + 1);
      if (!element.classes.has(selector.slice(index + 1, end))) return false;
      index = end;
      continue;
    }
    if (marker === "[") {
      const end = selector.indexOf("]", index + 1);
      if (end === -1)
        throw new Error(`Invalid attribute selector: ${selector}`);
      const expression = selector.slice(index + 1, end);
      const equalsAt = expression.indexOf("=");
      const name = (
        equalsAt === -1 ? expression : expression.slice(0, equalsAt)
      ).trim();
      const rawValue =
        equalsAt === -1 ? undefined : expression.slice(equalsAt + 1).trim();
      const expected = rawValue?.replace(/^['"]|['"]$/g, "");
      const actual = element.attributes.get(name);
      if (
        actual === undefined ||
        (expected !== undefined && actual !== expected)
      ) {
        return false;
      }
      index = end + 1;
      continue;
    }
    throw new Error(
      `Unsupported selector syntax in CSS cascade test: ${selector}`,
    );
  }
  return true;
}

function selectorMatches(selector: string, target: FixtureElement): boolean {
  const compounds = selector.trim().split(/\s+/);
  if (!matchesCompound(compounds[compounds.length - 1]!, target)) return false;

  let ancestor = target.parent;
  for (let index = compounds.length - 2; index >= 0; index -= 1) {
    while (ancestor && !matchesCompound(compounds[index]!, ancestor)) {
      ancestor = ancestor.parent;
    }
    if (!ancestor) return false;
    ancestor = ancestor.parent;
  }
  return true;
}

function selectorSpecificity(selector: string): Specificity {
  let ids = 0;
  let classesAndAttributes = 0;
  const elements = 0;
  for (const character of selector) {
    if (character === "#") ids += 1;
    if (character === "." || character === "[") classesAndAttributes += 1;
    if (character === ">" || character === "+" || character === "~") {
      throw new Error(
        `Unsupported combinator in CSS cascade test: ${selector}`,
      );
    }
  }
  return [ids, classesAndAttributes, elements];
}

function specificityCompare(left: Specificity, right: Specificity): number {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index]! - right[index]!;
  }
  return 0;
}

function computedTokens(theme: "night" | "day", layout: string) {
  const darkAncestor = fixtureElement(["dark"]);
  const target = fixtureElement(
    ["soft-skin", `soft-${theme}`],
    { "data-layout": layout },
    darkAncestor,
  );
  const winners = new Map<
    string,
    { value: string; specificity: Specificity; order: number }
  >();
  let order = 0;

  stylesheet.walkRules((rule) => {
    for (const selector of rule.selectors ?? [rule.selector]) {
      if (!selectorMatches(selector, target)) continue;
      const specificity = selectorSpecificity(selector);
      rule.walkDecls((declaration) => {
        if (!declaration.prop.startsWith("--")) return;
        const current = winners.get(declaration.prop);
        if (
          !current ||
          specificityCompare(specificity, current.specificity) > 0 ||
          (specificityCompare(specificity, current.specificity) === 0 &&
            order >= current.order)
        ) {
          winners.set(declaration.prop, {
            value: declaration.value,
            specificity,
            order,
          });
        }
        order += 1;
      });
    }
  });

  return Object.fromEntries(
    [...winners].map(([name, winner]) => [name, winner.value]),
  ) as Record<string, string>;
}

describe("Soft skin theme and layout tokens", () => {
  test.each(["phone", "rail", "desktop"])("zinc palette on %s", (layout) => {
    const night = computedTokens("night", layout);
    const day = computedTokens("day", layout);
    for (const tokens of [night, day]) {
      expect(tokens["--ink"]).toBe("hsl(var(--foreground))");
      expect(tokens["--dim"]).toBe("hsl(var(--muted-foreground))");
      expect(tokens["--bgc"]).toBe("hsl(var(--background))");
      expect(tokens["--side"]).toBe("hsl(var(--chrome))");
      expect(tokens["--red"]).toMatch(/^#(?:ff6b62|e5483f)$/);
    }
    expect(night["--gedge"]).toBe("hsl(var(--foreground) / 0.4)");
    expect(day["--gedge"]).toBe("hsl(var(--foreground) / 0.55)");
    expect(night["--line"]).toBe("hsl(var(--foreground) / 0.4)");
    expect(day["--line"]).toBe("hsl(var(--foreground) / 0.55)");
    expect(night["--glass"]).toBe("hsl(var(--foreground) / 0.05)");
    expect(night["--solid"]).toBe("hsl(var(--popover))");
    expect(day["--glass"]).toBe("hsl(var(--card) / 0.7)");
    expect(day["--solid"]).toBe("hsl(var(--popover))");
  });

  test("retains the recording ring accents in each theme", () => {
    expect(computedTokens("night", "phone")["--ring-accent"]).toBe("#ff6b62");
    expect(computedTokens("day", "phone")["--ring-accent"]).toBe("#e5483f");
  });

  test("Soft sheet outlines and dividers clear 3:1 in both themes", () => {
    const blend = (foreground: number, background: number, alpha: number) =>
      foreground * alpha + background * (1 - alpha);
    const luminance = (channel: number) => {
      const normalized = channel / 255;
      return normalized <= 0.04045
        ? normalized / 12.92
        : ((normalized + 0.055) / 1.055) ** 2.4;
    };
    const contrast = (foreground: readonly number[], background: readonly number[]) => {
      const rgbLuminance = ([r, g, b]: readonly number[]) =>
        0.2126 * luminance(r) + 0.7152 * luminance(g) + 0.0722 * luminance(b);
      const first = rgbLuminance(foreground);
      const second = rgbLuminance(background);
      return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
    };
    const cases = [
      { mode: "night", foreground: [250, 250, 250], background: [15, 15, 17], alpha: 0.4 },
      { mode: "day", foreground: [10, 10, 12], background: [255, 255, 255], alpha: 0.55 },
    ] as const;

    for (const { mode, foreground, background, alpha } of cases) {
      const tokens = computedTokens(mode, "phone");
      const edge = foreground.map((channel, index) =>
        blend(channel, background[index]!, alpha),
      );
      expect(tokens["--solid"]).toBe("hsl(var(--popover))");
      expect(tokens["--line"]).toBe(tokens["--gedge"]);
      expect(contrast(edge, background)).toBeGreaterThanOrEqual(3);
    }
  });

  test("light-mode destructive text clears 4.5:1 while ring red stays separate", () => {
    const lightText = [220, 38, 38];
    const white = [255, 255, 255];
    const channel = (value: number) => {
      const normalized = value / 255;
      return normalized <= 0.04045
        ? normalized / 12.92
        : ((normalized + 0.055) / 1.055) ** 2.4;
    };
    const luma = ([r, g, b]: readonly number[]) =>
      0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
    const ratio = (luma(white) + 0.05) / (luma(lightText) + 0.05);
    expect(ratio).toBeGreaterThanOrEqual(4.5);
    expect(computedTokens("day", "phone")["--red"]).toBe("#e5483f");
  });
});
