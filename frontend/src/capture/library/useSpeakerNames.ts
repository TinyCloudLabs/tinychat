import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { captureEvents } from "../captureEvents";
import { NO_CALL_SPEAKER_LABELS, readCallParticipants, speakerChoices, suggestCallSpeakerNames, suggestSpeakerNames, type CallParticipants,
  type CallSpeakerLabels } from "./callParticipants";
import { NO_SPEAKER_NAMES, NO_SUGGESTED_SPEAKER_NAMES, readSpeakerNames, readSuggestedSpeakerNames, speakerDisplayName, suggestedSpeakers,
  withoutSuggestedSpeakerName, withSpeakerName, type SpeakerNames, type SuggestedSpeakerNames } from "./speakerNames";
import { readCallNamesOnThisMac, saveCallNames, saveCallSpeakerNames } from "@/lib/voiceNotes/callNames";
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
  /** Names to offer when renaming `original`: the people seen in the call window, from the row or this Mac. */
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

/** A note's names in its capture ledger: the user's own, and the labels whose call suggestion they ended. */
interface LedgerNames {
  key: string | null;
  names: SpeakerNames;
  ended: readonly string[];
}

const NO_LEDGER_NAMES: LedgerNames = { key: null, names: NO_SPEAKER_NAMES, ended: [] };

/**
 * The call's suggestions for a note whose row does not hold the names yet (it is only on this Mac, or the space
 * cannot be reached): the 1:1 suggestion for "Them", and who spoke when's for each "Them N" label of the transcript
 * (`speakers`). `at` is not shown, so it is left empty.
 */
const callSuggestions = (participants: CallParticipants | null, speakers: CallSpeakerLabels) =>
  ({ ...suggestSpeakerNames(participants, ""), ...suggestCallSpeakerNames(participants, speakers, "") });

/**
 * What such a note shows: the names given on this device, and the call's suggestion for a label that has no name and
 * whose suggestion the user has not ended. The rule writeCallParticipants applies when the names reach the row.
 */
function withCallSuggestions(names: SpeakerNames, ended: readonly string[], participants: CallParticipants | null,
  speakers: CallSpeakerLabels): Shown {
  let shown = names;
  const suggestions: Record<string, string> = {};
  for (const [original, suggestion] of Object.entries(callSuggestions(participants, speakers))) {
    if (ended.includes(original) || Object.hasOwn(names, original)) continue;
    shown = withSpeakerName(shown, original, suggestion.name);
    suggestions[original] = suggestion.name;
  }
  return Object.keys(suggestions).length === 0 ? { names: shown, suggestions: NO_SUGGESTED_SPEAKER_NAMES }
    : { names: shown, suggestions: Object.freeze(suggestions) };
}

/**
 * The open note's speaker names. On a space row they live in its metadata; a note still on this
 * phone keeps them in its capture ledger (`localId`) and the row takes them when the note lands.
 * Shown at once when changed and saved one write at a time; a failed save puts the names back as
 * they were. Undefined while the note's place for them is unknown or not this account's to write.
 *
 * Names in the call: a note whose row does not hold them yet (only on this Mac, or its row cannot be read) takes
 * them from the desktop app's copy, with the same suggestion and choices a row would give. A local rename of a
 * suggested label ends that suggestion in the ledger, so the row never gets it.
 */
export function useSpeakerNames(options: {
  tcw: TinyCloudWeb;
  /** The note's row id and source; null when it has no row (a note only on this phone). */
  row: { id: string; source: string; sourceId: string } | null;
  metadata: unknown;
  /** The recording id of a note still on this phone; its ledger carries the names until it lands. */
  localId?: string | null;
  /** The note's row when its metadata cannot be read (the space is unreachable): the call's names come from this Mac. */
  unreadRow?: { id: string; source: string; sourceId: string } | null;
  /** Who spoke when: the transcript's "Them N" labels and the person id each carries (`callSpeakerLabels`). */
  callSpeakers?: CallSpeakerLabels;
}): SpeakerNamesController | undefined {
  const { tcw, row, metadata, localId = null, unreadRow = null, callSpeakers = NO_CALL_SPEAKER_LABELS } = options;
  const key = row?.id ?? localId ?? unreadRow?.id ?? null;
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
  const ledger = useRef<LedgerNames>(NO_LEDGER_NAMES);
  // The names the desktop app still holds for a note whose row does not have them (read once per note).
  const nativeSource = row === null ? (localId ?? unreadRow?.sourceId ?? null) : null;
  const [native, setNative] = useState<{ source: string; participants: CallParticipants } | null>(null);
  const participantsHere = native !== null && native.source === nativeSource ? native.participants : null;
  const nativeRef = useRef(participantsHere);
  nativeRef.current = participantsHere;
  const speakersRef = useRef(callSpeakers);
  speakersRef.current = callSpeakers;

  const shown = local?.key === key ? local.shown
    : row !== null ? readShown(metadata)
    : withCallSuggestions(ledger.current.key === key ? ledger.current.names : NO_SPEAKER_NAMES,
      ledger.current.key === key ? ledger.current.ended : [], participantsHere, callSpeakers);
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
      if (intents.current.length === 0) {
        ledger.current = { key: localId, names: read.names ?? NO_SPEAKER_NAMES, ended: read.ended };
        setLocal(null);
      }
    });
    return () => { active = false; };
  }, [tcw, localId, row]);

  // Names in the call, from this Mac. A read that fails, finds nothing or never answers leaves the page as it is.
  useEffect(() => {
    if (nativeSource === null) return;
    let active = true;
    void readCallNamesOnThisMac(nativeSource).then((participants) => {
      if (!active || participants === null) return;
      setNative({ source: nativeSource, participants });
      if (intents.current.length === 0) setLocal(null);
    });
    return () => { active = false; };
  }, [nativeSource]);

  const writeNames = useCallback(async (intent: Intent): Promise<Shown> => {
    if (row !== null) {
      const target = applyIntent(landed.current, intent);
      await patchRowSpeakerName(tcw, row.id, intent.original,
        Object.hasOwn(target.names, intent.original) ? target.names[intent.original]! : null);
      captureEvents.emit("library-changed", { source: row.source, sourceId: row.sourceId });
      return target;
    }
    if (localId === null && unreadRow !== null) {
      // The row exists but could not be read, and the call's names are not on it yet: they land first (the save's
      // own write, once), so the rename then applies as on a row that had them, and no suggestion comes after it.
      if (await saveCallNames(tcw, unreadRow.sourceId, unreadRow.id) === "failed")
        throw new Error("The names in the call are not on the note's row yet");
      // A "Them N" label's own suggestion lands first too, so a rename or a reset is not followed by it.
      const person = Object.hasOwn(speakersRef.current, intent.original) ? speakersRef.current[intent.original] : undefined;
      if (person !== undefined && await saveCallSpeakerNames(tcw, unreadRow.sourceId, unreadRow.id, { [intent.original]: person }) === "failed")
        throw new Error("The suggested name is not on the note's row yet");
      const target = applyIntent(landed.current, intent);
      await patchRowSpeakerName(tcw, unreadRow.id, intent.original,
        Object.hasOwn(target.names, intent.original) ? target.names[intent.original]! : null);
      captureEvents.emit("library-changed", { source: unreadRow.source, sourceId: unreadRow.sourceId });
      return target;
    }
    if (localId === null) throw new Error("The note has no place for speaker names");
    // The ledger may move between our read and our write (another device, the
    // recorder): the rename applies to the map just read, never overwrites it.
    // A label the call suggested a name for: any name written for it ends the suggestion, as on a row.
    const end = Object.hasOwn(callSuggestions(nativeRef.current, speakersRef.current), intent.original) ? intent.original : undefined;
    const names = await saveLedgerSpeakerNames(tcw, localId, (stored) => withSpeakerName(stored, intent.original, intent.to), end);
    const before = ledger.current.key === localId ? ledger.current.ended : [];
    ledger.current = { key: localId, names, ended: end === undefined || before.includes(end) ? before : [...before, end] };
    captureEvents.emit("library-changed", { source: VOICE_NOTE_SOURCE, sourceId: localId });
    return withCallSuggestions(ledger.current.names, ledger.current.ended, nativeRef.current, speakersRef.current);
  }, [tcw, row, localId, unreadRow]);

  const commit = useCallback((intent: Intent) => {
    if (key === null) return;
    intents.current.push(intent);
    setLocal({ key, shown: intents.current.reduce(applyIntent, landed.current) });
    setFailure(null);
    chain.current = chain.current.then(async () => {
      try {
        landed.current = await writeNames(intent);
        intents.current = intents.current.filter((queued) => queued.id !== intent.id);
        // Off the space, with nothing left in flight, what landed is what shows: the call's names may have come
        // from this Mac meanwhile. A row's next read does this for a row.
        if (row === null && intents.current.length === 0) setLocal({ key, shown: landed.current });
      } catch {
        // Drop the failed change and replay what is still queued over what landed, so a queued
        // write computed on top of it cannot smuggle the failed name back in.
        intents.current = intents.current.filter((queued) => queued.id !== intent.id);
        setLocal({ key, shown: intents.current.reduce(applyIntent, landed.current) });
        setChange(null);
        setFailure(key);
      }
    });
  }, [key, row, writeNames]);

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

  // Names in the call: the people the desktop app saw in the meeting window, from the row or, before they reach
  // it, from this Mac.
  const participants = useMemo(() => (row !== null ? readCallParticipants(metadata) : participantsHere),
    [row, metadata, participantsHere]);
  const choices = useCallback((original: string) => speakerChoices(participants, original), [participants]);

  if (key === null || writable !== true) return undefined;
  // A row that cannot be read has no names to show but the call's, and nowhere to save without the space.
  if (row === null && localId === null && participantsHere === null) return undefined;
  const status = change?.key === key ? change : null;
  return { names: shown.names, suggested: suggestedSpeakers(shown.names, shown.suggestions), choices, rename,
    undo: status !== null && !status.value.undone ? undo : null, change: status?.value ?? null, failed: failure === key };
}
