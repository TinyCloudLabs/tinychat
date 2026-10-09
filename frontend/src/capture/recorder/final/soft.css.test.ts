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
  test.each([
    [
      "night",
      "phone",
      "rgba(255, 255, 255, 0.07)",
      "rgba(255, 255, 255, 0.12)",
      "#a397ae",
      "#ff6b62",
      "#e8475a",
    ],
    [
      "night",
      "rail",
      "rgba(255, 255, 255, 0.06)",
      "rgba(255, 255, 255, 0.11)",
      "#a397ae",
      "#ff6b62",
      "#e8475a",
    ],
    [
      "night",
      "desktop",
      "rgba(255, 255, 255, 0.06)",
      "rgba(255, 255, 255, 0.11)",
      "#a397ae",
      "#ff6b62",
      "#e8475a",
    ],
    [
      "day",
      "phone",
      "rgba(255, 255, 255, 0.6)",
      "rgba(255, 255, 255, 0.95)",
      "#9a8c92",
      "#e5483f",
      "#f07a72",
    ],
    [
      "day",
      "rail",
      "rgba(255, 255, 255, 0.66)",
      "rgba(58, 47, 54, 0.1)",
      "#8f8288",
      "#e5483f",
      "#f07a72",
    ],
    [
      "day",
      "desktop",
      "rgba(255, 255, 255, 0.66)",
      "rgba(58, 47, 54, 0.1)",
      "#8f8288",
      "#e5483f",
      "#f07a72",
    ],
  ] as const)(
    "%s × %s",
    (theme, layout, glass, gedge, dim, accent, secondary) => {
      const tokens = computedTokens(theme, layout);
      expect(tokens["--glass"]).toBe(glass);
      expect(tokens["--gedge"]).toBe(gedge);
      expect(tokens["--dim"]).toBe(dim);
      expect(tokens["--ring-accent"]).toBe(accent);
      expect(tokens["--ring-accent-secondary"]).toBe(secondary);
    },
  );
});
