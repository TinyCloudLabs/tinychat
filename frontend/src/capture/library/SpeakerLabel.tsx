import { createContext, useContext, useRef, useState, type FormEvent } from "react";
import { PencilIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MAX_SPEAKER_NAME_LENGTH, speakerDisplayName } from "./speakerNames";
import { OTHER_SIDE_LABELS, OWN_SIDE_LABELS, SPEAKER_NAMES_COPY as COPY } from "./speakerNamesCopy";
import type { SpeakerNamesController } from "./useSpeakerNames";

/** The open note's speaker names; absent where a note's names can't be saved, and labels then stay plain text. */
export const SpeakerNamesContext = createContext<SpeakerNamesController | undefined>(undefined);

function placeholderFor(original: string): string {
  if (OWN_SIDE_LABELS.has(original)) return COPY.mePlaceholder;
  return OTHER_SIDE_LABELS.has(original) ? COPY.othersPlaceholder : COPY.otherPlaceholder;
}

const LABEL_CLASS = "text-meta font-semibold text-muted-foreground";

/** A speaker's label as stored; tapping it renames that speaker on every line of the note. */
export function SpeakerLabel(props: { original: string; className?: string }) {
  const speakers = useContext(SpeakerNamesContext);
  const [editing, setEditing] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  const className = props.className ?? LABEL_CLASS;
  if (speakers === undefined) return <p className={className}>{props.original}</p>;
  const shown = speakerDisplayName(speakers.names, props.original);
  const renamed = shown !== props.original;
  const open = () => setEditing(true);
  const save = (event: FormEvent) => { event.preventDefault(); speakers.rename(props.original, field.current?.value ?? ""); setEditing(false); };
  if (!editing) {
    return <p className={className}>
      <button type="button" data-testid="speaker-label" aria-label={COPY.rename(shown)} onClick={open}
        className="-mx-1 inline-flex min-h-11 items-center gap-1 rounded-sm px-1 text-left font-semibold underline-offset-2 hover:text-foreground hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring [@media(pointer:fine)]:min-h-0">
        {shown}<PencilIcon aria-hidden className="size-3 opacity-60" />
      </button>
    </p>;
  }
  return <form onSubmit={save} data-testid="speaker-rename-form" className="flex flex-wrap items-center gap-2 py-1"
    onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); setEditing(false); } }}>
    <input ref={field} type="text" autoFocus autoComplete="off" enterKeyHint="done"
      defaultValue={renamed ? shown : OWN_SIDE_LABELS.has(props.original) ? speakers.me ?? "" : ""} maxLength={MAX_SPEAKER_NAME_LENGTH}
      placeholder={placeholderFor(props.original)} aria-label={COPY.fieldLabel(props.original)}
      className="h-[var(--tc-control-height)] min-w-0 flex-1 rounded-md border bg-background px-3 text-body" />
    <Button type="submit" size="sm">{COPY.save}</Button>
    <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)}>{COPY.cancel}</Button>
    {renamed && <Button type="button" size="sm" variant="ghost"
      onClick={() => { speakers.rename(props.original, ""); setEditing(false); }}>{COPY.reset(props.original)}</Button>}
  </form>;
}

/** What the last rename did, with its Undo; and the one failure. */
export function SpeakerNamesStatus() {
  const speakers = useContext(SpeakerNamesContext);
  if (speakers === undefined) return null;
  if (speakers.failed) return <p role="alert" className="text-meta text-destructive" data-testid="speaker-rename-failed">{COPY.failed}</p>;
  const { change } = speakers;
  if (change === null) return null;
  const text = change.undone ? COPY.undone : change.to === change.original ? COPY.cleared(change.original) : COPY.renamed(change.from, change.to);
  return <div role="status" className="flex flex-wrap items-center gap-2 text-meta text-muted-foreground" data-testid="speaker-rename-status">
    <span>{text}</span>
    {speakers.undo && <Button type="button" size="sm" variant="outline" onClick={speakers.undo} data-testid="speaker-rename-undo">{COPY.undo}</Button>}
  </div>;
}
