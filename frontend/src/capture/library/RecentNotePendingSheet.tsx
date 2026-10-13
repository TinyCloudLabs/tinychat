import { useEffect, useRef, type KeyboardEvent } from "react";

/** Loading, failed and missing states while a Recent voice note resolves. */
export function RecentNotePendingSheet(props: {
  listing: boolean;
  failed: boolean;
  onRetry: () => void;
  onClose: () => void;
  suspended?: boolean;
}) {
  const sheet = useRef<HTMLElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const suspended = useRef(props.suspended ?? false);
  suspended.current = props.suspended ?? false;
  const wasActive = useRef(false);
  useEffect(() => {
    if (props.suspended) {
      wasActive.current = false;
      return;
    }
    if (wasActive.current) return;
    wasActive.current = true;
    previousFocus.current ??= document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const target = props.failed ? "[data-recent-retry]" : "[data-recent-close]";
    (sheet.current?.querySelector<HTMLElement>(target) ?? sheet.current)?.focus();
  }, [props.suspended]);
  useEffect(() => () => {
      if (suspended.current) return;
      if (previousFocus.current?.isConnected) previousFocus.current.focus();
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      props.onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = [...(sheet.current?.querySelectorAll<HTMLElement>("button, a[href]") ?? [])];
    if (focusable.length === 0) return;
    const at = focusable.indexOf(document.activeElement as HTMLElement);
    const next = event.shiftKey ? (at <= 0 ? focusable.length - 1 : at - 1) : (at < 0 || at === focusable.length - 1 ? 0 : at + 1);
    event.preventDefault();
    focusable[next]?.focus();
  };

  if (props.suspended) return null;

  return (
    <div
      className="fixed inset-0 z-40 bg-black/40"
      data-testid="recent-note-backdrop"
      onClick={props.onClose}
    >
      <section
        ref={sheet}
        role="dialog"
        aria-modal="true"
        aria-labelledby="recent-note-title"
        aria-describedby="recent-note-description"
        data-overlay-open="true"
        data-testid="recent-note-sheet"
        tabIndex={-1}
        className="fixed inset-x-0 bottom-0 z-40 max-h-[85dvh] overflow-y-auto rounded-t-2xl bg-background p-6 pb-[max(1.5rem,env(safe-area-inset-bottom))] outline-none"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <h2 id="recent-note-title" className="text-lg font-semibold">Recent note</h2>
        <p id="recent-note-description" className="sr-only">
          {props.listing ? "Loading the note." : props.failed ? "The note could not be loaded." : "The note is not in your Library."}
        </p>
        {props.listing ? <p role="status" className="mt-4">Loading the note…</p>
          : props.failed ? <div className="mt-4"><p role="alert">Couldn’t load this note. Check your connection, then try again.</p><button data-recent-retry type="button" className="mt-3 underline" onClick={props.onRetry}>Try again</button></div>
            : <p role="status" className="mt-4">This note isn’t in your Library. It may have been removed from your space.</p>}
        <button data-recent-close type="button" className="mt-6 underline" onClick={props.onClose}>Close</button>
      </section>
    </div>
  );
}
