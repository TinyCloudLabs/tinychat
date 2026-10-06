// The palette's promises, checked from the token source (index.css): every Day
// token has a Night value, every text pair clears 4.5:1 and every control edge,
// icon and ring clears 3:1 (WCAG 2.2), except the pairs below that Exo's
// original zinc palette has always had, and the browser chrome colours agree
// everywhere.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { contrast, hslTriplet, over, toHex, type Rgb } from "./harness/color";
import { THEME_COLOR } from "./lib/theme";

const css = readFileSync(new URL("./index.css", import.meta.url), "utf8");

/** The custom properties of the first `<selector> {` block that defines --background. */
function block(selector: ":root" | ".dark"): Map<string, string> {
  const pattern = new RegExp(`(?:^|\\n)\\s*${selector.replace(".", "\\.")} \\{([^}]*)\\}`, "g");
  for (const match of css.matchAll(pattern)) {
    const body = match[1]!.replace(/\/\*[\s\S]*?\*\//g, "");
    if (!body.includes("--background:")) continue;
    return new Map([...body.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]));
  }
  throw new Error(`index.css has no ${selector} palette block`);
}

const themes = { Day: block(":root"), Night: block(".dark") } as const;
type ThemeName = keyof typeof themes;

const color = (theme: ThemeName, name: string): Rgb => {
  const value = themes[theme].get(`--${name}`);
  if (!value) throw new Error(`${theme} has no --${name}`);
  return hslTriplet(value);
};
const number = (theme: ThemeName, name: string) => Number.parseFloat(themes[theme].get(`--${name}`)!);

// Tokens that are the same in both themes.
const THEME_INDEPENDENT = new Set(["--radius"]);

const SURFACES = ["background", "chrome", "card", "surface-2", "popover"] as const;
const TEXT = ["foreground", "muted-foreground", "primary", "live", "warning", "destructive"] as const;

interface Pair {
  what: string;
  fg: (theme: ThemeName) => Rgb;
  bg: (theme: ThemeName) => Rgb;
  min: number;
}

const tint = (theme: ThemeName, surface: string) => over(color(theme, "primary"), number(theme, "selected-alpha"), color(theme, surface));

const PAIRS: Pair[] = [
  // §2.2.2: every text role on every surface; control edges at 3:1.
  ...TEXT.flatMap((role) =>
    SURFACES.map((surface) => ({ what: `${role} on ${surface}`, fg: (t: ThemeName) => color(t, role), bg: (t: ThemeName) => color(t, surface), min: 4.5 })),
  ),
  ...SURFACES.map((surface) => ({ what: `input edge on ${surface}`, fg: (t: ThemeName) => color(t, "input"), bg: (t: ThemeName) => color(t, surface), min: 3 })),
  // The paired foregrounds.
  ...(["card", "popover", "secondary", "accent", "primary", "live", "destructive"] as const).map((fill) => ({
    what: `${fill}-foreground on ${fill}`,
    fg: (t: ThemeName) => color(t, `${fill}-foreground`),
    bg: (t: ThemeName) => color(t, fill),
    min: 4.5,
  })),
  // §2.2.3: the selected tint (primary over each surface), the segmented thumb, the ring.
  ...(["background", "chrome", "card", "surface-2"] as const).flatMap((surface) => [
    { what: `foreground on the selected tint over ${surface}`, fg: (t: ThemeName) => color(t, "foreground"), bg: (t: ThemeName) => tint(t, surface), min: 4.5 },
    { what: `muted-foreground on the selected tint over ${surface}`, fg: (t: ThemeName) => color(t, "muted-foreground"), bg: (t: ThemeName) => tint(t, surface), min: 4.5 },
  ]),
  { what: "segmented thumb edge (primary) against the track", fg: (t) => color(t, "primary"), bg: (t) => color(t, "surface-2"), min: 3 },
  { what: "segmented check icon (primary) on the thumb", fg: (t) => color(t, "primary"), bg: (t) => tint(t, "surface-2"), min: 3 },
  { what: "focus ring against a card", fg: (t) => color(t, "ring"), bg: (t) => color(t, "card"), min: 3 },
  { what: "focus ring against the ground", fg: (t) => color(t, "ring"), bg: (t) => color(t, "background"), min: 3 },
  {
    what: "text in a ::selection",
    fg: (t) => color(t, "foreground"),
    bg: (t) => over(color(t, "primary"), number(t, "selection-alpha"), color(t, "background")),
    min: 4.5,
  },
];

describe("design tokens (index.css)", () => {
  test("every Day token has a Night value and the other way round", () => {
    const day = [...themes.Day.keys()].filter((name) => !THEME_INDEPENDENT.has(name)).sort();
    const night = [...themes.Night.keys()].sort();
    expect(night).toEqual(day);
  });

  // Pairs below their minimum in Exo's original zinc palette, which the owner
  // chose to keep (TC-761): hairline input edges, muted text on the raised grey,
  // muted text on the selected tint, and dark destructive text. The list is
  // exact, so any new pair that falls below its minimum fails, and so does
  // fixing one without updating it here.
  const KNOWN_BELOW_MINIMUM: Record<ThemeName, string[]> = {
    Day: [
      "muted-foreground on surface-2",
      "destructive on surface-2",
      ...SURFACES.map((surface) => `input edge on ${surface}`),
      ...(["background", "chrome", "card", "surface-2"] as const).map((surface) => `muted-foreground on the selected tint over ${surface}`),
    ],
    Night: [
      "live on surface-2",
      ...SURFACES.map((surface) => `destructive on ${surface}`),
      ...SURFACES.map((surface) => `input edge on ${surface}`),
      "muted-foreground on the selected tint over surface-2",
    ],
  };

  for (const theme of ["Day", "Night"] as const) {
    test(`${theme}: every pair clears its contrast minimum, apart from the original palette's known pairs`, () => {
      const failing = PAIRS.filter((pair) => contrast(pair.fg(theme), pair.bg(theme)) < pair.min).map((pair) => pair.what);
      expect(failing.sort()).toEqual([...KNOWN_BELOW_MINIMUM[theme]].sort());
    });
  }

  test("the browser chrome colour is --background in each theme, everywhere it is written", () => {
    expect(THEME_COLOR.light).toBe(toHex(color("Day", "background")));
    expect(THEME_COLOR.dark).toBe(toHex(color("Night", "background")));

    const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
    expect(html).toContain(`<meta name="theme-color" media="(prefers-color-scheme: light)" content="${THEME_COLOR.light}" />`);
    expect(html).toContain(`<meta name="theme-color" media="(prefers-color-scheme: dark)" content="${THEME_COLOR.dark}" />`);
    // The pre-paint script's override for a chosen theme.
    expect(html).toContain(`dark ? "${THEME_COLOR.dark}" : "${THEME_COLOR.light}"`);

    const vite = readFileSync(new URL("../vite.config.ts", import.meta.url), "utf8");
    expect(vite).toContain(`theme_color: "${THEME_COLOR.light}"`);
    expect(vite).toContain(`background_color: "${THEME_COLOR.light}"`);
  });
});
