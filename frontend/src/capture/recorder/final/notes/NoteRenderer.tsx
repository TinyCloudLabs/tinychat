import "./notes.css";
import { useEffect, useState } from "react";
import { NOTES_COPY } from "../notesCopy";
import { renderNoteHtml } from "./renderMarkdown";

type Rendered =
  | { state: "loading" }
  | { state: "ready"; html: string }
  | { state: "failed"; message: string };

/** The note as rendered Markdown, drawn once the lazy renderer has loaded. */
export function NoteRenderer({ md, label }: { md: string; label?: string }) {
  const [attempt, setAttempt] = useState(0);
  const [rendered, setRendered] = useState<Rendered>({ state: "loading" });
  const empty = md.trim() === "";
  useEffect(() => {
    if (empty) return;
    let current = true;
    setRendered({ state: "loading" });
    renderNoteHtml(md).then(
      (html) => current && setRendered({ state: "ready", html }),
      (error: unknown) => {
        console.error("[Recorder] Could not render the note", error);
        if (current)
          setRendered({
            state: "failed",
            message: error instanceof Error ? error.message : String(error),
          });
      },
    );
    return () => {
      current = false;
    };
  }, [md, empty, attempt]);

  if (empty) return <p className="nt-fmd-empty">{NOTES_COPY.nothingWritten}</p>;
  if (rendered.state === "loading")
    return <p className="nt-fmd-loading">{NOTES_COPY.rendering}</p>;
  if (rendered.state === "failed")
    return (
      <p className="nt-alert" role="alert">
        {NOTES_COPY.previewFailed} {rendered.message}
        <button
          type="button"
          className="nt-retry"
          onClick={() => setAttempt((n) => n + 1)}
        >
          {NOTES_COPY.tryAgain}
        </button>
      </p>
    );
  return (
    <div
      className="fmd"
      aria-label={label}
      // The renderer escapes raw HTML in the note and drops javascript: links.
      dangerouslySetInnerHTML={{ __html: rendered.html }}
    />
  );
}
