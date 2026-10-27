// Word fixes (TC-2199): the Settings list (empty, with entries, editing a pair) and a transcript before and after the
// list is applied. The list lives in a throwaway local space, never the real one.
import { useEffect, useMemo, type ReactNode } from "react";

import { WordFixesSettings } from "@/chat/WordFixesSettings";
import { NO_WORD_FIXES, withWordFix, type WordFixes } from "@/lib/wordFixes/wordFixes";
import { resetWordFixesForTest, saveWordFixes } from "@/lib/wordFixes/wordFixesStore";
import { useLocalThreadStorage } from "@/lib/threadStore";
import { combineSpace } from "../fixtures/combineSpace";
import { WORD_FIX_ROWS } from "../fixtures/wordFixes";
import { CaptureShell } from "./capture";
import type { HarnessScreen } from "../screen";

const LIST: WordFixes = [
  ["tiny cloud", "TinyCloud"], ["eliza", "Eliza"], ["open key", "OpenKey"], ["gee pee tee", "GPT"],
].reduce<WordFixes>((list, [find, replace]) => withWordFix(list, { find: find!, replace: replace! }), NO_WORD_FIXES);

function useSeededList(list: WordFixes) {
  const space = useMemo(() => {
    resetWordFixesForTest();
    const made = combineSpace([], { did: "did:test:word-fixes-harness" });
    useLocalThreadStorage(made.tcw);
    return made;
  }, []);
  useEffect(() => { void saveWordFixes(space.tcw, list); }, [space, list]);
  return space.tcw;
}

function Settings(props: { list: WordFixes; editFirst?: boolean }) {
  const tcw = useSeededList(props.list);
  useEffect(() => {
    if (!props.editFirst) return;
    const timer = setTimeout(() => document.querySelector<HTMLButtonElement>('[data-testid="word-fix"] button')?.click(), 150);
    return () => clearTimeout(timer);
  }, [props.editFirst]);
  return <div className="mx-auto w-full max-w-2xl p-4"><WordFixesSettings tcw={tcw} /></div>;
}

function Transcript(props: { list: WordFixes; children?: ReactNode }) {
  useSeededList(props.list);
  return <CaptureShell library rows={WORD_FIX_ROWS}>{props.children}</CaptureShell>;
}

const SETTINGS = { group: "wordFixes", layout: "pane", platform: "web" } as const;
const NOTE = { group: "wordFixes", layout: "pane", displayTitle: true, platform: "ios", path: "/chat/capture/library/note-word-fixes" } as const;
const READY = '[data-testid="note-transcript"] [data-testid="transcript-segment"]';

export const wordFixesScreens: HarnessScreen[] = [
  { ...SETTINGS, id: "wordFixes-settings-empty", readyWhen: '[data-testid="word-fixes-empty"]', render: () => <Settings list={NO_WORD_FIXES} /> },
  { ...SETTINGS, id: "wordFixes-settings-entries", readyWhen: '[data-testid="word-fix"]', render: () => <Settings list={LIST} /> },
  { ...SETTINGS, id: "wordFixes-settings-editing", readyWhen: '[data-testid="word-fix-edit"]', render: () => <Settings list={LIST} editFirst /> },
  { ...NOTE, id: "wordFixes-transcript-before", readyWhen: READY, render: () => <Transcript list={NO_WORD_FIXES} /> },
  { ...NOTE, id: "wordFixes-transcript-after", readyWhen: `${READY}:has(+ *), ${READY}`, render: () => <Transcript list={LIST} /> },
];
