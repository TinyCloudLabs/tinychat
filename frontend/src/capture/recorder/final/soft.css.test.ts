import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import postcss from "postcss";

const css = readFileSync(new URL("./soft.css", import.meta.url), "utf8");
const stylesheet = postcss.parse(css);
const appThemeCss = readFileSync(new URL("../../../index.css", import.meta.url), "utf8");
const appThemeStylesheet = postcss.parse(appThemeCss);

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

type RGB = readonly [number, number, number];
interface ResolvedColor { rgb: RGB; alpha: number }

function appTokens(theme: "night" | "day"): Record<string, string> {
  const selector = theme === "night" ? ".dark" : ":root";
  const tokens: Record<string, string> = {};
  appThemeStylesheet.walkRules((rule) => {
    if (!rule.selectors?.includes(selector)) return;
    rule.walkDecls((declaration) => {
      if (declaration.prop.startsWith("--")) tokens[declaration.prop] = declaration.value;
    });
  });
  return tokens;
}

function resolveColor(
  value: string,
  theme: "night" | "day",
  softTokens: Record<string, string>,
  themeTokens = appTokens(theme),
  seen = new Set<string>(),
): ResolvedColor {
  const variable = value.match(/^var\((--[\w-]+)\)$/);
  if (variable) {
    const name = variable[1]!;
    if (seen.has(name)) throw new Error(`Theme token cycle at ${name}`);
    const referenced = softTokens[name] ?? themeTokens[name];
    if (!referenced) throw new Error(`Missing theme token ${name}`);
    return resolveColor(referenced, theme, softTokens, themeTokens, new Set([...seen, name]));
  }

  const hex = value.match(/^#([\da-f]{6})$/i);
  if (hex) {
    const raw = hex[1]!;
    return {
      rgb: [0, 2, 4].map((offset) => Number.parseInt(raw.slice(offset, offset + 2), 16)) as unknown as RGB,
      alpha: 1,
    };
  }

  const hsl = value.match(/^hsl\(\s*var\((--[\w-]+)\)(?:\s*\/\s*([\d.]+))?\s*\)$/);
  const components = hsl
    ? themeTokens[hsl[1]!]
    : value.match(/^hsl\(([^)]+)\)$/)?.[1] ?? value;
  if (!components) throw new Error(`Missing theme color ${hsl?.[1]}`);
  if (components !== value) {
    const color = resolveColor(components, theme, softTokens, themeTokens, new Set([...seen, hsl?.[1] ?? ""]));
    return { ...color, alpha: color.alpha * Number(hsl?.[2] ?? 1) };
  }
  const [hueRaw, saturationRaw, lightnessRaw] = components.trim().split(/\s+/);
  const hue = Number.parseFloat(hueRaw!);
  const saturation = Number.parseFloat(saturationRaw!) / 100;
  const lightness = Number.parseFloat(lightnessRaw!) / 100;
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const x = chroma * (1 - Math.abs((hue / 60) % 2 - 1));
  const m = lightness - chroma / 2;
  const sector = Math.floor(((hue % 360) + 360) % 360 / 60);
  const base: RGB = sector === 0 ? [chroma, x, 0]
    : sector === 1 ? [x, chroma, 0]
      : sector === 2 ? [0, chroma, x]
        : sector === 3 ? [0, x, chroma]
          : sector === 4 ? [x, 0, chroma]
            : [chroma, 0, x];
  return { rgb: base.map((channel) => (channel + m) * 255) as unknown as RGB, alpha: 1 };
}

function composite(foreground: ResolvedColor, background: RGB): RGB {
  return foreground.rgb.map((channel, index) =>
    channel * foreground.alpha + background[index]! * (1 - foreground.alpha),
  ) as unknown as RGB;
}

function contrast(foreground: RGB, background: RGB): number {
  const channel = (value: number) => {
    const normalized = value / 255;
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  };
  const luminance = ([red, green, blue]: RGB) =>
    0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue);
  const first = luminance(foreground);
  const second = luminance(background);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
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
    expect(day["--gedge"]).toBe("hsl(var(--border))");
    expect(night["--line"]).toBe("hsl(var(--foreground) / 0.4)");
    expect(day["--line"]).toBe("hsl(var(--border))");
    expect(night["--glass"]).toBe("hsl(var(--foreground) / 0.05)");
    expect(night["--solid"]).toBe("hsl(var(--popover))");
    expect(night["--disc"]).toBe("hsl(var(--secondary))");
    expect(night["--red-text"]).toBe("var(--red)");
    expect(day["--glass"]).toBe("hsl(var(--card) / 0.7)");
    expect(day["--solid"]).toBe("hsl(var(--popover))");
    expect(day["--red-text"]).toBe("hsl(var(--destructive))");
    expect(day["--disc"]).toBe("hsl(var(--card))");
  });

  test("retains the recording ring accents in each theme", () => {
    expect(computedTokens("night", "phone")["--ring-accent"]).toBe("#ff6b62");
    expect(computedTokens("day", "phone")["--ring-accent"]).toBe("#e5483f");
  });

  test("Soft outlines, red text and halo disc meet token-derived contrast", () => {
    for (const mode of ["night", "day"] as const) {
      const soft = computedTokens(mode, "phone");
      const app = appTokens(mode);
      const surface = resolveColor(soft["--solid"]!, mode, soft, app).rgb;
      const glass = composite(resolveColor(soft["--glass"]!, mode, soft, app), surface);
      const side = resolveColor(soft["--side"]!, mode, soft, app).rgb;
      const edge = resolveColor(soft["--gedge"]!, mode, soft, app);
      const edgeTargets = [surface, glass, side];
      const edgeRatios = edgeTargets.map((background) => contrast(composite(edge, background), background));
      expect(soft["--solid"]).toBe("hsl(var(--popover))");
      expect(soft["--line"]).toBe(soft["--gedge"]);
      if (mode === "night") {
        expect(edgeRatios.every((ratio) => ratio >= 3)).toBe(true);
      } else {
        expect(soft["--gedge"]).toBe("hsl(var(--border))");
        expect(soft["--line"]).toBe("hsl(var(--border))");
      }

      const red = resolveColor(soft["--red-text"]!, mode, soft, app);
      expect(red.rgb[0]).toBeGreaterThan(red.rgb[1]);
      expect(red.rgb[0]).toBeGreaterThan(red.rgb[2]);
      expect([surface, side].every((background) => contrast(composite(red, background), background) >= 4.5)).toBe(true);
      const dim = resolveColor(soft["--dim"]!, mode, soft, app);
      expect(contrast(composite(dim, surface), surface)).toBeGreaterThanOrEqual(4.5);
      const page = resolveColor(soft["--bgc"]!, mode, soft, app).rgb;
      const disc = resolveColor(soft["--disc"]!, mode, soft, app);
      expect(disc.alpha).toBe(1);
      if (mode === "night") expect(contrast(disc.rgb, page)).toBeGreaterThanOrEqual(1.3);
    }
  });
});
