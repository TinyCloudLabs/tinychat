// TC-4382: the working indicator. It draws the bot's chosen icon without motion inside its own frame and says the
// step to a screen reader once per change. It moves only where the reader allows motion. The shared avatar and
// shapes are untouched: nothing of the indicator is in them.
import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

import { installDom } from "@/test/dom";
import { BotAvatar, MAIN_BOT } from "./BotAvatar";
import { BotShape, BOT_COLOURS } from "./botShapes";
import { BotWorkingMark, BotWorkingStatus } from "./BotWorking";

let restore: (() => void) | undefined;
let mounted: Root | undefined;
afterEach(() => {
  if (mounted) act(() => mounted!.unmount());
  mounted = undefined;
  restore?.();
  restore = undefined;
  Reflect.deleteProperty(globalThis, "matchMedia");
});

/** The reader's motion setting, as the browser reports it; `change` flips it while the page is open. */
function motionSetting(reduced: boolean) {
  const listeners = new Set<() => void>();
  const query = {
    get matches() { return reduced; },
    addEventListener: (_type: string, listener: () => void) => { listeners.add(listener); },
    removeEventListener: (_type: string, listener: () => void) => { listeners.delete(listener); },
  };
  Object.defineProperty(globalThis, "matchMedia", {
    configurable: true,
    value: (media: string) => {
      expect(media).toBe("(prefers-reduced-motion: reduce)");
      return query;
    },
  });
  return { change(next: boolean) { reduced = next; for (const listener of [...listeners]) listener(); }, listeners };
}

async function render(node: ReactNode) {
  restore = installDom();
  const host = document.createElement("div");
  document.body.append(host);
  mounted = createRoot(host);
  await act(async () => mounted!.render(node));
  return host;
}

const PICKED = { key: "main", name: "TrustBot", shape: "comet", colour: "purple" } as const;
const text = (host: HTMLElement) => host.querySelector('[role="status"]')!;
const marked = (host: HTMLElement) => host.querySelectorAll("[data-motion]").length;

test("with motion allowed the mark and the step text carry the motion mark", async () => {
  motionSetting(false);
  const host = await render(<BotWorkingStatus bot={PICKED} step="Searching the web…" />);
  expect(host.querySelector("[data-bot-working]")!.hasAttribute("data-motion")).toBe(true);
  expect(text(host).hasAttribute("data-motion")).toBe(true);
});

test("with reduced motion nothing carries the motion mark, and the step text is there all the same", async () => {
  motionSetting(true);
  const host = await render(<BotWorkingStatus bot={PICKED} step="Searching the web…" />);
  expect(marked(host)).toBe(0);
  expect(text(host).textContent).toBe("Searching the web…");
  await act(async () => mounted!.render(<BotWorkingStatus bot={PICKED} step="Reading tides.example…" />));
  expect(marked(host)).toBe(0);
  expect(text(host).textContent).toBe("Reading tides.example…");
});

test("where the motion setting cannot be read, nothing moves", async () => {
  const host = await render(<BotWorkingStatus bot={PICKED} step="Working on it…" />);
  expect(marked(host)).toBe(0);
});

test("turning reduced motion on while the indicator shows stops it, and off starts it", async () => {
  const setting = motionSetting(false);
  const host = await render(<BotWorkingStatus bot={PICKED} step="Working on it…" />);
  expect(marked(host)).toBe(2);
  await act(async () => setting.change(true));
  expect(marked(host)).toBe(0);
  await act(async () => setting.change(false));
  expect(marked(host)).toBe(2);
  act(() => mounted!.unmount());
  mounted = undefined;
  expect(setting.listeners.size).toBe(0);
});

test("the stylesheet runs every animation only where motion is allowed and the motion mark is set", () => {
  const css = readFileSync(new URL("./botWorking.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  // Top-level blocks: a rule, a @keyframes or a @media with its rules.
  const blocks: { head: string; body: string }[] = [];
  let depth = 0;
  let start = 0;
  let head = "";
  for (let i = 0; i < css.length; i++) {
    if (css[i] === "{") {
      if (depth === 0) { head = css.slice(start, i).trim(); start = i + 1; }
      depth++;
    } else if (css[i] === "}") {
      depth--;
      if (depth === 0) { blocks.push({ head, body: css.slice(start, i) }); start = i + 1; }
    }
  }
  const animated = blocks.filter((block) => !block.head.startsWith("@keyframes") && /animation\s*:/.test(block.body));
  expect(animated.length).toBeGreaterThanOrEqual(2);
  for (const block of animated) {
    expect(block.head).toStartWith("@media (prefers-reduced-motion: no-preference)");
    for (const rule of block.body.split("}").filter((part) => /animation\s*:/.test(part))) {
      expect(rule.split("{")[0]).toContain("[data-motion]");
    }
  }
  const names = [...css.matchAll(/@keyframes\s+([\w-]+)/g)].map((match) => match[1]!);
  expect(names.sort()).toEqual(["tc-bot-working-breathe", "tc-bot-working-glare", "tc-bot-working-run"]);
  for (const name of names) expect(animated.some((block) => block.body.includes(name))).toBe(true);
});

test("the step text is a polite status the reader hears per change: the same element, with new text", async () => {
  motionSetting(false);
  const host = await render(<BotWorkingStatus bot={PICKED} step="Working on it…" />);
  const status = text(host);
  expect(status.getAttribute("aria-live")).toBe("polite");
  expect(host.querySelectorAll('[role="status"]')).toHaveLength(1);
  expect(host.querySelector("[data-bot-working]")!.getAttribute("aria-hidden")).toBe("true");
  expect(status.querySelector("*")).toBeNull();
  await act(async () => mounted!.render(<BotWorkingStatus bot={PICKED} step="Searching the web…" />));
  expect(text(host)).toBe(status);
  expect(status.textContent).toBe("Searching the web…");
});

test("the mark shows the shape and colour the owner picked, drawn as the shared shape draws it", async () => {
  const host = await render(<BotWorkingMark bot={PICKED} size={28} />);
  const mark = host.querySelector<HTMLElement>("[data-bot-working]")!;
  expect(mark.style.getPropertyValue("--tc-working-hue")).toBe(String(BOT_COLOURS.purple));
  expect(mark.innerHTML).toContain(renderToStaticMarkup(<BotShape shape="comet" size={21} />));
  expect(mark.innerHTML).not.toContain(renderToStaticMarkup(<BotShape shape="pebble" size={21} />));
});

test("another shape and colour draw as theirs, and the main bot before a pick keeps its first icon", async () => {
  const research = await render(<BotWorkingMark bot={{ name: "Research", shape: "sprout", colour: "green" }} size={28} />);
  expect(research.querySelector<HTMLElement>("[data-bot-working]")!.style.getPropertyValue("--tc-working-hue")).toBe(String(BOT_COLOURS.green));
  expect(research.innerHTML).toContain(renderToStaticMarkup(<BotShape shape="sprout" size={21} />));
  act(() => mounted!.unmount());
  restore!();

  const first = await render(<BotWorkingMark bot={{ key: "main", name: MAIN_BOT.name, shape: "pebble", colour: "blue" }} size={28} />);
  expect(first.querySelector<HTMLElement>("[data-bot-working]")!.style.getPropertyValue("--tc-working-hue")).toBe(String(MAIN_BOT.hue));
  expect(first.innerHTML).toContain("lucide-sparkles");
  expect(first.innerHTML).not.toContain(renderToStaticMarkup(<BotShape shape="pebble" size={21} />));
});

test("the shared avatar and shapes hold nothing of the indicator", async () => {
  for (const file of ["./BotAvatar.tsx", "./botShapes.tsx"]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    const imports = [...source.matchAll(/^import\s[^;]*?from\s+"([^"]+)"|^import\s+"([^"]+)"/gm)].map((match) => match[1] ?? match[2]!);
    for (const from of imports) expect(from).not.toMatch(/working/i);
    expect(source).not.toContain("tc-bot-working");
    expect(source).not.toContain("data-motion");
  }
  motionSetting(false);
  const host = await render(<><BotAvatar bot={PICKED} working /><BotAvatar bot={MAIN_BOT} /><BotShape shape="comet" size={21} /></>);
  expect(host.querySelector('[class*="tc-bot-working"], [data-motion], [data-bot-working-row], [role="status"]')).toBeNull();
});
