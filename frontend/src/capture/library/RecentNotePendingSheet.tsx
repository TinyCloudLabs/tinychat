/** Loading, failed and missing states while a Recent voice note resolves. */
export function RecentNotePendingSheet(props: {
  listing: boolean;
  failed: boolean;
  onRetry: () => void;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-[60] bg-black/40" data-testid="recent-note-backdrop" onClick={props.onClose}>
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="recent-note-title"
        data-overlay-open="true"
        data-testid="recent-note-sheet"
        className="fixed inset-x-0 bottom-0 z-[61] max-h-[85dvh] overflow-y-auto rounded-t-2xl bg-background p-6 pb-[max(1.5rem,env(safe-area-inset-bottom))] outline-none"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            props.onClose();
          }
        }}
      >
        <h2 id="recent-note-title" className="text-lg font-semibold">Recent note</h2>
        {props.listing ? <p role="status" className="mt-4">Loading the note…</p>
          : props.failed ? <div className="mt-4"><p role="alert">Couldn’t load this note. Check your connection, then try again.</p><button type="button" className="mt-3 underline" onClick={props.onRetry}>Try again</button></div>
            : <p role="status" className="mt-4">This note isn’t in your Library. It may have been removed from your space.</p>}
        <button type="button" className="mt-6 underline" onClick={props.onClose}>Close</button>
      </section>
    </div>
  );
}
