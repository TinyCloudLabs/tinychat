import { readableError } from "@/lib/readableError";
import "./notes.css";
import { useEffect, useState } from "react";
import { NOTES_COPY } from "../notesCopy";
import { buttonizeMoments } from "./momentButtons";
import { gateNoteImages, type ImageChoices } from "./noteImages";
import { renderNoteHtml } from "./renderMarkdown";

type Rendered =
  | { state: "loading" }
  | { state: "ready"; html: string }
  | { state: "failed"; message: string };

/** The note as rendered Markdown, drawn once the lazy renderer has loaded. With `onMoment`, each moment's time is a button that calls it with the seconds. */
export function NoteRenderer({
  md,
  label,
  onMoment,
}: {
  md: string;
  label?: string;
  onMoment?: (seconds: number) => void;
}) {
  const [attempt, setAttempt] = useState(0);
  const [rendered, setRendered] = useState<Rendered>({ state: "loading" });
  const [choices, setChoices] = useState<ImageChoices>({});
  const empty = md.trim() === "";
  useEffect(() => {
    if (empty) return;
    let current = true;
    setRendered({ state: "loading" });
    setChoices({});
    renderNoteHtml(md).then(
      (html) => current && setRendered({ state: "ready", html }),
      (error: unknown) => {
        console.error("[Recorder] Could not render the note", error);
        if (current)
          setRendered({
            state: "failed",
            message: readableError(error),
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
  const gated = gateNoteImages(rendered.html, choices);
  return (
    <div
      className="fmd"
      aria-label={label}
      onClick={(event) => {
        const target = event.target as Element;
        const choose = (attribute: string, choice: "load" | "skip") => {
          const index = target.closest<HTMLElement>(`button[${attribute}]`)?.getAttribute(attribute);
          if (index != null) setChoices((current) => ({ ...current, [Number(index)]: choice }));
        };
        choose("data-img-load", "load");
        choose("data-img-skip", "skip");
        const button = onMoment && target.closest<HTMLElement>("button[data-at]");
        if (button) onMoment(Number(button.dataset.at));
      }}
      // The renderer escapes raw HTML in the note and drops javascript: links; images are checked by address first.
      dangerouslySetInnerHTML={{
        __html: onMoment ? buttonizeMoments(gated) : gated,
      }}
    />
  );
}
