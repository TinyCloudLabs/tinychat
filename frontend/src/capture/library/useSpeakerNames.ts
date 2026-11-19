import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { captureEvents } from "../captureEvents";
import { readCallParticipants, speakerChoices } from "./callParticipants";
import { NO_SPEAKER_NAMES, NO_SUGGESTED_SPEAKER_NAMES, readSpeakerNames, readSuggestedSpeakerNames, speakerDisplayName, suggestedSpeakers,
  withoutSuggestedSpeakerName, withSpeakerName, type SpeakerNames, type SuggestedSpeakerNames } from "./speakerNames";
import { patchRowSpeakerName } from "@/lib/voiceNotes/voiceNoteRows";
import { readLedgerSpeakerNames, saveLedgerSpeakerNames } from "@/lib/voiceNotes/ledgerSpeakerNames";
import { VOICE_NOTE_SOURCE } from "@/lib/voiceNotes/voiceNoteStore";

export interface SpeakerNameChange {
  original: string;
  /** What the label showed before, and after. */
  from: string;
  to: string;
  undone: boolean;
}

export interface SpeakerNamesController {
  names: SpeakerNames;
  /** Labels whose name the app suggested and the user has not confirmed or changed. */
  suggested: ReadonlySet<string>;
  /** Names to offer when renaming `original`: the people seen in the call window, when the row has them. */
  choices: (original: string) => readonly string[];
  /** Renames `original`; saving a suggested label's name unchanged confirms the suggestion. */
  rename: (original: string, shown: string) => void;
  /** Puts the last rename back; null when there is nothing to undo. */
  undo: (() => void) | null;
  change: SpeakerNameChange | null;
  failed: boolean;
}

/** One queued name change: `original` will be shown as `to` once the write lands. */
interface Intent {
  id: number;
  original: string;
  to: string;
}

/** What the labels show: each label's name, and the names that are still only suggestions. */
interface Shown {
  names: SpeakerNames;
  suggestions: SuggestedSpeakerNames;
}

const NOTHING_SHOWN: Shown = { names: NO_SPEAKER_NAMES, suggestions: NO_SUGGESTED_SPEAKER_NAMES };

const readShown = (metadata: unknown): Shown =>
  ({ names: readSpeakerNames(metadata), suggestions: readSuggestedSpeakerNames(metadata) });

// Every name written for a label ends its suggestion, as patchRowSpeakerName does in storage.
const applyIntent = (shown: Shown, intent: Intent): Shown => ({
  names: withSpeakerName(shown.names, intent.original, intent.to),
  suggestions: withoutSuggestedSpeakerName(shown.suggestions, intent.original),
});

/**
 * The open note's speaker names. On a space row they live in its metadata; a note still on this
 * phone keeps them in its capture ledger (`localId`) and the row takes them when the note lands.
 * Shown at once when changed and saved one write at a time; a failed save puts the names back as
 * they were. Undefined while the note's place for them is unknown or not this account's to write.
 */
export function useSpeakerNames(options: {
  tcw: TinyCloudWeb;
  /** The note's row id and source; null when it has no row (a note only on this phone). */
  row: { id: string; source: string; sourceId: string } | null;
  metadata: unknown;
  /** The recording id of a note still on this phone; its ledger carries the names until it lands. */
  localId?: string | null;
}): SpeakerNamesController | undefined {
  const { tcw, row, metadata, localId = null } = options;
  const key = row?.id ?? localId;
  const [local, setLocal] = useState<{ key: string; shown: Shown } | null>(null);
  const [change, setChange] = useState<{ key: string; value: SpeakerNameChange } | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  // A phone note's permission is read with its ledger: null while checking, false when not this account's.
  const [writable, setWritable] = useState<boolean | null>(localId === null);
  const intents = useRef<Intent[]>([]);
  const nextIntent = useRef(0);
  /** The last map storage accepted; every write composes over it, never over a stale snapshot. */
  const landed = useRef<Shown>(NOTHING_SHOWN);
  const shownRef = useRef<Shown>(landed.current);
  const chain = useRef<Promise<void>>(Promise.resolve());

  const shown = local?.key === key ? local.shown
    : row !== null ? readShown(metadata) : landed.current;
  shownRef.current = shown;
  // With nothing in flight the row's own names are also the write base: a rename that runs before
  // the effects below still composes over what is stored, never over an empty map.
  if (intents.current.length === 0) landed.current = shown;

  // A fresh read of the row is the truth again once our own writes have landed.
  useEffect(() => {
    if (intents.current.length === 0 && row !== null) {
      landed.current = readShown(metadata);
      setLocal(null);
    }
  }, [metadata, row]);
  useEffect(() => {
    intents.current = [];
    landed.current = row !== null ? readShown(metadata) : landed.current;
    setLocal(null);
    setChange(null);
    setFailure(null);
    setWritable(localId === null);
  }, [key]); // Reset only when the note changes; the other inputs are read at that moment.

  // A phone note has no row: its names live in the capture ledger. Read them once and learn whether
  // this account may write (the ledger's owner must be the signed-in account).
  useEffect(() => {
    if (localId === null || row !== null) return;
    let active = true;
    void readLedgerSpeakerNames(tcw, localId).then((read) => {
      if (!active) return;
      if (read === "not-owned") { setWritable(false); return; }
      if (read === "unavailable") { setWritable(false); setFailure(localId); return; }
      setWritable(true);
      if (read.names !== null) {
        landed.current = intents.current.length === 0 ? { names: read.names, suggestions: NO_SUGGESTED_SPEAKER_NAMES } : landed.current;
        if (intents.current.length === 0) setLocal(null);
      }
    });
    return () => { active = false; };
  }, [tcw, localId, row]);

  const writeNames = useCallback(async (intent: Intent): Promise<Shown> => {
    if (row !== null) {
      const target = applyIntent(landed.current, intent);
      await patchRowSpeakerName(tcw, row.id, intent.original,
        Object.hasOwn(target.names, intent.original) ? target.names[intent.original]! : null);
      captureEvents.emit("library-changed", { source: row.source, sourceId: row.sourceId });
      return target;
    }
    if (localId === null) throw new Error("The note has no place for speaker names");
    // The ledger may move between our read and our write (another device, the
    // recorder): the rename applies to the map just read, never overwrites it.
    const names = await saveLedgerSpeakerNames(tcw, localId, (stored) => withSpeakerName(stored, intent.original, intent.to));
    captureEvents.emit("library-changed", { source: VOICE_NOTE_SOURCE, sourceId: localId });
    return { names, suggestions: NO_SUGGESTED_SPEAKER_NAMES };
  }, [tcw, row, localId]);

  const commit = useCallback((intent: Intent) => {
    if (key === null) return;
    intents.current.push(intent);
    setLocal({ key, shown: intents.current.reduce(applyIntent, landed.current) });
    setFailure(null);
    chain.current = chain.current.then(async () => {
      try {
        landed.current = await writeNames(intent);
        intents.current = intents.current.filter((queued) => queued.id !== intent.id);
      } catch {
        // Drop the failed change and replay what is still queued over what landed, so a queued
        // write computed on top of it cannot smuggle the failed name back in.
        intents.current = intents.current.filter((queued) => queued.id !== intent.id);
        setLocal({ key, shown: intents.current.reduce(applyIntent, landed.current) });
        setChange(null);
        setFailure(key);
      }
    });
  }, [key, writeNames]);

  const rename = useCallback((original: string, shown: string) => {
    if (key === null) return;
    const previous = shownRef.current;
    const next = withSpeakerName(previous.names, original, shown);
    const from = speakerDisplayName(previous.names, original);
    const to = speakerDisplayName(next, original);
    if (from === to) {
      // Saving a suggested name unchanged confirms it: the same name is written as the user's own, which
      // ends the suggestion. Nothing visible changes but the mark, so there is no status line or Undo.
      if (suggestedSpeakers(previous.names, previous.suggestions).has(original))
        commit({ id: nextIntent.current++, original, to: shown });
      return;
    }
    setChange({ key, value: { original, from, to, undone: false } });
    commit({ id: nextIntent.current++, original, to: shown });
  }, [key, commit]);

  const undo = useCallback(() => {
    if (change === null || change.key !== key || change.value.undone || key === null) return;
    const { original, from, to } = change.value;
    setChange({ key, value: { original, from: to, to: from, undone: true } });
    commit({ id: nextIntent.current++, original, to: from });
  }, [change, key, commit]);

  // Names in the call: the people the desktop app saw in the meeting window. Only a space row carries them.
  const participants = useMemo(() => (row !== null ? readCallParticipants(metadata) : null), [row, metadata]);
  const choices = useCallback((original: string) => speakerChoices(participants, original), [participants]);

  if (key === null || writable !== true) return undefined;
  const status = change?.key === key ? change : null;
  return { names: shown.names, suggested: suggestedSpeakers(shown.names, shown.suggestions), choices, rename,
    undo: status !== null && !status.value.undone ? undo : null, change: status?.value ?? null, failed: failure === key };
}
