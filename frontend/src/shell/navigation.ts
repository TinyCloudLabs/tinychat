// Navigation memory, in memory only (TC-761). Each tab reopens where it was
// left (Capture → Library stays on Library across a visit to Chat), and
// tapping the current tab again returns to its root and scrolls to the top.
//
// The app also notes which address sits at each history index as it goes, so
// a pushed screen's Back can tell whether stepping back in history lands on its
// parent (then it does, keeping the parent's scroll) or would leave somewhere
// else (then it replaces the address with the parent's).

import type { NavigateFunction } from "react-router-dom";

import { DESTINATION_ROOTS, screenFor, type Destination } from "./routes";

const lastPath = new Map<Destination, string>();
const entries = new Map<number, string>();

/** react-router's history index (`history.state.idx`); 0 without one. */
export function historyIndex(): number {
  const idx = (globalThis.history?.state as { idx?: unknown } | null)?.idx;
  return typeof idx === "number" ? idx : 0;
}

/** AppShell reports every location it shows. */
export function noteLocation(pathname: string, idx: number = historyIndex()): void {
  entries.set(idx, pathname);
  const destination = screenFor(pathname).destination;
  if (destination) lastPath.set(destination, pathname);
}

/** Where a navigation item leads: its root when it is current (tap again to pop), else where it was left. */
export function tabTarget(destination: Destination, current: boolean): string {
  return current ? DESTINATION_ROOTS[destination] : (lastPath.get(destination) ?? DESTINATION_ROOTS[destination]);
}

/** A pushed screen's Back: through history when the entry before is its parent, else straight up to it. */
export function goUp(navigate: NavigateFunction, parent: string): void {
  const idx = historyIndex();
  if (idx > 0 && entries.get(idx - 1) === parent) navigate(-1);
  else navigate(parent, { replace: true });
}

/** Scrolls the visible scroller of a destination's surface back to the top (the current tab tapped again). */
export function scrollSurfaceToTop(destination: Destination, doc: Document = document): void {
  const scrollers = doc.querySelectorAll<HTMLElement>(`[data-surface="${destination}"] [data-scroll-root]`);
  const reduce = doc.defaultView?.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? true;
  for (const scroller of scrollers) {
    // A hidden pane (display: none) has no box.
    if (scroller.getClientRects().length > 0) scroller.scrollTo({ top: 0, behavior: reduce ? "auto" : "smooth" });
  }
}

/** Forgets every remembered place: on sign-in and sign-out (App.tsx), and in tests. */
export function resetNavigationMemory(): void {
  lastPath.clear();
  entries.clear();
}
