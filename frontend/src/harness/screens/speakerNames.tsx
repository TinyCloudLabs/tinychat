// Renaming a note's speakers (TC-2189) in the real shell over the fixture space: the Transcript before a rename,
// after it, and after Undo, for a Me/Them note, a diarized note and a meeting. Names in the call: the rename
// form of a Mac call recording offering the names the desktop app read from the call window.
import { useEffect } from "react";

import { CALL_NAME_ROWS, SPEAKER_ROWS } from "../fixtures/library";
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

const ME_THEM: Step[] = [{ rename: "Me", to: "Sam" }, { rename: "Them", to: "Alice, Bob" }];
const DIARIZED: Step[] = [{ rename: "Speaker A", to: "Dana (interviewer)" }];
const MEETING: Step[] = [{ rename: "Ana", to: "Ana Ruiz" }];

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
];
