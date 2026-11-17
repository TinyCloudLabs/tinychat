import { readableError } from "@/lib/readableError";
import "./notes.css";
import { useEffect, useRef, useState } from "react";
import { NOTES_COPY } from "../notesCopy";
import { buttonizeMoments } from "./momentButtons";
import { blockedImageHosts, renderNoteHtml, showAllowedImages } from "./renderMarkdown";

type Rendered =
  | { state: "loading" }
  | { state: "ready"; html: string }
  | { state: "failed"; message: string };

/** The sites the owner allowed images from, per note, for as long as the app stays open. Nothing is stored. */
const allowedByNote = new Map<string, Set<string>>();

/**
 * The note as rendered Markdown, drawn once the lazy renderer has loaded. With `onMoment`, each moment's time is a button
 * that calls it with the seconds. Every note is treated as untrusted: its images are not loaded until the owner taps
 * Allow on "Load images from <host>?", one site at a time; with a `noteId` that choice is remembered for the note.
 */
export function NoteRenderer({
  md,
  label,
  onMoment,
  noteId,
}: {
  md: string;
  label?: string;
  onMoment?: (seconds: number) => void;
  noteId?: string;
}) {
  const [, rerender] = useState(0);
  const unsaved = useRef(new Set<string>());
  const allowed = noteId ? (allowedByNote.get(noteId) ?? unsaved.current) : unsaved.current;
  function allow(host: string) {
    let sites = allowed;
    if (noteId && !allowedByNote.has(noteId)) { sites = new Set(); allowedByNote.set(noteId, sites); }
    sites.add(host);
    rerender((n) => n + 1);
  }
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
  const blocked = blockedImageHosts(rendered.html, allowed);
  const html = showAllowedImages(rendered.html, allowed);
  return (
    <>
      {blocked.map((host) => (
        <p key={host} className="nt-fmd-images" role="group" aria-label={`Load images from ${host}?`}>
          <span>Load images from {host}? It will see that you opened this note.</span>
          <button type="button" className="nt-retry" onClick={() => allow(host)}>
            Allow
          </button>
        </p>
      ))}
      <div
        className="fmd"
        aria-label={label}
        onClick={
          onMoment &&
          ((event) => {
            const button = (event.target as Element).closest<HTMLElement>(
              "button[data-at]",
            );
            if (button) onMoment(Number(button.dataset.at));
          })
        }
        // The renderer escapes raw HTML in the note and drops javascript: links; images stay placeholders until allowed.
        dangerouslySetInnerHTML={{
          __html: onMoment ? buttonizeMoments(html) : html,
        }}
      />
    </>
  );
}
