// The open card on a wide screen with a mouse (Feed-match slice 5; see openMode.ts). The row lifts into a card at most
// 600 px wide, centred over the stream, which is dimmed behind it. The card scrolls inside itself. The X, a tap on the
// dimmed stream and Escape close it; focus goes to the X on open and Tab stays inside the card while it is open.
//
// The card is always mounted while its row is open, so an answer counting down in it still sends or undoes exactly as
// before: while `open` is false (the wait shows as a pill instead) it is only hidden, and its dim and trap go with it.
// The caller makes the stream `inert` while `open` is true, and keeps the pill outside that.
import { type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type Ref, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { XIcon } from "lucide-react";
import { m, useIsPresent, useReducedMotion } from "motion/react";

import { DESKTOP_CARD_CLOSE } from "./desktopCardStrings";

const FOCUSABLE = "a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),summary,[tabindex]:not([tabindex='-1'])";
/** What a layer opened from inside the card (a sheet, a menu) may take focus into, which the trap must leave alone. */
const OTHER_LAYER = "[role=dialog],[role=alertdialog],[role=menu],[role=listbox],[data-radix-popper-content-wrapper]";

/** The X: the card's header carries it where the in-place card carries its fold button. */
export function DesktopCardClose({ onClick, ref }: { onClick: () => void; ref?: Ref<HTMLButtonElement> }) {
  return <button ref={ref} type="button" data-desktop-close aria-label={DESKTOP_CARD_CLOSE} onClick={onClick}
    className="-my-1 flex size-11 items-center justify-center rounded-full text-muted-foreground hover:bg-surface-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring fine:my-0 fine:size-9">
    <XIcon aria-hidden className="size-4" />
  </button>;
}

/** A card's row in the stream, by its `data-card-key`. */
export function rowElement(key: string): HTMLElement | undefined {
  return [...document.querySelectorAll<HTMLElement>("[data-card-key]")].find((row) => row.dataset.cardKey === key);
}

export function DesktopCard({ label, rowKey, open, onClose, id, children }: {
  /** The card's title, as the dialog's name. */
  label: string;
  /** The card's row (its `data-card-key`): the card lifts from it and goes back to it. */
  rowKey: string;
  /** False while the card is out of sight but mounted (its answer is counting down). */
  open: boolean;
  onClose: () => void;
  /** The element id the row's "See N options" control points at. */
  id: string;
  children: ReactNode;
}) {
  const reduce = useReducedMotion();
  const present = useIsPresent();
  const shell = useRef<HTMLDivElement>(null);
  const active = open && present;
  // Where the card lifts from: the row's centre, as an offset from the screen's centre, where the card rests.
  const [from] = useState(() => {
    const row = rowElement(rowKey)?.getBoundingClientRect();
    return row ? { x: row.left + row.width / 2 - window.innerWidth / 2, y: row.top + row.height / 2 - window.innerHeight / 2 } : { x: 0, y: 0 };
  });

  useEffect(() => {
    if (!active) return;
    shell.current?.querySelector<HTMLElement>("[data-desktop-close]")?.focus();
  }, [active]);

  useEffect(() => {
    if (!active) return;
    const escape = (event: KeyboardEvent) => {
      // A layer inside the card (a sheet, a menu) takes its own Escape first.
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      onClose();
    };
    // Focus that lands outside the card (and outside a layer opened from it) comes back to the card.
    const keep = (event: FocusEvent) => {
      const target = event.target as Element | null;
      if (!target || shell.current?.contains(target) || target.closest?.(OTHER_LAYER)) return;
      shell.current?.querySelector<HTMLElement>("[data-desktop-close]")?.focus();
    };
    document.addEventListener("keydown", escape);
    document.addEventListener("focusin", keep);
    return () => { document.removeEventListener("keydown", escape); document.removeEventListener("focusin", keep); };
  }, [active, onClose]);

  function trap(event: ReactKeyboardEvent) {
    if (event.key !== "Tab" || !shell.current) return;
    const stops = [...shell.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((stop) => !stop.closest("[inert],[hidden]"));
    if (!stops.length) return;
    const first = stops[0]!, last = stops[stops.length - 1]!;
    if (event.shiftKey && (document.activeElement === first || !shell.current.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && (document.activeElement === last || !shell.current.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
  }

  return createPortal(
    // The dim covers the whole screen; a press on it (not on the card) closes. Hidden while the answer counts.
    <m.div data-desktop-card-dim initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: reduce ? 0.12 : 0.2 }}
      onPointerDown={(event) => { if (active && event.target === event.currentTarget) onClose(); }}
      className={`fixed inset-0 z-40 items-center justify-center bg-black/40 p-6 ${open ? "flex" : "hidden"} ${active ? "" : "pointer-events-none"}`}>
      <m.div ref={shell} role="dialog" aria-modal="true" aria-label={label} id={id} inert={!active} onKeyDown={trap}
        {...(reduce
          ? { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 }, transition: { duration: 0.12 } }
          : { initial: { opacity: 0, scale: 0.92, ...from }, animate: { opacity: 1, scale: 1, x: 0, y: 0 }, exit: { opacity: 0, scale: 0.92, ...from }, transition: { duration: 0.35, ease: [0.2, 0, 0, 1] } })}
        className="max-h-full w-full max-w-[600px] overflow-y-auto overscroll-contain rounded-2xl border border-border bg-card text-card-foreground shadow-float">
        {children}
      </m.div>
    </m.div>,
    document.body,
  );
}
