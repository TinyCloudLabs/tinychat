// The signed-in user's word fixes (TC-2199): read from the space's settings table, shared by every transcript surface
// and the Settings list. Writes run on the space write lane, one at a time, and a failed write puts the list back.
import { useMemo, useSyncExternalStore } from "react";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { getSetting } from "../threadStore";
import { writeUserSetting } from "../voiceNotes/voiceNoteRows";
import {
  applyWordFixesToSentences, compileWordFixes, NO_WORD_FIXES, parseWordFixes, serializeWordFixes, WORD_FIXES_SETTING_KEY,
  type WordFixApplier, type WordFixes,
} from "./wordFixes";

interface Snapshot { fixes: WordFixes; apply: WordFixApplier }

const listeners = new Set<() => void>();
let snapshot: Snapshot = { fixes: NO_WORD_FIXES, apply: compileWordFixes(NO_WORD_FIXES) };
let owner: TinyCloudWeb | null = null;
let chain: Promise<unknown> = Promise.resolve();
/** Saves not yet settled. */
let pending = 0;

function publish(fixes: WordFixes): void {
  snapshot = { fixes, apply: compileWordFixes(fixes) };
  for (const listener of listeners) listener();
}

/** Starts the list for `tcw`'s space: empty until its stored list is read. `null` (signed out) empties it. */
export async function loadWordFixes(tcw: TinyCloudWeb | null): Promise<void> {
  if (owner !== tcw) { owner = tcw; publish(NO_WORD_FIXES); }
  if (tcw === null) return;
  try {
    const stored = parseWordFixes(await getSetting(tcw, WORD_FIXES_SETTING_KEY));
    // A save made while this read was in flight is newer than what was read.
    if (owner === tcw && pending === 0 && serializeWordFixes(stored) !== serializeWordFixes(snapshot.fixes)) publish(stored);
  } catch {
    // The list stays as it was; the next load tries again.
  }
}

/** Shows `fixes` at once and saves them; a failed save puts the previous list back and rejects. */
export function saveWordFixes(tcw: TinyCloudWeb, fixes: WordFixes): Promise<void> {
  const previous = snapshot.fixes;
  if (owner !== tcw) owner = tcw;
  publish(fixes);
  pending += 1;
  const saved = chain.then(() => writeUserSetting(tcw, WORD_FIXES_SETTING_KEY, serializeWordFixes(fixes)));
  chain = saved.catch(() => undefined);
  return saved.then(() => undefined, (error: unknown) => {
    if (pending === 1 && snapshot.fixes === fixes) publish(previous);
    throw error;
  }).finally(() => { pending -= 1; });
}

const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const read = () => snapshot;

/** The current list, for the Settings list. */
export function useWordFixes(): WordFixes {
  return useSyncExternalStore(subscribe, read, read).fixes;
}

/** The current list compiled once, to apply to text. */
export function useWordFixApplier(): WordFixApplier {
  return useSyncExternalStore(subscribe, read, read).apply;
}

/** `sentences` with the user's word fixes shown; the same array while the list is empty. */
export function useWordFixedSentences<T extends { text: string }>(sentences: readonly T[]): readonly T[];
export function useWordFixedSentences<T extends { text: string }>(sentences: readonly T[] | null | undefined): readonly T[] | null | undefined;
export function useWordFixedSentences<T extends { text: string }>(sentences: readonly T[] | null | undefined): readonly T[] | null | undefined {
  const { fixes, apply } = useSyncExternalStore(subscribe, read, read);
  return useMemo(() => (sentences && fixes.length > 0 ? applyWordFixesToSentences(sentences, apply) : sentences), [sentences, fixes, apply]);
}

/** Test seam: the current list and its compiled form. */
export const snapshotForTest = (): Snapshot => snapshot;

/** Test seam: forgets the list and the owner. */
export function resetWordFixesForTest(): void {
  owner = null; pending = 0; chain = Promise.resolve(); publish(NO_WORD_FIXES);
}
