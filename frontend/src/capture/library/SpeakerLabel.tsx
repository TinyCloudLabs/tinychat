import { createContext, useContext, useId, useRef, useState, type FormEvent } from "react";
import { PencilIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { listsSpeakerName, withSpeakerChoice } from "./callParticipants";
import { MAX_SPEAKER_NAME_LENGTH, speakerDisplayName } from "./speakerNames";
import { isCallPersonLabel, OTHER_SIDE_LABELS, OWN_SIDE_LABELS, SPEAKER_NAMES_COPY as COPY } from "./speakerNamesCopy";
import type { NameSuggestionsController } from "./useNameSuggestions";
import type { SpeakerNamesController } from "./useSpeakerNames";

/** The open note's speaker names; absent where a note's names can't be saved, and labels then stay plain text. */
export const SpeakerNamesContext = createContext<SpeakerNamesController | undefined>(undefined);
/** The open note's suggested names; absent where there are none to show (another kind of note, or suggestions off). */
export const NameSuggestionsContext = createContext<NameSuggestionsController | undefined>(undefined);

function placeholderFor(original: string): string {
  if (OWN_SIDE_LABELS.has(original)) return COPY.mePlaceholder;
  // "Them 1" is one person of the other side, so it asks for one name.
  return OTHER_SIDE_LABELS.has(original) && !isCallPersonLabel(original) ? COPY.othersPlaceholder : COPY.otherPlaceholder;
}

const LABEL_CLASS = "text-meta font-semibold text-muted-foreground";
/** The most names from the call offered as buttons; any other is typed. */
const MAX_CHOICES = 12;

/**
 * A speaker's label as stored; tapping it renames that speaker on every line of the note. A speaker's first label in
 * the transcript (`firstOfSpeaker`, decided where the turns are laid out) also shows a suggested name, when there is
 * one: as a question with Use and Dismiss, and the question opens the words of the transcript it rests on. The
 * later labels stay plain: a call has a hundred turns. Nothing is renamed until Use, which is a rename like a
 * typed one; the rename field of every label starts with the suggested name.
 */
export function SpeakerLabel(props: { original: string; firstOfSpeaker?: boolean; className?: string }) {
  const speakers = useContext(SpeakerNamesContext);
  const suggestions = useContext(NameSuggestionsContext);
  const [editing, setEditing] = useState(false);
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const evidenceId = useId();
  const field = useRef<HTMLInputElement>(null);
  const className = props.className ?? LABEL_CLASS;
  if (speakers === undefined) return <p className={className}>{props.original}</p>;
  const shown = speakerDisplayName(speakers.names, props.original);
  const renamed = shown !== props.original;
  const suggestion = !renamed && suggestions !== undefined && Object.hasOwn(suggestions.names, props.original)
    ? suggestions.names[props.original] : undefined;
  const open = () => setEditing(true);
  const save = (event: FormEvent) => { event.preventDefault(); speakers.rename(props.original, field.current?.value ?? ""); setEditing(false); };
  if (!editing) {
    const label = <button type="button" data-testid="speaker-label" aria-label={COPY.rename(shown)} onClick={open}
      className="-mx-1 inline-flex min-h-11 items-center gap-1 rounded-sm px-1 text-left font-semibold underline-offset-2 hover:text-foreground hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring [@media(pointer:fine)]:min-h-0">
      {shown}<PencilIcon aria-hidden className="size-3 opacity-60" />
    </button>;
    if (!props.firstOfSpeaker || suggestion === undefined || suggestions === undefined) {
      // A name the app suggested is marked until it is kept (Save unchanged) or changed. Such a name is in the
      // note's names, so its label never also asks about a name a model suggested.
      const suggested = speakers.suggested.has(props.original);
      return <p className={suggested ? `${className} flex flex-wrap items-center gap-x-2` : className}>
        {label}
        {suggested && <span data-testid="speaker-suggested"
          className="shrink-0 rounded-full border border-border bg-background px-2 py-0.5 text-xs font-normal text-muted-foreground">{COPY.suggested}</span>}
      </p>;
    }
    return <div className={className} data-testid="speaker-suggestion">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {label}
        <button type="button" data-testid="speaker-suggestion-name" aria-expanded={evidenceOpen} aria-controls={evidenceOpen ? evidenceId : undefined}
          onClick={() => setEvidenceOpen((opened) => !opened)}
          className="inline-flex min-h-11 items-center rounded-sm px-1 text-left font-semibold text-foreground underline decoration-dotted underline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring [@media(pointer:fine)]:min-h-0">
          <span className="sr-only">{COPY.suggestedName} </span>{COPY.suggestion(suggestion.name)}
        </button>
        {/* The two answers stay side by side when a narrow screen wraps the line. */}
        <span className="inline-flex items-center gap-x-1">
          <Button type="button" size="sm" variant="outline" data-testid="speaker-suggestion-use" aria-label={COPY.useFor(suggestion.name, props.original)}
            onClick={() => speakers.rename(props.original, suggestion.name)}>{COPY.use}</Button>
          <Button type="button" size="sm" variant="ghost" data-testid="speaker-suggestion-dismiss" aria-label={COPY.dismissFor(suggestion.name, props.original)}
            onClick={() => suggestions.dismiss(props.original)}>{COPY.dismiss}</Button>
        </span>
      </div>
      {evidenceOpen && <p id={evidenceId} data-testid="speaker-suggestion-evidence" className="break-words py-1 font-normal">
        {COPY.basis[suggestion.basis]}{suggestion.quote !== "" && <> {COPY.quote(suggestion.quote)}</>}
      </p>}
    </div>;
  }
  // The field starts with the name shown, else with a name a model suggested for this speaker.
  const initial = renamed ? shown : suggestion?.name ?? "";
  // Names in the call: each a button that puts the name in the field (Save still commits). A name the field
  // already held when it opened is not offered again.
  const choices = speakers.choices(props.original).filter((name) => !listsSpeakerName(initial, name)).slice(0, MAX_CHOICES);
  const choose = (name: string) => { if (field.current) field.current.value = withSpeakerChoice(field.current.value, name); };
  return <form onSubmit={save} data-testid="speaker-rename-form" className="flex flex-wrap items-center gap-2 py-1"
    onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); setEditing(false); } }}>
    {/* At least 8rem wide: with a long "Go back to" button the buttons wrap below rather than squeeze the field. */}
    <input ref={field} type="text" autoFocus autoComplete="off" enterKeyHint="done" defaultValue={initial} maxLength={MAX_SPEAKER_NAME_LENGTH}
      placeholder={placeholderFor(props.original)} aria-label={COPY.fieldLabel(props.original)}
      className="h-[var(--tc-control-height)] min-w-32 flex-1 rounded-md border bg-background px-3 text-body" />
    <Button type="submit" size="sm">{COPY.save}</Button>
    <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)}>{COPY.cancel}</Button>
    {renamed && <Button type="button" size="sm" variant="ghost"
      onClick={() => { speakers.rename(props.original, ""); setEditing(false); }}>{COPY.reset(props.original)}</Button>}
    {choices.length > 0 && <div role="group" aria-label={COPY.choices} data-testid="speaker-choices" className="flex basis-full flex-wrap gap-2">
      {choices.map((name) => <Button key={name} type="button" size="sm" variant="outline" onClick={() => choose(name)}
        className="h-auto min-h-[var(--tc-control-height-sm)] max-w-full whitespace-normal break-words py-1 text-left">{name}</Button>)}
    </div>}
  </form>;
}

/** What the last rename did, with its Undo; the one failure; and, with two or more suggested names, taking them all. */
export function SpeakerNamesStatus() {
  const speakers = useContext(SpeakerNamesContext);
  const suggestions = useContext(NameSuggestionsContext);
  if (speakers === undefined) return null;
  const offered = Object.entries(suggestions?.names ?? {});
  const useAll = offered.length >= 2 && <div className="flex flex-wrap items-center gap-2 text-meta text-muted-foreground" data-testid="speaker-suggestions-all">
    <span>{COPY.suggestionsFound(offered.length)}</span>
    <Button type="button" size="sm" variant="outline" data-testid="speaker-suggestions-use-all"
      onClick={() => { for (const [label, suggestion] of offered) speakers.rename(label, suggestion.name); }}>{COPY.useAll}</Button>
  </div>;
  if (speakers.failed) return <>{useAll}<p role="alert" className="text-meta text-destructive" data-testid="speaker-rename-failed">{COPY.failed}</p></>;
  const { change } = speakers;
  if (change === null) return useAll || null;
  const text = change.undone ? COPY.undone : change.to === change.original ? COPY.cleared(change.original) : COPY.renamed(change.from, change.to);
  return <>
    {useAll}
    <div role="status" className="flex flex-wrap items-center gap-2 text-meta text-muted-foreground" data-testid="speaker-rename-status">
      <span>{text}</span>
      {speakers.undo && <Button type="button" size="sm" variant="outline" onClick={speakers.undo} data-testid="speaker-rename-undo">{COPY.undo}</Button>}
    </div>
  </>;
}
