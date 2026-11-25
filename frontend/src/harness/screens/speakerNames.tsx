// Renaming a note's speakers (TC-2189) in the real shell over the fixture space: the Transcript before a rename,
// after it, and after Undo, for a Me/Them note, a diarized note and a meeting. Names in the call: the rename
// form of a Mac call recording offering the names the desktop app read from the call window. Who spoke when: a
// three-person call whose remote lines are named per person, each name suggested. And, in a build with suggested
// speaker names (VITE_SPEAKER_NAME_SUGGESTIONS), a voice note that has a name suggested for two of its speakers.
import { useEffect, useMemo } from "react";

import { __setSavedNoteStoreForTests } from "@/capture/library/savedNote/savedNoteStore";
import { speakerNameSuggestionsEnabled } from "@/lib/speakerNaming/namingFeature";
import { CALL_NAME_ROWS, CALL_SPEAKER_ROWS, NAMED_AND_SUGGESTED_ROWS, SPEAKER_ROWS, SUGGESTED_ROWS } from "../fixtures/library";
import { CaptureShell } from "./capture";
import type { HarnessScreen } from "../screen";

type Step = { rename: string; to: string } | { undo: true } | { open: string };

/** Drives the open note's Transcript the way a person would: tap the label, type, save, then optionally Undo. */
function Act(props: { steps: Step[] }) {
  useEffect(() => {
    let cancelled = false;
    const wait = async <T,>(find: () => T | null | undefined): Promise<T | null> => {
      for (let attempt = 0; attempt < 60 && !cancelled; attempt++) {
        const found = find();
        if (found) return found;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return null;
    };
    const visible = <E extends Element>(elements: Iterable<E>) => [...elements].find((element) => element.getClientRects().length > 0) ?? null;
    void (async () => {
      for (const step of props.steps) {
        if ("undo" in step) {
          const undo = await wait(() => document.querySelector<HTMLButtonElement>('[data-testid="speaker-rename-undo"]'));
          undo?.click();
          continue;
        }
        const name = "open" in step ? step.open : step.rename;
        const label = await wait(() => visible(document.querySelectorAll<HTMLButtonElement>(`[data-testid="speaker-label"][aria-label="Rename speaker ${name}"]`)));
        label?.click();
        const input = await wait(() => document.querySelector<HTMLInputElement>('[data-testid="speaker-rename-form"] input'));
        if (!input) return;
        if ("open" in step) continue;
        input.value = step.to;
        input.form?.requestSubmit();
        await wait(() => document.querySelector('[data-testid="speaker-rename-status"]'));
      }
    })();
    return () => { cancelled = true; };
  }, [props.steps]);
  return null;
}

const NOTE = { group: "speakerNames", layout: "pane", displayTitle: true, platform: "ios" } as const;
const note = (id: string) => `/chat/capture/library/${id}`;
const READ = '[data-testid="note-transcript"]:not(:has([role="status"])) [data-testid="speaker-label"]';
const RENAMED = '[data-testid="speaker-rename-status"]';
const shell = (steps: Step[] = []) => () => <CaptureShell library rows={SPEAKER_ROWS}><Act steps={steps} /></CaptureShell>;
const callShell = (steps: Step[] = []) => () => <CaptureShell library rows={CALL_NAME_ROWS}><Act steps={steps} /></CaptureShell>;
const callSpeakersShell = (steps: Step[] = []) => () => <CaptureShell library rows={CALL_SPEAKER_ROWS}><Act steps={steps} /></CaptureShell>;
/** Who spoke when: both remote people of the three-person call shown by name, each marked Suggested. */
const BOTH_SUGGESTED = '[data-testid="note-transcript"] [data-testid="speaker-label"][aria-label="Rename speaker Dana Lee"] ~ [data-testid="speaker-suggested"]';

const ME_THEM: Step[] = [{ rename: "Me", to: "Sam" }, { rename: "Them", to: "Alice, Bob" }];
const DIARIZED: Step[] = [{ rename: "Speaker A", to: "Dana (interviewer)" }];
const MEETING: Step[] = [{ rename: "Ana", to: "Ana Ruiz" }];

/** Presses the first element matching `selector` once it is there. */
function Press(props: { selector: string }) {
  useEffect(() => {
    let timer = 0;
    const attempt = (left: number) => {
      const target = document.querySelector<HTMLElement>(props.selector);
      if (target) target.click();
      else if (left > 0) timer = window.setTimeout(() => attempt(left - 1), 100);
    };
    attempt(60);
    return () => window.clearTimeout(timer);
  }, [props.selector]);
  return null;
}

/** The call with suggested names, as the saved voice note it opens as (its own notes are empty). */
function Suggested(props: { press?: string }) {
  useMemo(() => {
    __setSavedNoteStoreForTests({ load: async () => null, save: async (_id, md) => ({ record: { md, savedEditAt: null }, synced: Promise.resolve() }) });
  }, []);
  return <CaptureShell library rows={SUGGESTED_ROWS}>{props.press && <Press selector={props.press} />}</CaptureShell>;
}

const SUGGESTION = '[data-testid="speaker-suggestion"]';
const EVIDENCE = '[data-testid="speaker-suggestion-evidence"]';
/** The saved note as a desktop page, or as the phone's sheet; `scrollTo` brings a later part of the transcript into view. */
const suggested = (id: string, as: "page" | "sheet", readyWhen: string, options: { press?: string; scrollTo?: string } = {}): HarnessScreen => ({
  ...NOTE,
  id: `speakerNames-suggested-${as}${id}`,
  path: note("note-call-suggested"),
  platform: as === "page" ? "tauri" : "ios",
  viewports: as === "page" ? ["desktop-min", "desktop"] : ["phone"],
  readyWhen,
  scrollTo: options.scrollTo,
  render: () => <Suggested press={options.press} />,
});
/** A speaker's later turns: their labels are plain, the suggestion is at the first one only. */
const LATER_TURNS = '[data-testid="transcript-segment"]:last-of-type';
/** Registered only in a build that suggests names: without the flag the note shows nothing of them. */
const suggestedScreens: HarnessScreen[] = speakerNameSuggestionsEnabled() ? [
  suggested("", "page", SUGGESTION),
  suggested("-later", "page", SUGGESTION, { scrollTo: LATER_TURNS }),
  suggested("-evidence", "page", EVIDENCE, { press: '[data-testid="speaker-suggestion-name"]' }),
  suggested("-used", "page", RENAMED, { press: '[data-testid="speaker-suggestion-use"]' }),
  suggested("-menu", "page", 'details[open] [data-testid="note-suggest-names"]', { press: '[data-testid="note-transcript"] details > summary' }),
  suggested("", "sheet", SUGGESTION),
  suggested("-later", "sheet", SUGGESTION, { scrollTo: LATER_TURNS }),
  suggested("-evidence", "sheet", EVIDENCE, { press: '[data-testid="speaker-suggestion-name"]' }),
  // A name already taken from the call window keeps its Suggested mark, and the model's suggestion for that
  // label stays away: the two never show on one label.
  { ...NOTE, id: "speakerNames-suggested-call-named", path: note("call-one-named"),
    readyWhen: '[data-testid="note-transcript"]:not(:has([data-testid="speaker-suggestion"])) [data-testid="speaker-suggested"]',
    render: () => <CaptureShell library rows={NAMED_AND_SUGGESTED_ROWS} /> },
] : [];

export const speakerNameScreens: HarnessScreen[] = [
  { ...NOTE, id: "speakerNames-me-them-before", path: note("note-me-them"), readyWhen: READ, render: shell() },
  { ...NOTE, id: "speakerNames-me-them-after", path: note("note-me-them"), readyWhen: RENAMED, render: shell(ME_THEM) },
  { ...NOTE, id: "speakerNames-me-them-undo", path: note("note-me-them"), readyWhen: `${RENAMED}:not(:has([data-testid="speaker-rename-undo"]))`, render: shell([...ME_THEM, { undo: true }]) },
  { ...NOTE, id: "speakerNames-diarized-before", path: note("upload-interview"), readyWhen: READ, render: shell() },
  { ...NOTE, id: "speakerNames-diarized-after", path: note("upload-interview"), readyWhen: RENAMED, render: shell(DIARIZED) },
  { ...NOTE, id: "speakerNames-meeting-before", path: note("meeting-weekly"), readyWhen: READ, render: shell() },
  { ...NOTE, id: "speakerNames-meeting-after", path: note("meeting-weekly"), readyWhen: RENAMED, render: shell(MEETING) },
  { ...NOTE, id: "speakerNames-call-choices", path: note("call-group"), readyWhen: '[data-testid="speaker-choices"]', render: callShell([{ open: "Them" }]) },
  { ...NOTE, id: "speakerNames-call-suggested", path: note("call-one"), readyWhen: '[data-testid="speaker-suggested"]', render: callShell() },
  // Save with the suggested name unchanged keeps it: the mark goes, the name stays.
  { ...NOTE, id: "speakerNames-call-kept", path: note("call-one"),
    readyWhen: '[data-testid="note-transcript"] [data-testid="speaker-label"][aria-label="Rename speaker Alex Example"]:not(:has(~ [data-testid="speaker-suggested"]))',
    render: callShell([{ rename: "Alex Example", to: "Alex Example" }]) },
  // Who spoke when: a three-person call whose remote lines are Them 1 and Them 2, each with its suggested name.
  { ...NOTE, id: "speakerNames-call-speakers", path: note("call-three"), readyWhen: BOTH_SUGGESTED, render: callSpeakersShell() },
  { ...NOTE, id: "speakerNames-call-speakers-choices", path: note("call-three"), readyWhen: '[data-testid="speaker-choices"]',
    render: callSpeakersShell([{ open: "Alex Example" }]) },
  ...suggestedScreens,
];
