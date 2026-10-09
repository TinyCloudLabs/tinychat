import { markKeyboardOpened } from "./inputModality";
import {
  useEffect,
  useRef,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";

export interface SheetDialogProps {
  role: "alertdialog" | "dialog";
  title: string;
  description: ReactNode;
  /** What Escape and a tap on the veil do. */
  onCancel: () => void;
  children: ReactNode;
  titleId: string;
  descriptionId: string;
  /** The control that opened the sheet: focus goes back to it on every close. */
  returnFocus: RefObject<HTMLElement | null>;
  /** Where focus goes if that control is gone by then. */
  fallbackFocus?: RefObject<HTMLElement | null>;
}

/** A bottom sheet over the recorder: traps Tab, Escape cancels, the first `[data-initial]` control is focused, and focus returns to the opener on every close. */
export function SheetDialog({
  role,
  title,
  description,
  onCancel,
  children,
  titleId,
  descriptionId,
  returnFocus,
  fallbackFocus,
}: SheetDialogProps) {
  const root = useRef<HTMLDivElement>(null);
  // The latest refs at close, whatever the render that opened the sheet saw.
  const back = useRef({ returnFocus, fallbackFocus });
  back.current = { returnFocus, fallbackFocus };
  useEffect(() => {
    markKeyboardOpened(root.current);
    root.current?.querySelector<HTMLElement>("[data-initial]")?.focus();
    return () => {
      const { returnFocus: opener, fallbackFocus: fallback } = back.current;
      (opener.current?.isConnected
        ? opener.current
        : fallback?.current
      )?.focus();
    };
  }, []);
  const key = (event: KeyboardEvent) => {
    event.currentTarget.setAttribute("data-kbd", "");
    if (event.key === "Escape") {
      event.stopPropagation();
      event.preventDefault();
      onCancel();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = [
      ...root.current!.querySelectorAll<HTMLElement>("button, a[href]"),
    ];
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
  };
  return (
    <>
      <div className="pr-veil" aria-hidden="true" onClick={onCancel} />
      <div
        ref={root}
        className="pr-sheet"
        role={role}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        tabIndex={-1}
        onKeyDown={key}
      >
        <h2 id={titleId} className="soft-title">
          {title}
        </h2>
        <p id={descriptionId}>{description}</p>
        {children}
      </div>
    </>
  );
}
