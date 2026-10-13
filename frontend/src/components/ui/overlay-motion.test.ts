// With reduced motion, every overlay and its content (sheet, dialog, alert
// dialog) opens and closes in 150ms or less, and fades in place. Radix portals
// do not render on the server, so the class lists are read from the components'
// cn() calls; the cascade check compiles them with the app's Tailwind config.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const PRIMITIVES: Array<[file: string, components: string[]]> = [
  ["sheet", ["SheetOverlay", "SheetContent"]],
  ["dialog", ["DialogOverlay", "DialogContent"]],
  ["alert-dialog", ["AlertDialogOverlay", "AlertDialogContent"]],
];

/** The class names a primitive's element passes to cn(), from its source. */
function classesOf(file: string, component: string): string[] {
  const source = readFileSync(new URL(`./${file}.tsx`, import.meta.url), "utf8");
  const start = source.indexOf(`const ${component} = React.forwardRef`);
  if (start < 0) throw new Error(`${file}.tsx has no ${component}`);
  const call = source.indexOf("className={cn(", start);
  const end = source.indexOf("className,", call);
  return [...source.slice(call, end).matchAll(/"([^"]*)"/g)].flatMap((m) => m[1]!.split(/\s+/)).filter(Boolean);
}

function duration(classes: string[], variants: string): number | undefined {
  const prefix = `${variants}duration-`;
  const match = classes.find((c) => c.startsWith(prefix) && /^\d+$/.test(c.slice(prefix.length)));
  return match === undefined ? undefined : Number(match.slice(prefix.length));
}

describe("overlay motion", () => {
  for (const [file, components] of PRIMITIVES) {
    for (const component of components) {
      test(`${component}: 150ms or less with reduced motion, opening and closing`, () => {
        const classes = classesOf(file, component);
        for (const state of ["open", "closed"]) {
          // It animates at all, so the reduced-motion duration is what a reduced-motion user gets.
          expect(classes).toContain(`data-[state=${state}]:${state === "open" ? "animate-in" : "animate-out"}`);
          const reduced = duration(classes, `motion-reduce:data-[state=${state}]:`);
          expect(reduced).toBeDefined();
          expect(reduced!).toBeLessThanOrEqual(150);
        }
      });
    }
  }

  test("with reduced motion, dialogs do not zoom and the sheet does not slide", () => {
    for (const [file, component] of [["dialog", "DialogContent"], ["alert-dialog", "AlertDialogContent"]] as const) {
      expect(classesOf(file, component)).toEqual(
        expect.arrayContaining(["motion-reduce:data-[state=open]:zoom-in-100", "motion-reduce:data-[state=closed]:zoom-out-100"]),
      );
    }
    expect(classesOf("sheet", "SheetContent")).toEqual(
      expect.arrayContaining(["motion-reduce:data-[state=open]:slide-in-from-left-0", "motion-reduce:data-[state=closed]:slide-out-to-left-0"]),
    );
  });

  test("the reduced-motion rules come after the durations they override", async () => {
    const frontend = new URL("../../../", import.meta.url).pathname;
    const requireFromFrontend = createRequire(`${frontend}package.json`);
    const postcss = requireFromFrontend("postcss");
    const tailwindcss = requireFromFrontend("tailwindcss");
    const config = (await import(`${frontend}tailwind.config.js`)).default;
    const classes = PRIMITIVES.flatMap(([file, components]) => components.flatMap((component) => classesOf(file, component)));
    const css: string = (
      await postcss([tailwindcss({ ...config, content: [{ raw: classes.join(" ") }] })]).process("@tailwind utilities;", { from: undefined })
    ).css;
    const lastPlainDuration = Math.max(...[...css.matchAll(/\n\.data-\\\[state\\=(open|closed)\\\]\\:duration-\d+\[/g)].map((m) => m.index!));
    const reducedBlock = css.indexOf("@media (prefers-reduced-motion: reduce)");
    expect(lastPlainDuration).toBeGreaterThan(0);
    expect(reducedBlock).toBeGreaterThan(lastPlainDuration);
    expect(css.slice(reducedBlock)).toContain("animation-duration: 150ms");
  });
});
