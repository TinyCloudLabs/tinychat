import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("./soft.css", import.meta.url), "utf8");

function computedTokens(theme: "night" | "day", layout: string) {
  const classes = new Set(["soft-skin", `soft-${theme}`]);
  const tokens: Record<string, string> = {};
  const rules = css.matchAll(/([^{}]+)\{([^{}]*)\}/g);

  for (const [, selectorText, body] of rules) {
    for (const selector of selectorText.split(",")) {
      const match = selector.match(
        /^\s*\.soft-skin\.soft-(night|day)(?:\[data-layout="(phone|rail|desktop)"\])?\s*$/,
      );
      if (!match || match[1] !== theme || (match[2] && match[2] !== layout)) {
        continue;
      }
      if (!classes.has("soft-skin")) continue;
      for (const [, name, value] of body.matchAll(
        /(--[\w-]+)\s*:\s*([^;]+);/g,
      )) {
        tokens[name] = value.trim();
      }
    }
  }
  return tokens;
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
