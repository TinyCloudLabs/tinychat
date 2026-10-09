import type { KeyboardEvent } from "react";

const FOCUSABLE =
  'button:not(:disabled), a[href], textarea:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])';

/** Keeps Tab and Shift+Tab inside `root`. */
export function trapTab(event: KeyboardEvent, root: HTMLElement): void {
  if (event.key !== "Tab") return;
  const focusable = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (element) => !element.hidden && !element.closest("[hidden]"),
  );
  if (!focusable.length) return;
  event.preventDefault();
  const at = focusable.indexOf(document.activeElement as HTMLElement);
  const step = event.shiftKey ? -1 : 1;
  focusable[
    at < 0
      ? step > 0
        ? 0
        : focusable.length - 1
      : (at + step + focusable.length) % focusable.length
  ]!.focus();
}
