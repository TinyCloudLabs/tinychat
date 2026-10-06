// Size classes, computed here rather than with Tailwind height queries: with
// `interactive-widget=resizes-content` (index.html) the on-screen keyboard
// shrinks the layout viewport on Android, and a height query would flip the
// layout mid-typing. Published on <html> as data-size and data-land for the
// compact/medium/expanded/wide/land variants (tailwind.config.js). index.html's
// inline script computes the first values with the same rule, before paint.
import { useSyncExternalStore } from "react";

export type SizeClass = "compact" | "medium" | "expanded";

export interface SizeClassState {
  size: SizeClass;
  /** Landscape on a short screen: a phone on its side. Always compact. */
  land: boolean;
}

export function compute(width: number, height: number): SizeClassState {
  const land = width > height && height <= 500;
  const size: SizeClass = land ? "compact" : width >= 1024 ? "expanded" : width >= 768 ? "medium" : "compact";
  return { size, land };
}

// Inputs that bring up no keyboard.
const NO_KEYBOARD_INPUTS = new Set(["checkbox", "radio", "file", "button", "submit", "reset", "image", "range", "color", "hidden"]);

/** A field the on-screen keyboard types into. */
export function isTextEntry(element: EventTarget | null): boolean {
  const el = element as (Partial<HTMLElement> & { type?: string }) | null;
  if (!el || typeof el.tagName !== "string") return false;
  if (el.tagName === "TEXTAREA" || el.isContentEditable === true) return true;
  return el.tagName === "INPUT" && !NO_KEYBOARD_INPUTS.has((el.type ?? "text").toLowerCase());
}

const INITIAL: SizeClassState = { size: "compact", land: false };
let state = INITIAL;
const listeners = new Set<() => void>();

function publish(next: SizeClassState, root: Element) {
  root.setAttribute("data-size", next.size);
  if (next.land) root.setAttribute("data-land", "");
  else root.removeAttribute("data-land");
  if (next.size === state.size && next.land === state.land) return;
  state = next;
  for (const listener of listeners) listener();
}

/**
 * Starts tracking the window. The keyboard latch: on a touch screen, while a
 * text field has focus, a resize that keeps the width is the keyboard, so the
 * class holds. Rotation changes the width and always re-evaluates. Leaving the
 * field re-evaluates, once the keyboard has gone.
 */
export function initSizeClass(win: Window = window): () => void {
  const doc = win.document;
  const coarse = win.matchMedia("(pointer: coarse)");
  // The window as last measured without the keyboard up.
  let measured = { width: win.innerWidth, height: win.innerHeight };

  const evaluate = () => {
    measured = { width: win.innerWidth, height: win.innerHeight };
    publish(compute(measured.width, measured.height), doc.documentElement);
  };
  const onResize = () => {
    if (coarse.matches && isTextEntry(doc.activeElement) && win.innerWidth === measured.width) return;
    evaluate();
  };
  const onFocusOut = (event: FocusEvent) => {
    // Focus moving to another field keeps the keyboard up.
    if (isTextEntry(event.relatedTarget)) return;
    // The keyboard is still going down (same width, still shorter than before):
    // the resize it fires once gone re-evaluates. Doing it now would flip the
    // layout for the length of the keyboard's animation.
    if (win.innerWidth === measured.width && win.innerHeight < measured.height) return;
    evaluate();
  };

  evaluate();
  win.addEventListener("resize", onResize);
  win.addEventListener("orientationchange", onResize);
  doc.addEventListener("focusout", onFocusOut);
  return () => {
    win.removeEventListener("resize", onResize);
    win.removeEventListener("orientationchange", onResize);
    doc.removeEventListener("focusout", onFocusOut);
  };
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useSizeClass(): SizeClassState {
  return useSyncExternalStore(subscribe, () => state, () => INITIAL);
}
