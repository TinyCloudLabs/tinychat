import { useEffect, useRef, type KeyboardEvent, type ReactNode } from "react";

export interface SheetDialogProps {
  role: "alertdialog" | "dialog";
  title: string;
  description: ReactNode;
  /** What Escape and a tap on the veil do. */
  onCancel: () => void;
  children: ReactNode;
  titleId: string;
  descriptionId: string;
}

/** A bottom sheet over the recorder: traps Tab, Escape cancels, and the first `[data-initial]` control is focused. */
export function SheetDialog({ role, title, description, onCancel, children, titleId, descriptionId }: SheetDialogProps) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    root.current?.querySelector<HTMLElement>("[data-initial]")?.focus();
  }, []);
  const key = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      event.preventDefault();
      onCancel();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = [...root.current!.querySelectorAll<HTMLElement>("button, a[href]")];
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };
  return (
    <>
      <div className="pr-veil" aria-hidden="true" onClick={onCancel} />
      <div ref={root} className="pr-sheet" role={role} aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId} tabIndex={-1} onKeyDown={key}>
        <h2 id={titleId} className="soft-title">{title}</h2>
        <p id={descriptionId}>{description}</p>
        {children}
      </div>
    </>
  );
}
